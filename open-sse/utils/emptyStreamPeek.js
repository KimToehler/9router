// Detect 200-OK SSE responses that carry no assistant content.
//
// Upstream providers occasionally accept a request, open the stream, emit framing
// (message_start / role delta) and then close without ever producing a content
// block. HTTP status stays 2xx, so a status-only success check (combo.js) treats
// it as a win and never falls through to the next model. Downstream the client
// receives a well-formed but empty stream and parks the lane forever.
//
// This peeks the stream prefix for the first content-bearing event, then hands
// back a re-assembled body so the already-read bytes are not lost. Mirrors the
// approach proven in executors/codex.js (_peekSseTransientError), generalized
// across formats and keyed on "produced content" rather than known error strings.

import { dbg } from "./debugLog.js";

// Event types that carry assistant output, keyed by the discriminator each format
// puts on the frame. Matched against parsed JSON rather than raw text: substring
// checks cannot tell `"tool_calls":[]` from a real call, nor `"finish_reason":"stop"`
// on an empty turn from actual content.
const CONTENT_EVENT_TYPES = new Set([
  "content_block_delta",
  "content_block_start",
  "response.output_text.delta",
  "response.function_call_arguments.delta",
  "response.reasoning_summary_text.delta",
]);

// An upstream error delivered inside a 200 body is also "not empty" for our
// purposes: the existing error paths already classify and act on those, and we
// must not swallow them here.
const SSE_ERROR_PATTERNS = ['"type":"error"', "event: error"];

// Cap the prefix we buffer. Content always appears in the first frames, so this
// only bounds memory for pathological upstreams.
const PEEK_MAX_BYTES = 64 * 1024;

const nonEmptyString = (v) => typeof v === "string" && v.length > 0;

// Consume whole SSE frames from the buffer, returning a verdict and the unparsed
// remainder. Partial trailing frames are kept so a payload split across chunks is
// classified once complete rather than being misread.
function scanFrames(buffer) {
  let rest = buffer;
  let verdict = null;
  let idx;
  while ((idx = rest.indexOf("\n")) !== -1) {
    const line = rest.slice(0, idx).trim();
    rest = rest.slice(idx + 1);
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let frame;
    try {
      frame = JSON.parse(payload);
    } catch {
      continue;
    }
    if (frame?.type === "error" || frame?.error) {
      verdict = "upstream-error";
      break;
    }
    if (frameHasContent(frame)) {
      verdict = "content";
      break;
    }
  }
  return { verdict, rest };
}

// True when a parsed SSE frame carries assistant output. Empty containers
// (`tool_calls: []`, a zero-length text delta) and terminal-only frames such as
// `finish_reason: "stop"` are deliberately NOT content: an upstream that emits
// only those produced nothing, which is exactly the failure being detected.
function frameHasContent(frame) {
  if (!frame || typeof frame !== "object") return false;

  if (CONTENT_EVENT_TYPES.has(frame.type)) return true;

  const choice = Array.isArray(frame.choices) ? frame.choices[0] : null;
  const delta = choice?.delta ?? choice?.message;
  if (delta) {
    if (nonEmptyString(delta.content)) return true;
    if (nonEmptyString(delta.reasoning_content)) return true;
    if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) return true;
    if (Array.isArray(delta.content) && delta.content.length > 0) return true;
  }
  if (nonEmptyString(choice?.text)) return true;

  const parts = frame.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) {
    return parts.some((p) => nonEmptyString(p?.text) || p?.functionCall || p?.inlineData);
  }

  return false;
}

// Response headers are withheld until the peek resolves, so this also caps how
// long a slow-prefill model can delay the client's first byte. On expiry the
// stream is passed through untouched rather than failed, so the only cost of a
// low value is losing detection on an unusually slow upstream.
const PEEK_TIMEOUT_MS = 20000;

// Marker text carried on the synthesized 503 so the combo layer can tell an
// empty-stream failure apart from a genuine upstream 503.
export const EMPTY_STREAM_MESSAGE = "Upstream returned an empty stream (200 OK, no content)";

