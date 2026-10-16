// A request without `stream` asks for a JSON response: that is the default of
// the OpenAI Chat Completions and Anthropic Messages APIs. Streaming must be
// requested explicitly, except on Ollama's /api/chat, whose route defaults it.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { executeMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
}));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({ noAuth: true, execute: executeMock }),
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(),
    logConvertedResponse: vi.fn(),
    logError: vi.fn(),
  }),
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");

const claudeBody = (extra = {}) => ({
  model: "claude-sonnet-4-6",
  max_tokens: 16,
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  ...extra,
});

const openaiBody = (extra = {}) => ({
  model: "deepseek-chat",
  messages: [{ role: "user", content: "hello" }],
  ...extra,
});

async function run({ endpoint, body, headers = {} }) {
  const isClaude = endpoint === "/v1/messages";
  const result = await handleChatCore({
    body,
    modelInfo: { provider: "deepseek", model: "deepseek-chat" },
    credentials: { apiKey: "test-key", providerSpecificData: {} },
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    connectionId: "test-conn",
    sourceFormatOverride: isClaude ? "claude" : null,
    clientRawRequest: { endpoint, body, headers },
  });
  expect(executeMock).toHaveBeenCalledTimes(1);
  return { upstreamStream: executeMock.mock.calls[0][0].stream, result };
}

describe("client stream default", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executeMock.mockResolvedValue({
      response: new Response(JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion",
        model: "deepseek-chat",
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop", index: 0 }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), { status: 200, headers: { "content-type": "application/json" } }),
      url: "https://api.deepseek.com/chat/completions",
      headers: {},
      transformedBody: null,
    });
  });

  it.each([
    ["Anthropic /v1/messages", "/v1/messages", claudeBody()],
    ["OpenAI /v1/chat/completions", "/v1/chat/completions", openaiBody()],
  ])("%s without stream answers with JSON", async (_label, endpoint, body) => {
    const { upstreamStream, result } = await run({ endpoint, body });

    expect(upstreamStream).toBe(false);
    expect(result.response.headers.get("content-type")).toContain("application/json");
  });

  it.each([
    ["Anthropic /v1/messages", "/v1/messages", claudeBody({ stream: true })],
    ["OpenAI /v1/chat/completions", "/v1/chat/completions", openaiBody({ stream: true })],
  ])("%s with stream:true streams", async (_label, endpoint, body) => {
    const { upstreamStream } = await run({ endpoint, body });

    expect(upstreamStream).toBe(true);
  });

  it("an SSE Accept header without stream does not wrap a JSON reply in SSE", async () => {
    const { upstreamStream, result } = await run({
      endpoint: "/v1/messages",
      body: claudeBody(),
      headers: { accept: "text/event-stream" },
    });

    expect(upstreamStream).toBe(false);
    expect(result.response.headers.get("content-type")).toContain("application/json");
  });
});

describe("Ollama /api/chat stream default", () => {
  const handleChatMock = vi.fn(async () => new Response("", { headers: { "content-type": "text/event-stream" } }));

  async function forwardedStream(body) {
    vi.resetModules();
    vi.doMock("@/sse/handlers/chat.js", () => ({ handleChat: handleChatMock }));
    vi.doMock("open-sse/translator/index.js", () => ({ initTranslators: vi.fn(async () => {}) }));
    const { POST } = await import("../../src/app/api/v1/api/chat/route.js");
    handleChatMock.mockClear();
    await POST(new Request("http://localhost/api/v1/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }));
    const forwarded = handleChatMock.mock.calls[0][0];
    return (await forwarded.json()).stream;
  }

  it("streams when the client omits stream, as Ollama does", async () => {
    expect(await forwardedStream(openaiBody())).toBe(true);
  });

  it("keeps an explicit stream:false", async () => {
    expect(await forwardedStream(openaiBody({ stream: false }))).toBe(false);
  });
});
