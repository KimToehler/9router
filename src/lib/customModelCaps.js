// In-memory index of the capability flags users set on custom models, fed to
// getCapabilitiesForModel through setCustomCapsSource(). Capability lookups are
// synchronous and run per request, so the DB is read once at startup and again
// after every write to the custom-model store (reloadCustomModelCaps()).
import { getCustomModels } from "@/lib/localDb";
import { ALIAS_TO_ID } from "@/shared/constants/providers";
import { CAPACITY_META } from "@/shared/constants/models";
import { setCustomCapsSource } from "open-sse/providers/capabilities.js";

const CAP_KEYS = Object.keys(CAPACITY_META);

// `${providerId}|${modelId}` -> { vision?: boolean, reasoning?: boolean }
// Next bundles this module into every route chunk that imports it, each with its
// own module state. The startup hook installs the reader from one copy and a
// write route reloads from another, so the index lives on globalThis where both
// copies see the same map.
const INDEX_KEY = "__9rCustomCapsIndex";
if (!globalThis[INDEX_KEY]) globalThis[INDEX_KEY] = new Map();

// Same rule as stripThinkingSuffix in open-sse/translator/concerns/thinkingUnified.js:
// "glm-5.3(high)" is the model "glm-5.3" with a thinking level.
function stripThinkingSuffix(model) {
  const m = String(model).match(/^(.*)\([^()]+\)\s*$/);
  return m ? m[1].trim() : String(model);
}

export async function reloadCustomModelCaps() {
  const next = new Map();
  for (const m of await getCustomModels()) {
    if (!m?.id || !m.providerAlias || (m.type || "llm") !== "llm" || !m.caps) continue;
    const flags = {};
    for (const key of CAP_KEYS) {
      if (typeof m.caps[key] === "boolean") flags[key] = m.caps[key];
    }
    if (Object.keys(flags).length === 0) continue;
    // Built-in providers store their alias (cc); routing looks up the id (claude).
    // Compatible nodes store the node id, which is already the routed provider.
    const providerId = ALIAS_TO_ID[m.providerAlias] || m.providerAlias;
    next.set(`${providerId}|${m.id}`, flags);
  }
  globalThis[INDEX_KEY] = next;
}

export async function installCustomModelCaps() {
  await reloadCustomModelCaps();
  setCustomCapsSource({
    get: (provider, model) => globalThis[INDEX_KEY].get(`${provider}|${stripThinkingSuffix(model)}`) || null,
  });
}
