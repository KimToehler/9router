// Custom-model flags stored in the DB reach routing, and every write path keeps
// the in-memory index current without a restart.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
const NODE = "anthropic-compatible-n1";
const IMAGE_OMITTED = "[image omitted: model has no vision support]";

let tempDir;
let caps;
let store;
let customRoute;
let addCustomModel;
let stripUnsupportedModalities;

function request(method, url, body) {
  return new Request(url, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

const patch = (body) => customRoute.PATCH(request("PATCH", "http://localhost/api/models/custom", body));

function claudeBodyWithImage() {
  return {
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
        { type: "text", text: "Which colour?" },
      ],
    }],
  };
}

describe("custom model caps from the store", () => {
  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-custom-caps-"));
    process.env.DATA_DIR = tempDir;
    delete global._dbAdapter;
    vi.resetModules();
    vi.doMock("next/server", () => ({
      NextResponse: {
        json(body, init = {}) {
          return new Response(JSON.stringify(body), {
            status: init.status || 200,
            headers: { "Content-Type": "application/json" },
          });
        },
      },
    }));

    caps = await import("../../open-sse/providers/capabilities.js");
    ({ stripUnsupportedModalities } = await import("../../open-sse/translator/concerns/modality.js"));
    store = await import("@/lib/customModelCaps.js");
    ({ addCustomModel } = await import("@/models/index.js"));
    customRoute = await import("@/app/api/models/custom/route.js");
  });

  afterEach(() => {
    caps.setCustomCapsSource(null);
    delete globalThis.__9rCustomCapsIndex;
    vi.doUnmock("next/server");
    vi.resetModules();
    global._dbAdapter?.instance?.close?.();
    delete global._dbAdapter;
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  // Next gives every route chunk its own copy of a module. The startup hook
  // installs the reader from one copy, a write route reloads from another.
  it("a reload from another module copy reaches the installed reader", async () => {
    await addCustomModel({ providerAlias: NODE, id: "glm-5.3", caps: { vision: true } });
    await store.installCustomModelCaps();
    expect(caps.getCapabilitiesForModel(NODE, "glm-5.3").vision).toBe(true);

    vi.resetModules();
    const otherCopy = await import("@/lib/customModelCaps.js");
    const { updateCustomModelCaps } = await import("@/models/index.js");
    await updateCustomModelCaps({ providerAlias: NODE, id: "glm-5.3", caps: { vision: false } });
    await otherCopy.reloadCustomModelCaps();

    expect(caps.getCapabilitiesForModel(NODE, "glm-5.3").vision).toBe(false);
  });

  it("applies a stored vision flag to the node's model, thinking suffix included", async () => {
    await addCustomModel({ providerAlias: NODE, id: "glm-5.3", caps: { vision: true } });
    await store.installCustomModelCaps();

    expect(caps.getCapabilitiesForModel(NODE, "glm-5.3").vision).toBe(true);
    expect(caps.getCapabilitiesForModel(NODE, "glm-5.3(high)").vision).toBe(true);
    expect(caps.getCapabilitiesForModel("zai", "glm-5.3").vision).toBe(false);
  });

  it("keys built-in providers by provider id, not by the storage alias", async () => {
    await addCustomModel({ providerAlias: "cc", id: "my-text-model", caps: { vision: true } });
    await store.installCustomModelCaps();

    expect(caps.getCapabilitiesForModel("claude", "my-text-model").vision).toBe(true);
  });

  it("leaves models without stored flags on the table result", async () => {
    await addCustomModel({ providerAlias: NODE, id: "glm-5.3" });
    await store.installCustomModelCaps();

    expect(caps.getCapabilitiesForModel(NODE, "glm-5.3").vision).toBe(false);
  });

  it("keeps the image only while the vision flag is on", async () => {
    await addCustomModel({ providerAlias: NODE, id: "glm-5.3", caps: { vision: true } });
    await store.installCustomModelCaps();

    const on = claudeBodyWithImage();
    stripUnsupportedModalities(on, "claude", caps.getCapabilitiesForModel(NODE, "glm-5.3"));
    expect(on.messages[0].content.map((c) => c.type)).toEqual(["image", "text"]);

    expect((await patch({ providerAlias: NODE, id: "glm-5.3", caps: { vision: false } })).status).toBe(200);
    const off = claudeBodyWithImage();
    stripUnsupportedModalities(off, "claude", caps.getCapabilitiesForModel(NODE, "glm-5.3"));
    expect(off.messages[0].content.some((c) => c.type === "image")).toBe(false);
    expect(JSON.stringify(off.messages[0].content)).toContain(IMAGE_OMITTED);
  });

  it("PATCH, POST and DELETE refresh the index without a restart", async () => {
    await store.installCustomModelCaps();

    const post = await customRoute.POST(request("POST", "http://localhost/api/models/custom",
      { providerAlias: NODE, id: "glm-5.3", caps: { vision: true } }));
    expect(post.status).toBe(200);
    expect(caps.getCapabilitiesForModel(NODE, "glm-5.3").vision).toBe(true);

    expect((await patch({ providerAlias: NODE, id: "glm-5.3", caps: { vision: false } })).status).toBe(200);
    expect(caps.getCapabilitiesForModel(NODE, "glm-5.3").vision).toBe(false);

    expect((await patch({ providerAlias: NODE, id: "glm-5.3", caps: { vision: true } })).status).toBe(200);
    expect(caps.getCapabilitiesForModel(NODE, "glm-5.3").vision).toBe(true);

    const del = await customRoute.DELETE(request("DELETE",
      `http://localhost/api/models/custom?providerAlias=${NODE}&id=glm-5.3&type=llm`));
    expect(del.status).toBe(200);
    expect(caps.getCapabilitiesForModel(NODE, "glm-5.3").vision).toBe(false);
  });

  it("PATCH keeps other stored flags and rejects unknown models and empty caps", async () => {
    await addCustomModel({ providerAlias: NODE, id: "glm-5.3", caps: { vision: true, reasoning: true } });
    await store.installCustomModelCaps();

    expect((await patch({ providerAlias: NODE, id: "glm-5.3", caps: { vision: false } })).status).toBe(200);
    const listed = await (await customRoute.GET()).json();
    expect(listed.models.find((m) => m.id === "glm-5.3").caps).toEqual({ vision: false, reasoning: true });

    expect((await patch({ providerAlias: NODE, id: "missing", caps: { vision: true } })).status).toBe(404);
    expect((await patch({ providerAlias: NODE, id: "glm-5.3", caps: { foo: true } })).status).toBe(400);
    expect((await patch({ providerAlias: NODE, id: "glm-5.3" })).status).toBe(400);
  });

  // A request for `bifrost/glm-5.3` with an image is checked by the capacity
  // adapter on that seat string, before the prefix is resolved to the node id.
  // Without the flag on the prefix seat, the adapter reroutes the request to its
  // vision fallback model instead of the node.
  it("the node prefix seat carries the flags, so the capacity adapter keeps the node", async () => {
    const { createProviderNode } = await import("@/models/index.js");
    const { augmentModelsWithCapacityAdapter } = await import("../../open-sse/services/capacityAdapter.js");
    const settings = { capacityAdapter: { vision: { enabled: true, models: ["oc/mimo-v2.6-flash-free"] } } };
    const node = await createProviderNode({ type: "anthropic-compatible", name: "Bifrost", prefix: "bifrost", baseUrl: "https://example.test/api/v1" });
    await addCustomModel({ providerAlias: node.id, id: "glm-5.3", caps: { vision: true } });
    await store.installCustomModelCaps();

    expect(caps.getCapabilitiesForModel("bifrost", "glm-5.3").vision).toBe(true);
    expect(augmentModelsWithCapacityAdapter(["bifrost/glm-5.3"], new Set(["vision"]), settings)).toEqual(["bifrost/glm-5.3"]);

    expect((await patch({ providerAlias: node.id, id: "glm-5.3", caps: { vision: false } })).status).toBe(200);
    expect(augmentModelsWithCapacityAdapter(["bifrost/glm-5.3"], new Set(["vision"]), settings))
      .toEqual(["oc/mimo-v2.6-flash-free", "bifrost/glm-5.3"]);
  });

  it.each([
    ["a provider id", "claude"],
    ["a provider alias", "cc"],
    ["a registry-only alias", "gb"],
    ["a local alias", "xmtp"],
  ])("a prefix that is %s does not shadow that seat", async (_label, prefix) => {
    const { createProviderNode } = await import("@/models/index.js");
    const node = await createProviderNode({ type: "anthropic-compatible", name: "Shadow", prefix, baseUrl: "https://example.test/v1" });
    await addCustomModel({ providerAlias: node.id, id: "some-model", caps: { vision: true } });
    await store.installCustomModelCaps();

    expect(caps.getCapabilitiesForModel(node.id, "some-model").vision).toBe(true);
    expect(caps.getCapabilitiesForModel(prefix, "some-model").vision).toBe(false);
  });

  it("on a duplicate prefix only the node routing resolves to owns the seat", async () => {
    const { createProviderNode } = await import("@/models/index.js");
    const { getModelInfo } = await import("@/sse/services/model.js");
    const openai = await createProviderNode({ type: "openai-compatible", name: "A", prefix: "dup", baseUrl: "https://a.test/v1" });
    const anthropic = await createProviderNode({ type: "anthropic-compatible", name: "B", prefix: "dup", baseUrl: "https://b.test/v1" });
    await addCustomModel({ providerAlias: anthropic.id, id: "m", caps: { vision: true } });
    await store.installCustomModelCaps();

    expect((await getModelInfo("dup/m")).provider).toBe(openai.id);
    expect(caps.getCapabilitiesForModel("dup", "m").vision).toBe(false);
  });

  it("renaming the node prefix moves the flags to the new seat", async () => {
    const { createProviderNode } = await import("@/models/index.js");
    const nodeRoute = await import("@/app/api/provider-nodes/[id]/route.js");
    const node = await createProviderNode({ type: "anthropic-compatible", name: "Bifrost", prefix: "bifrost", baseUrl: "https://example.test/api/v1" });
    await addCustomModel({ providerAlias: node.id, id: "glm-5.3", caps: { vision: true } });
    await store.installCustomModelCaps();

    const put = await nodeRoute.PUT(
      request("PUT", `http://localhost/api/provider-nodes/${node.id}`, { name: "Bifrost", prefix: "bf", baseUrl: "https://example.test/api/v1" }),
      { params: Promise.resolve({ id: node.id }) },
    );
    expect(put.status).toBe(200);
    expect(caps.getCapabilitiesForModel("bf", "glm-5.3").vision).toBe(true);
    expect(caps.getCapabilitiesForModel("bifrost", "glm-5.3").vision).toBe(false);
  });
});
