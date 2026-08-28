import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(),
  saveRequestDetail: vi.fn(() => Promise.resolve()),
}));

import { UPSTREAM_MODEL_HEADER } from "../../open-sse/services/combo.js";
import { EXPOSE_HEADERS_HEADER, UPSTREAM_MODEL_HEADER_NAME } from "../../open-sse/utils/sseConstants.js";
import { handleNonStreamingResponse } from "../../open-sse/handlers/chatCore/nonStreamingHandler.js";
import { handleForcedSSEToJson } from "../../open-sse/handlers/chatCore/sseToJsonHandler.js";
import { handleStreamingResponse } from "../../open-sse/handlers/chatCore/streamingHandler.js";
import { transformToOllama } from "../../open-sse/utils/ollamaTransform.js";

const exposeHeader = EXPOSE_HEADERS_HEADER;
const upstreamModelHeader = UPSTREAM_MODEL_HEADER_NAME;

function handlerOptions(overrides = {}) {
  return {
    provider: "openai",
    model: "gpt-4o-mini",
    sourceFormat: "openai",
    targetFormat: "openai",
    body: { model: "gpt-4o-mini", messages: [] },
    stream: false,
    requestStartTime: Date.now(),
    connectionId: "test",
    apiKey: "test-key",
    clientRawRequest: {},
    trackDone: vi.fn(),
    appendLog: vi.fn(),
    reqLogger: { logProviderResponse: vi.fn(), logConvertedResponse: vi.fn() },
    streamController: { handleError: vi.fn() },
    ...overrides,
  };
}

function expectCorsHeaders(response, contentType) {
  expect(response.headers.get("Content-Type")).toBe(contentType);
  expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  expect(response.headers.get(exposeHeader)).toBe(upstreamModelHeader);
}

function sseResponse(headers = {}) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    }
  });

  return new Response(body, {
    headers: {
      "content-type": "text/event-stream",
      ...headers
    }
  });
}

describe("upstream model CORS headers", () => {
  it("keeps shared upstream model header name in sync with combo", () => {
    expect(UPSTREAM_MODEL_HEADER_NAME).toBe(UPSTREAM_MODEL_HEADER);
  });

  it("returns exposed CORS headers from non-streaming handler", async () => {
    const result = await handleNonStreamingResponse(handlerOptions({
      providerResponse: new Response(JSON.stringify({ choices: [], usage: {} }), {
        headers: { "content-type": "application/json" },
      }),
    }));

    expectCorsHeaders(result.response, "application/json");
  });

  it("returns exposed CORS headers from forced SSE-to-JSON handler", async () => {
    const result = await handleForcedSSEToJson(handlerOptions({
      providerResponse: sseResponse(),
    }));

    expectCorsHeaders(result.response, "application/json");
  });

  it("returns exposed CORS headers from streaming handler", async () => {
    const result = await handleStreamingResponse(handlerOptions({
      providerResponse: sseResponse(),
      stream: true,
      streamDetailId: "test-stream-detail",
    }));

    expectCorsHeaders(result.response, "text/event-stream");
  });

  it("preserves upstream identity while converting streaming SSE to Ollama", async () => {
    const output = transformToOllama(sseResponse({ [UPSTREAM_MODEL_HEADER]: "kiro/glm-5" }), "llama3.2");

    expect(output.headers.get(UPSTREAM_MODEL_HEADER)).toBe("kiro/glm-5");
    expect(output.headers.get("content-type")).toBe("application/x-ndjson");
    expect(output.headers.get(exposeHeader)).toBe(upstreamModelHeader);
    expect(output.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(await output.text()).not.toBe("");
  });

  it.each([204, 304])("preserves headers for no-body Ollama status %i", (status) => {
    const output = transformToOllama(new Response(null, {
      status,
      headers: {
        [UPSTREAM_MODEL_HEADER]: "kiro/glm-5",
        "content-type": "text/event-stream"
      }
    }), "llama3.2");

    expect(output.status).toBe(status);
    expect(output.headers.get(UPSTREAM_MODEL_HEADER)).toBe("kiro/glm-5");
    expect(output.headers.get("content-type")).toBe("application/x-ndjson");
    expect(output.headers.get(exposeHeader)).toBe(upstreamModelHeader);
    expect(output.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it.each([204, 205, 304])("does not invent upstream identity for no-body Ollama status %i", (status) => {
    const output = transformToOllama(new Response(null, {
      status,
      headers: { "content-type": "text/event-stream" }
    }), "llama3.2");

    expect(output.status).toBe(status);
    expect(output.headers.get(UPSTREAM_MODEL_HEADER)).toBeNull();
    expect(output.headers.get(exposeHeader)).toBe(upstreamModelHeader);
    expect(output.headers.get("content-type")).toBe("application/x-ndjson");
    expect(output.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});
