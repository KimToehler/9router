import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  handleComboChat,
  resetComboRotation,
  UPSTREAM_MODEL_HEADER,
  withUpstreamModel,
} from "../../open-sse/services/combo.js";
import { EMPTY_STREAM_MESSAGE } from "../../open-sse/utils/emptyStreamPeek.js";

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

const originalDataDir = process.env.DATA_DIR;

async function setupModelInfo() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-upstream-identity-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();

  const { createProviderNode } = await import("@/models/index.js");
  const { getModelInfo } = await import("@/sse/services/model.js");
  return {
    createProviderNode,
    getModelInfo,
    cleanup() {
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
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

  it("#given the inner leaf already stamped #when an outer combo wraps it #then the inner value survives", async () => {
    const result = await handleComboChat({
      body: { model: "outer", messages: [] },
      models: ["outer-member"],
      handleSingleModel: async () => new Response("ok", { headers: { [UPSTREAM_MODEL_HEADER]: "kiro/glm-5" } }),
      log,
      comboName: "outer",
      comboStrategy: "fallback",
    });

    expect(result.headers.get(UPSTREAM_MODEL_HEADER)).toBe("kiro/glm-5");
    expect(result.headers.get(UPSTREAM_MODEL_HEADER)).not.toBe("outer-member");
  });

  it("#given a nested combo member #when it serves #then the header names the leaf, never the nested combo name", async () => {
    const result = await handleComboChat({
      body: { model: "outer", messages: [] },
      models: ["fast-tier"],
      handleSingleModel: async () => new Response("ok", { headers: { [UPSTREAM_MODEL_HEADER]: "kr/glm-5" } }),
      log,
      comboName: "outer",
      comboStrategy: "fallback",
    });

    expect(result.headers.get(UPSTREAM_MODEL_HEADER)).toBe("kr/glm-5");
    expect(result.headers.get(UPSTREAM_MODEL_HEADER)).not.toBe("fast-tier");
  });

  it("#given an unstamped inner response #when the combo wraps it #then the member is stamped", async () => {
    const result = await handleComboChat({
      body: { model: "oracle", messages: [] },
      models: ["anthropic/claude-opus-5"],
      handleSingleModel: async () => jsonResponse({ ok: true }),
      log,
      comboName: "oracle",
      comboStrategy: "fallback",
    });

    expect(result.headers.get(UPSTREAM_MODEL_HEADER)).toBe("anthropic/claude-opus-5");
  });

  it("#given a failed first candidate that stamped itself #when a later candidate succeeds #then only the winner is named", async () => {
    const result = await handleComboChat({
      body: { model: "oracle", messages: [] },
      models: ["anthropic/claude-opus-5", "openai/gpt-5.6-sol"],
      handleSingleModel: async (_body, modelStr) => modelStr === "anthropic/claude-opus-5"
        ? new Response("rate limited", { status: 429, headers: { [UPSTREAM_MODEL_HEADER]: modelStr } })
        : jsonResponse({ ok: true }),
      log,
      comboName: "oracle",
      comboStrategy: "fallback",
    });

    expect(result.headers.get(UPSTREAM_MODEL_HEADER)).toBe("openai/gpt-5.6-sol");
  });

  it("#given an empty-stream retry that succeeds #when it responds #then the retried model is named exactly once", async () => {
    let calls = 0;
    const modelStr = "openai/gpt-5.6-sol";
    const result = await handleComboChat({
      body: { model: "oracle", messages: [] },
      models: [modelStr],
      handleSingleModel: async () => {
        calls += 1;
        return calls === 1
          ? jsonResponse({ error: { message: EMPTY_STREAM_MESSAGE } }, 503)
          : jsonResponse({ ok: true });
      },
      log,
      comboName: "oracle",
      comboStrategy: "fallback",
    });

    expect(result.headers.get(UPSTREAM_MODEL_HEADER)).toBe(modelStr);
    expect([...result.headers].filter(([key]) => key.toLowerCase() === UPSTREAM_MODEL_HEADER.toLowerCase()).length).toBe(1);
  });

  it("#given a streaming response #when N wrappers run #then the body is delivered intact and unlocked", async () => {
    const result = withUpstreamModel(withUpstreamModel(sseResponse({ choices: [{ delta: { content: "hi" } }] }), "leaf/model"), "outer-combo");

    expect(result.body.locked).toBe(false);
    expect(result.headers.get("content-type")).toBe("text/event-stream");
    expect(await result.text()).toContain("[DONE]");
  });

  it("#given a response already stamped #when withUpstreamModel runs #then the same object is returned", () => {
    const response = new Response("ok", { headers: { [UPSTREAM_MODEL_HEADER]: "kiro/glm-5" } });

    expect(withUpstreamModel(response, "x/y")).toBe(response);
  });

  it("#given an absent upstream id #when stamping is attempted #then it returns the original unstamped response", () => {
    for (const modelId of [undefined, null, ""]) {
      const response = new Response("ok", { status: 201 });
      const result = withUpstreamModel(response, modelId);

      expect(result).toBe(response);
      expect(result.status).toBe(201);
      expect(result.headers.get(UPSTREAM_MODEL_HEADER)).toBeNull();
    }
  });

  it("#given a 204 response #when stamping is attempted #then the original is returned rather than throwing", () => {
    const response = new Response(null, { status: 204 });

    expect(() => withUpstreamModel(response, "x/y")).not.toThrow();
    expect(withUpstreamModel(response, "x/y").status).toBe(204);
  });
});

