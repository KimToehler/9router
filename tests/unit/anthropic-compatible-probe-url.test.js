import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// "Test connection" and the API-key "Check" button must probe the same
// messages URL the executor routes real traffic to. They used to append
// `/v1/messages` to a base that already ends in `/v1`, so every probe hit
// `.../v1/v1/messages` while routing worked.

const mocks = vi.hoisted(() => ({
  getProviderConnectionById: vi.fn(),
  updateProviderConnection: vi.fn(),
  getProviderNodeById: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json(body, init = {}) {
      return new Response(JSON.stringify(body), {
        status: init.status || 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  },
}));

vi.mock("@/models", () => ({
  getProviderNodeById: mocks.getProviderNodeById,
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnectionById: mocks.getProviderConnectionById,
  updateProviderConnection: mocks.updateProviderConnection,
}));

vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn(async () => ({})),
}));

vi.mock("@/lib/network/proxyTest", () => ({
  testProxyUrl: vi.fn(async () => ({ ok: true })),
}));

const { testSingleConnection } = await import("../../src/app/api/providers/[id]/test/testUtils.js");
const { POST: validateProvider } = await import("../../src/app/api/providers/validate/route.js");
const { POST: validateProviderNode } = await import("../../src/app/api/provider-nodes/validate/route.js");
const { getExecutor } = await import("../../open-sse/executors/index.js");

const PROVIDER = "anthropic-compatible-probe-test";
const BASE_URL = "https://example.test/api/v1";
const MODEL = "glm-5.3";

function executorMessagesUrl(baseUrl) {
  return getExecutor(PROVIDER).buildUrl(MODEL, true, 0, { providerSpecificData: { baseUrl } });
}

describe("anthropic-compatible probe URL", () => {
  let fetchSpy;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ type: "message" }), { status: 200 }),
    );
    mocks.updateProviderConnection.mockResolvedValue(undefined);
    mocks.getProviderNodeById.mockResolvedValue({ id: PROVIDER, baseUrl: BASE_URL, defaultModel: MODEL });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("Test connection requests the executor's messages URL", async () => {
    mocks.getProviderConnectionById.mockResolvedValue({
      id: "conn-1",
      provider: PROVIDER,
      authType: "apikey",
      apiKey: "sk-test",
      defaultModel: MODEL,
      providerSpecificData: { baseUrl: BASE_URL },
    });

    await testSingleConnection("conn-1");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://example.test/api/v1/messages");
    expect(url).toBe(executorMessagesUrl(BASE_URL));
  });

  it("API-key validation requests the executor's messages URL", async () => {
    const request = new Request("http://localhost/api/providers/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: PROVIDER, apiKey: "sk-test" }),
    });

    await validateProvider(request);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://example.test/api/v1/messages");
    expect(url).toBe(executorMessagesUrl(BASE_URL));
  });

  it("probe and executor agree when the base carries a trailing slash or /messages", async () => {
    for (const baseUrl of [`${BASE_URL}/`, `${BASE_URL}/messages`]) {
      fetchSpy.mockClear();
      mocks.getProviderConnectionById.mockResolvedValue({
        id: "conn-1",
        provider: PROVIDER,
        authType: "apikey",
        apiKey: "sk-test",
        providerSpecificData: { baseUrl },
      });

      await testSingleConnection("conn-1");

      const [url] = fetchSpy.mock.calls[0];
      expect(url).toBe("https://example.test/api/v1/messages");
      expect(executorMessagesUrl(baseUrl)).toBe(url);
    }
  });

  const json = (status, body) => new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
  const unknownModel404 = () => json(404, {
    type: "error",
    error: { type: "not_found_error", message: "model: claude-3-haiku-20240307" },
  });
  const route404 = () => json(404, { error: "not found" });

  const STATUS_CASES = [
    ["200 OK", () => json(200, { type: "message" }), true],
    ["400 unknown model on a gateway", () => json(400, { error: "MODEL_UNKNOWN" }), true],
    ["404 unknown model from Anthropic", unknownModel404, true],
    ["529 overloaded", () => json(529, { type: "error" }), true],
    ["401 bad key", () => json(401, { type: "error" }), false],
    ["403 forbidden", () => json(403, { type: "error" }), false],
    ["404 missing messages route", route404, false],
  ];

  it.each(STATUS_CASES)("Test connection classifies %s", async (_label, makeResponse, expected) => {
    fetchSpy.mockResolvedValue(makeResponse());
    mocks.getProviderConnectionById.mockResolvedValue({
      id: "conn-1",
      provider: PROVIDER,
      authType: "apikey",
      apiKey: "sk-test",
      providerSpecificData: { baseUrl: BASE_URL },
    });

    const result = await testSingleConnection("conn-1");

    expect(result.valid).toBe(expected);
    expect(mocks.updateProviderConnection).toHaveBeenCalledWith(
      "conn-1",
      expect.objectContaining({ testStatus: expected ? "active" : "error" }),
    );
  });

  it.each(STATUS_CASES)("API-key validation classifies %s", async (_label, makeResponse, expected) => {
    fetchSpy.mockResolvedValue(makeResponse());
    const request = new Request("http://localhost/api/providers/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: PROVIDER, apiKey: "sk-test" }),
    });

    const payload = await (await validateProvider(request)).json();

    expect(payload.valid).toBe(expected);
  });

  it("a missing messages route names the base URL as the cause", async () => {
    fetchSpy.mockResolvedValue(route404());
    mocks.getProviderConnectionById.mockResolvedValue({
      id: "conn-1",
      provider: PROVIDER,
      authType: "apikey",
      apiKey: "sk-test",
      providerSpecificData: { baseUrl: BASE_URL },
    });

    const result = await testSingleConnection("conn-1");

    expect(result.error).toMatch(/base URL/);
  });

  it("node validation falls back to an Anthropic messages request on the executor's URL", async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response("not found", { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ type: "message" }), { status: 200 }));
    const request = new Request("http://localhost/api/provider-nodes/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseUrl: BASE_URL, apiKey: "sk-test", type: "anthropic-compatible", modelId: MODEL }),
    });

    const payload = await (await validateProviderNode(request)).json();

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const [url, options] = fetchSpy.mock.calls[1];
    expect(url).toBe(executorMessagesUrl(BASE_URL));
    expect(options.method).toBe("POST");
    expect(options.headers).toMatchObject({ "x-api-key": "sk-test", "anthropic-version": "2023-06-01" });
    expect(JSON.parse(options.body)).toEqual({
      model: MODEL,
      max_tokens: 1,
      messages: [{ role: "user", content: "ping" }],
    });
    expect(payload).toEqual({ valid: true, method: "chat" });
  });
});
