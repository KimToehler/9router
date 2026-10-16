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
});
