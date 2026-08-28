import { describe, expect, it } from "vitest";
import { UPSTREAM_MODEL_HEADER } from "../../open-sse/services/combo.js";
import {
  EXPOSE_HEADERS_HEADER,
  JSON_HEADERS_CORS,
  SSE_HEADERS_CORS,
  UPSTREAM_MODEL_HEADER_NAME
} from "../../open-sse/utils/sseConstants.js";
import { transformToOllama } from "../../open-sse/utils/ollamaTransform.js";

const exposeHeader = EXPOSE_HEADERS_HEADER;
const upstreamModelHeader = UPSTREAM_MODEL_HEADER_NAME;

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

  it("exposes upstream identity on client-facing SSE headers without changing existing headers", () => {
    expect(SSE_HEADERS_CORS["Content-Type"]).toBe("text/event-stream");
    expect(SSE_HEADERS_CORS["Cache-Control"]).toBe("no-cache");
    expect(SSE_HEADERS_CORS.Connection).toBe("keep-alive");
    expect(SSE_HEADERS_CORS["Access-Control-Allow-Origin"]).toBe("*");
    expect(SSE_HEADERS_CORS[exposeHeader]).toBe(upstreamModelHeader);
  });

  it("shares explicit exposed CORS headers for JSON responses", () => {
    expect(JSON_HEADERS_CORS["Content-Type"]).toBe("application/json");
    expect(JSON_HEADERS_CORS["Access-Control-Allow-Origin"]).toBe("*");
    expect(JSON_HEADERS_CORS[exposeHeader]).toBe(upstreamModelHeader);
    expect(JSON_HEADERS_CORS[exposeHeader]).not.toBe("*");
  });

  it("preserves upstream identity while converting streaming SSE to Ollama", async () => {
    const output = transformToOllama(sseResponse({ [UPSTREAM_MODEL_HEADER]: "kiro/glm-5" }), "llama3.2");

    expect(output.headers.get(UPSTREAM_MODEL_HEADER)).toBe("kiro/glm-5");
    expect(output.headers.get("content-type")).toBe("application/x-ndjson");
    expect(output.headers.get(exposeHeader)).toBe(upstreamModelHeader);
    expect(output.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(await output.text()).not.toBe("");
  });

  it("preserves upstream identity on a no-body Ollama response", () => {
    const output = transformToOllama(new Response(null, {
      status: 200,
      headers: {
        [UPSTREAM_MODEL_HEADER]: "kiro/glm-5",
        "content-type": "text/event-stream"
      }
    }), "llama3.2");

    expect(output.headers.get(UPSTREAM_MODEL_HEADER)).toBe("kiro/glm-5");
    expect(output.headers.get("content-type")).toBe("application/x-ndjson");
    expect(output.headers.get(exposeHeader)).toBe(upstreamModelHeader);
    expect(output.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("does not invent upstream identity when Ollama source response lacks it", () => {
    const output = transformToOllama(new Response(null, {
      status: 200,
      headers: { "content-type": "text/event-stream" }
    }), "llama3.2");

    expect(output.headers.get(UPSTREAM_MODEL_HEADER)).toBeNull();
    expect(output.headers.get(exposeHeader)).toBe(upstreamModelHeader);
  });
});