/**
 * Peek an SSE response for content-bearing events.
 *
 * Resolution is deliberately biased toward the status quo: anything we cannot
 * classify with confidence (non-SSE, unreadable, timed out) reports hasContent
 * true so the caller streams it exactly as it does today.
 *
 * @param {Response} response
 * @param {object} [options]
 * @param {number} [options.timeoutMs] Abort the peek and pass through unchanged.
 * @returns {Promise<{hasContent: boolean, replacementBody: ReadableStream|null, reason: string}>}
 */
export async function peekStreamForContent(response, { timeoutMs = PEEK_TIMEOUT_MS } = {}) {
  const passthrough = (reason) => ({ hasContent: true, replacementBody: null, reason });

  if (!response || !response.ok || !response.body) return passthrough("no-body");

  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  if (!contentType.includes("text/event-stream")) return passthrough("not-sse");

  if (response.body.locked) return passthrough("body-locked");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  let text = "";
  let bufferedBytes = 0;
  let hasContent = false;
  let reason = "empty";
  let timedOut = false;
  let pendingRead = null;

  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => { timedOut = true; resolve({ timeout: true }); }, timeoutMs);
  });

  try {
    while (bufferedBytes < PEEK_MAX_BYTES) {
      // Promise.race abandons the losing read but cannot dequeue it, so a timed-out
      // read stays queued and would swallow the next chunk. Keep the promise and let
      // the replacement stream consume it first.
      pendingRead = reader.read();
      const next = await Promise.race([pendingRead, timeout]);
      if (next?.timeout) {
        hasContent = true;
        reason = "peek-timeout";
        break;
      }
      pendingRead = null;

      const { done, value } = next;
      if (done) break;

      chunks.push(value);
      bufferedBytes += value.byteLength ?? value.length ?? 0;
      text += decoder.decode(value, { stream: true });

      const scan = scanFrames(text);
      text = scan.rest;
      if (scan.verdict) {
        hasContent = true;
        reason = scan.verdict;
        break;
      }
    }
    if (!hasContent && bufferedBytes >= PEEK_MAX_BYTES) {
      // Buffered the cap without seeing content. Do not starve the client.
      hasContent = true;
      reason = "peek-cap";
    }
  } catch (e) {
    dbg("EMPTYPEEK", `read error: ${e.message}`);
    hasContent = true;
    reason = "peek-error";
  } finally {
    if (timer) clearTimeout(timer);
  }

  // Empty and fully drained: nothing left to forward, so no replacement needed.
  if (!hasContent) {
    Promise.resolve(reader.cancel()).catch(() => { /* noop */ });
    try { reader.releaseLock(); } catch { /* noop */ }
    return { hasContent: false, replacementBody: null, reason };
  }

  // A timed-out peek leaves a read in flight; the lock cannot be handed back
  // safely, so keep draining through the reader we already own.
  const upstream = timedOut ? null : response.body;
  if (!timedOut) {
    try { reader.releaseLock(); } catch { /* noop */ }
  }

  let upstreamReader = timedOut ? reader : null;
  let carriedRead = pendingRead;
  const replacementBody = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      if (!upstreamReader) upstreamReader = upstream.getReader();
    },
    async pull(controller) {
      try {
        const inflight = carriedRead;
        carriedRead = null;
        const { done, value } = await (inflight ?? upstreamReader.read());
        if (done) { controller.close(); return; }
        controller.enqueue(value);
      } catch (e) {
        controller.error(e);
      }
    },
    cancel(r) {
      return Promise.resolve(upstreamReader?.cancel(r)).catch(() => { /* noop */ });
    },
  });

  return { hasContent: true, replacementBody, reason };
}

/**
 * Rebuild a Response around a peeked body, preserving status and headers.
 * @param {Response} response
 * @param {ReadableStream|null} replacementBody
 * @returns {Response}
 */
export function withPeekedBody(response, replacementBody) {
  if (!replacementBody) return response;
  return new Response(replacementBody, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
