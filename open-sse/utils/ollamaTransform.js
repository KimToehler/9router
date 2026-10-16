import { EXPOSE_HEADERS_HEADER, UPSTREAM_MODEL_HEADER_NAME } from "./sseConstants.js";

const encoder = new TextEncoder();

function parseArguments(args) {
  if (args && typeof args === "object") return args;
  try { return JSON.parse(args || "{}"); } catch { return {}; }
}

function toOllamaToolCalls(toolCalls) {
  return toolCalls.map((tc) => ({
    function: { name: tc.function?.name || "", arguments: parseArguments(tc.function?.arguments) },
  }));
}

// Final Ollama chunk: done:true plus the reason and token counts, if known.
function finalMessage(model, { content = "", toolCalls = null, finishReason = null, usage = null } = {}) {
  return {
    model,
    message: { role: "assistant", content, ...(toolCalls?.length ? { tool_calls: toOllamaToolCalls(toolCalls) } : {}) },
    done: true,
    ...(finishReason ? { done_reason: finishReason } : {}),
    ...(usage ? { prompt_eval_count: usage.prompt_tokens || 0, eval_count: usage.completion_tokens || 0 } : {}),
  };
}

function errorMessage(body) {
  const err = body?.error;
  if (typeof err === "string") return err;
  return err?.message || body?.message || "Request failed";
}

// Non-streaming chat completion (or error) → a single Ollama JSON object.
async function jsonToOllama(response, model, headers) {
  const body = await response.json().catch(() => null);
  if (!response.ok || !Array.isArray(body?.choices)) {
    return new Response(JSON.stringify({ error: errorMessage(body) }), {
      status: response.ok ? 502 : response.status,
      headers: { ...headers, "Content-Type": "application/json" },
    });
  }
  const choice = body.choices[0] || {};
  const message = finalMessage(model, {
    content: choice.message?.content || "",
    toolCalls: choice.message?.tool_calls,
    finishReason: choice.finish_reason,
    usage: body.usage,
  });
  return new Response(JSON.stringify(message), {
    status: response.status,
    headers: { ...headers, "Content-Type": "application/json" },
  });
}

// OpenAI SSE stream → Ollama NDJSON lines, ending with exactly one done:true line.
function sseToOllama(response, model, headers) {
  const decoder = new TextDecoder();
  let buffer = "";
  let pendingToolCalls = {};
  let finishReason = null;
  let usage = null;
  let doneSent = false;

  const emitDone = (controller) => {
    if (doneSent) return;
    doneSent = true;
    const toolCalls = Object.values(pendingToolCalls);
    controller.enqueue(encoder.encode(JSON.stringify(finalMessage(model, { toolCalls, finishReason, usage })) + "\n"));
  };

  const handleLine = (line, controller) => {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data) return;
    if (data === "[DONE]") {
      emitDone(controller);
      return;
    }
    let parsed;
    try { parsed = JSON.parse(data); } catch { return; }

    if (parsed.usage) usage = parsed.usage;
    const choice = parsed.choices?.[0];
    if (!choice) return;
    const delta = choice.delta || {};

    for (const tc of delta.tool_calls || []) {
      const slot = pendingToolCalls[tc.index] ||= { function: { name: "", arguments: "" } };
      if (tc.function?.name) slot.function.name += tc.function.name;
      if (tc.function?.arguments) slot.function.arguments += tc.function.arguments;
    }
    if (delta.content) {
      controller.enqueue(encoder.encode(JSON.stringify({ model, message: { role: "assistant", content: delta.content }, done: false }) + "\n"));
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
  };

  const transform = new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) handleLine(line, controller);
    },
    flush(controller) {
      buffer += decoder.decode();
      if (buffer) handleLine(buffer, controller);
      emitDone(controller);
    },
  });

  return new Response(response.body.pipeThrough(transform), {
    status: response.status,
    headers: { ...headers, "Content-Type": "application/x-ndjson" },
  });
}

// Transform a /v1/chat/completions response into Ollama /api/chat format:
// SSE streams become NDJSON, JSON bodies (stream:false or errors) one object.
export async function transformToOllama(response, model) {
  const headers = {
    "Content-Type": "application/x-ndjson",
    "Access-Control-Allow-Origin": "*",
    [EXPOSE_HEADERS_HEADER]: UPSTREAM_MODEL_HEADER_NAME
  };
  const upstreamModel = response.headers.get(UPSTREAM_MODEL_HEADER_NAME);
  if (upstreamModel) headers[UPSTREAM_MODEL_HEADER_NAME] = upstreamModel;

  if (!response.body) {
    const body = [204, 205, 304].includes(response.status) ? null : "";
    return new Response(body, { status: response.status, headers });
  }
  if (!(response.headers.get("content-type") || "").includes("text/event-stream")) {
    return jsonToOllama(response, model, headers);
  }
  return sseToOllama(response, model, headers);
}
