import { describe, it, expect, beforeEach } from "vitest";

import {
  handleComboChat,
  resetComboRotation,
  UPSTREAM_MODEL_HEADER,
} from "../../open-sse/services/combo.js";

const log = { info: () => {}, warn: () => {}, error: () => {} };

function sseResponse(payload) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(body, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("combo upstream identity header", () => {
  beforeEach(() => {
    resetComboRotation();
  });

  it("#given a combo whose first member succeeds #when it responds #then the header names that member", async () => {
    const models = ["anthropic/claude-opus-5", "openai/gpt-5.6-sol"];

    const result = await handleComboChat({
      body: { model: "oracle", messages: [] },
      models,
      handleSingleModel: async () => jsonResponse({ ok: true }),
      log,
      comboName: "oracle",
      comboStrategy: "fallback",
    });

    expect(result.headers.get(UPSTREAM_MODEL_HEADER)).toBe("anthropic/claude-opus-5");
  });

  it("#given the first member is exhausted #when the combo falls back #then the header names the member that actually served", async () => {
    // This is the case the whole feature exists for: the client must not be told
    // "anthropic" when a token budget ran out and OpenAI actually answered.
    const models = ["anthropic/claude-opus-5", "openai/gpt-5.6-sol"];
    const attempted = [];

    const result = await handleComboChat({
      body: { model: "oracle", messages: [] },
      models,
      handleSingleModel: async (_body, modelStr) => {
        attempted.push(modelStr);
        if (modelStr === "anthropic/claude-opus-5") {
          return jsonResponse({ error: { message: "rate limit exceeded" } }, 429);
        }
        return jsonResponse({ ok: true });
      },
      log,
      comboName: "oracle",
      comboStrategy: "fallback",
    });

    expect(attempted).toEqual(["anthropic/claude-opus-5", "openai/gpt-5.6-sol"]);
    expect(result.headers.get(UPSTREAM_MODEL_HEADER)).toBe("openai/gpt-5.6-sol");
  });

  it("#given a streaming member #when the header is attached #then the stream body and existing headers survive", async () => {
    const result = await handleComboChat({
      body: { model: "oracle", messages: [], stream: true },
      models: ["anthropic/claude-opus-5"],
      handleSingleModel: async () => sseResponse({ choices: [{ delta: { content: "hi" } }] }),
      log,
      comboName: "oracle",
      comboStrategy: "fallback",
    });

    expect(result.headers.get(UPSTREAM_MODEL_HEADER)).toBe("anthropic/claude-opus-5");
    expect(result.headers.get("content-type")).toBe("text/event-stream");
    expect(result.headers.get("cache-control")).toBe("no-cache");

    const text = await result.text();
    expect(text).toContain('"content":"hi"');
    expect(text).toContain("[DONE]");
  });

  it("#given every member fails #when the combo gives up #then no member is claimed", async () => {
    // Nothing served the request, so naming a model would be a lie. The absent
    // header is the signal to fall back to whatever default the client uses.
    const result = await handleComboChat({
      body: { model: "oracle", messages: [] },
      models: ["anthropic/claude-opus-5", "openai/gpt-5.6-sol"],
      handleSingleModel: async () => jsonResponse({ error: { message: "rate limit exceeded" } }, 429),
      log,
      comboName: "oracle",
      comboStrategy: "fallback",
    });

    expect(result.ok).toBe(false);
    expect(result.headers.get(UPSTREAM_MODEL_HEADER)).toBeNull();
  });

  it("#given a later member serves after several failures #when it responds #then only the serving member is named", async () => {
    // checkFallbackError has a catch-all returning shouldFallback:true, so every
    // failure walks the list. Whichever member finally answers is the one named -
    // the header must never accumulate or report an earlier attempt.
    const result = await handleComboChat({
      body: { model: "oracle", messages: [] },
      models: ["anthropic/claude-opus-5", "openai/gpt-5.6-sol", "glm/glm-5.2"],
      handleSingleModel: async (_body, modelStr) =>
        modelStr === "glm/glm-5.2"
          ? jsonResponse({ ok: true })
          : jsonResponse({ error: { message: "quota exceeded" } }, 429),
      log,
      comboName: "oracle",
      comboStrategy: "fallback",
    });

    expect(result.ok).toBe(true);
    expect(result.headers.get(UPSTREAM_MODEL_HEADER)).toBe("glm/glm-5.2");
  });
});