describe("client-facing upstream identity", () => {
  let cleanup = () => {};

  afterEach(() => {
    cleanup();
    cleanup = () => {};
    vi.doUnmock("@/sse/services/auth.js");
    vi.doUnmock("@/lib/localDb");
    vi.doUnmock("@/sse/services/model.js");
    vi.doUnmock("open-sse/handlers/chatCore.js");
    vi.resetModules();
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  it("#given registry aliases #when model info resolves #then display ids match advertised aliases", async () => {
    const ctx = await setupModelInfo();
    cleanup = ctx.cleanup;

    const cc = await ctx.getModelInfo("cc/claude-opus-4-7");
    expect(cc).toMatchObject({ provider: "claude", model: "claude-opus-4-7" });
    expect(cc.clientModelId).toBe("cc/claude-opus-4-7");

    const kr = await ctx.getModelInfo("kr/glm-5");
    expect(kr).toMatchObject({ provider: "kiro", model: "glm-5" });
    expect(kr.clientModelId).toBe("kr/glm-5");

    const anthropic = await ctx.getModelInfo("anthropic/claude-opus-5");
    expect(anthropic).toMatchObject({ provider: "anthropic", model: "claude-opus-5" });
    expect(anthropic.clientModelId).toBe("anthropic/claude-opus-5");

    await expect(ctx.getModelInfo("ds/deepseek-v4-pro")).resolves.toMatchObject({
      provider: "deepseek",
      model: "deepseek-v4-pro",
      clientModelId: "ds/deepseek-v4-pro",
    });
    await expect(ctx.getModelInfo("pplx/sonar")).resolves.toMatchObject({
      provider: "perplexity",
      model: "sonar",
      clientModelId: "pplx/sonar",
    });
    await expect(ctx.getModelInfo("cf/some-model")).resolves.toMatchObject({
      provider: "cloudflare-ai",
      model: "some-model",
      clientModelId: "cf/some-model",
    });
  });

  it("#given model aliases #when model info resolves #then registry display aliases survive string and object forms", async () => {
    vi.resetModules();
    vi.doMock("@/lib/localDb", () => ({
      getModelAliases: vi.fn(async () => ({
        fast: "ds/deepseek-chat",
        smart: { provider: "pplx", model: "sonar" },
      })),
      getComboByName: vi.fn(async () => null),
      getProviderNodes: vi.fn(async () => []),
    }));
    const { getModelInfo } = await import("@/sse/services/model.js");

    await expect(getModelInfo("fast")).resolves.toMatchObject({
      provider: "deepseek",
      model: "deepseek-chat",
      clientModelId: "ds/deepseek-chat",
    });
    await expect(getModelInfo("smart")).resolves.toMatchObject({
      provider: "perplexity",
      model: "sonar",
      clientModelId: "pplx/sonar",
    });
  });

  it("#given connection prefix variants #when upstream id resolves #then uses prefix or safe client label", async () => {
    const { resolveClientFacingModelId } = await import("@/sse/handlers/chat.js");
    const clientModelId = "ds/deepseek-v4-pro";

    expect(resolveClientFacingModelId({}, "deepseek-v4-pro", clientModelId)).toBe(clientModelId);
    expect(resolveClientFacingModelId({ providerSpecificData: { prefix: "myco" } }, "deepseek-v4-pro", clientModelId)).toBe("myco/deepseek-v4-pro");
    expect(resolveClientFacingModelId({ providerSpecificData: { prefix: "   " } }, "deepseek-v4-pro", clientModelId)).toBe(clientModelId);
    expect(resolveClientFacingModelId({}, "deepseek-v4-pro", undefined)).toBeUndefined();
  });

  it("#given a successful real chat account loop #when a connection has a prefix #then stamped header keeps prefix", async () => {
    vi.resetModules();
    vi.doMock("@/sse/services/auth.js", () => ({
      getProviderCredentials: vi.fn(async () => ({ connectionId: "conn-1", connectionName: "MyCo", providerSpecificData: { prefix: "myco" } })),
      checkAndRefreshToken: vi.fn(async (_provider, credentials) => credentials),
      markAccountUnavailable: vi.fn(),
      clearAccountError: vi.fn(),
      extractApiKey: vi.fn(),
      isValidApiKey: vi.fn(),
    }));
    vi.doMock("@/lib/localDb", () => ({
      getSettings: vi.fn(async () => ({})),
      getModelAliases: vi.fn(),
      getComboByName: vi.fn(),
      getProviderNodes: vi.fn(),
    }));
    vi.doMock("@/sse/services/model.js", () => ({
      getModelInfo: vi.fn(async () => ({ provider: "deepseek", model: "deepseek-v4-pro", clientModelId: "ds/deepseek-v4-pro" })),
      getComboModels: vi.fn(async () => null),
    }));
    vi.doMock("open-sse/handlers/chatCore.js", () => ({
      handleChatCore: vi.fn(async () => ({ success: true, response: new Response("ok") })),
    }));

    const { handleSingleModelChat } = await import("@/sse/handlers/chat.js");
    const response = await handleSingleModelChat(
      { model: "ds/deepseek-v4-pro", messages: [] },
      "ds/deepseek-v4-pro",
      null,
      new Request("http://localhost/v1/chat/completions"),
    );

    expect(response.headers.get(UPSTREAM_MODEL_HEADER)).toBe("myco/deepseek-v4-pro");
  });

  it("#given a provider node prefix #when model info resolves #then display id keeps user prefix", async () => {
    const ctx = await setupModelInfo();
    cleanup = ctx.cleanup;
    await ctx.createProviderNode({
      id: "openai-compatible-chat-abc123",
      type: "openai-compatible",
      name: "MyCo",
      prefix: "myco",
      apiType: "chat",
      baseUrl: "https://compatible.test/v1",
    });

    const result = await ctx.getModelInfo("myco/gpt-4o");
    expect(result).toMatchObject({ provider: "openai-compatible-chat-abc123", model: "gpt-4o" });
    expect(result.clientModelId).toBe("myco/gpt-4o");
    expect(result.clientModelId).not.toMatch(/^openai-compatible-/);
  });

  it("#given an Anthropic-compatible provider node #when model info resolves #then display id keeps user prefix", async () => {
    const ctx = await setupModelInfo();
    cleanup = ctx.cleanup;
    await ctx.createProviderNode({
      id: "anthropic-compatible-xyz123",
      type: "anthropic-compatible",
      name: "MyAnthropic",
      prefix: "myant",
      baseUrl: "https://anthropic-compatible.test",
    });

    const result = await ctx.getModelInfo("myant/claude-x");
    expect(result).toMatchObject({ provider: "anthropic-compatible-xyz123", model: "claude-x" });
    expect(result.clientModelId).toBe("myant/claude-x");
    expect(result.clientModelId).not.toMatch(/^anthropic-compatible-/);
  });

  it("#given a custom embedding provider node #when model info resolves #then display id keeps user prefix", async () => {
    const ctx = await setupModelInfo();
    cleanup = ctx.cleanup;
    await ctx.createProviderNode({
      id: "custom-embedding-xyz123",
      type: "custom-embedding",
      name: "MyEmbeddings",
      prefix: "myemb",
      baseUrl: "https://embedding-compatible.test",
    });

    const result = await ctx.getModelInfo("myemb/bge-m3");
    expect(result).toMatchObject({ provider: "custom-embedding-xyz123", model: "bge-m3" });
    expect(result.clientModelId).toBe("myemb/bge-m3");
    expect(result.clientModelId).not.toMatch(/^custom-embedding-/);
  });
});
