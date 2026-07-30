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

// First content-bearing SSE event per format. Presence of any one of these means
// the upstream actually produced output, so the response must stream unchanged.
const SSE_CONTENT_PATTERNS = [
  // Claude messages
  '"type":"content_block_delta"',
  '"type":"content_block_start"',
  // OpenAI chat completions
  '"delta":{"content"',
  '"delta": {"content"',
  '"tool_calls"',
  '"finish_reason":"',
  // OpenAI Responses API
  '"type":"response.output_text.delta"',
  '"type":"response.function_call_arguments.delta"',
  "event: response.output_text.delta",
  "event: response.function_call_arguments.delta",
  // Gemini / Antigravity
  '"text":',
  '"functionCall"',
];

// An upstream error delivered inside a 200 body is also "not empty" for our
// purposes: the existing error paths already classify and act on those, and we
// must not swallow them here.
const SSE_ERROR_PATTERNS = ['"type":"error"', "event: error"];

// Cap the prefix we buffer. Content always appears in the first frames, so this
// only bounds memory for pathological upstreams.
const PEEK_MAX_BYTES = 64 * 1024;

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
export async function peekStreamForContent(response, { timeoutMs = 120000 } = {}) {
  const passthrough = (reason) => ({ hasContent: true, replacementBody: null, reason });

  if (!response || !response.ok || !response.body) return passthrough("no-body");

  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  if (!contentType.includes("text/event-stream")) return passthrough("not-sse");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  let text = "";
  let hasContent = false;
  let reason = "empty";
  let timedOut = false;

  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => { timedOut = true; resolve({ timeout: true }); }, timeoutMs);
  });

  try {
    while (text.length < PEEK_MAX_BYTES) {
      const next = await Promise.race([reader.read(), timeout]);
      if (next?.timeout) {
        hasContent = true;
        reason = "peek-timeout";
        break;
      }
      const { done, value } = next;
      if (done) break;

      chunks.push(value);
      text += decoder.decode(value, { stream: true });

      if (SSE_ERROR_PATTERNS.some((p) => text.includes(p))) {
        hasContent = true;
        reason = "upstream-error";
        break;
      }
      if (SSE_CONTENT_PATTERNS.some((p) => text.includes(p))) {
        hasContent = true;
        reason = "content";
        break;
      }
    }
    if (!hasContent && text.length >= PEEK_MAX_BYTES) {
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
    try { reader.cancel(); } catch { /* noop */ }
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
  const replacementBody = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      if (!upstreamReader) upstreamReader = upstream.getReader();
    },
    async pull(controller) {
      try {
        const { done, value } = await upstreamReader.read();
        if (done) { controller.close(); return; }
        controller.enqueue(value);
      } catch (e) {
        controller.error(e);
      }
    },
    cancel(r) {
      try { upstreamReader?.cancel(r); } catch { /* noop */ }
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
