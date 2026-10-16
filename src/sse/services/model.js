// Re-export from open-sse with localDb integration
import { getModelAliases, getComboByName, getProviderNodes } from "@/lib/localDb";
import { parseModel as parseModelCore, resolveModelAliasFromMap, getModelInfoCore } from "open-sse/services/model.js";
import REGISTRY from "open-sse/providers/registry/index.js";
import { getProviderAlias } from "@/shared/constants/providers.js";

// Local provider alias overrides (HMR-friendly, applied on top of open-sse map)
const LOCAL_PROVIDER_ALIASES = {
  xmtp: "xiaomi-tokenplan",
  "xiaomi-tokenplan": "xiaomi-tokenplan",
};

const RESERVED_PROVIDER_PREFIXES = new Set(Object.keys(LOCAL_PROVIDER_ALIASES));

/**
 * Resolve a user-defined provider-node prefix to the node a request with that
 * prefix routes to, or null. Built-in provider ids/aliases (`cf`, `openai`, …)
 * are reserved and never resolve to a node; on duplicate prefixes the first
 * node in type order openai → anthropic → embedding wins.
 * @param {string} prefix
 */
export async function resolvePrefixNode(prefix) {
  if (!prefix || RESERVED_PROVIDER_PREFIXES.has(prefix)) return null;
  for (const type of ["openai-compatible", "anthropic-compatible", "custom-embedding"]) {
    const nodes = await getProviderNodes({ type });
    const match = nodes.find((node) => node.prefix === prefix);
    if (match) return match;
  }
  return null;
}

function withClientModelId(modelInfo, clientModelId) {
  Object.defineProperty(modelInfo, "clientModelId", { value: clientModelId });
  return modelInfo;
}
for (const entry of REGISTRY) {
  RESERVED_PROVIDER_PREFIXES.add(entry.id);
  if (entry.alias) RESERVED_PROVIDER_PREFIXES.add(entry.alias);
  for (const alias of entry.aliases || []) RESERVED_PROVIDER_PREFIXES.add(alias);
}

export function parseModel(modelStr) {
  const parsed = parseModelCore(modelStr);
  if (parsed?.providerAlias && LOCAL_PROVIDER_ALIASES[parsed.providerAlias]) {
    return { ...parsed, provider: LOCAL_PROVIDER_ALIASES[parsed.providerAlias] };
  }
  return parsed;
}

/**
 * Resolve model alias from localDb
 */
export async function resolveModelAlias(alias) {
  const aliases = await getModelAliases();
  return resolveModelAliasFromMap(alias, aliases);
}

/**
 * Get full model info (parse or resolve)
 */
export async function getModelInfo(modelStr) {
  const parsed = parseModel(modelStr);

  if (!parsed.isAlias) {
    // Provider-node prefixes are user-defined. They must not override built-in
    // provider ids/aliases such as `cf`, `cloudflare-ai`, `openai`, or `hf`.
    const node = await resolvePrefixNode(parsed.providerAlias);
    if (node) {
      return withClientModelId({ provider: node.id, model: parsed.model }, `${node.prefix}/${parsed.model}`);
    }
    return withClientModelId(
      { provider: parsed.provider, model: parsed.model },
      `${getProviderAlias(parsed.provider)}/${parsed.model}`,
    );
  }

  // Check if this is a combo name before resolving as alias
  // This prevents combo names from being incorrectly routed to providers
  const combo = await getComboByName(parsed.model);
  if (combo) {
    // Return null provider to signal this should be handled as combo
    // The caller (handleChat) will detect this and handle it as combo
    return { provider: null, model: parsed.model };
  }

  const resolved = await getModelInfoCore(modelStr, getModelAliases);
  return withClientModelId(
    resolved,
    `${getProviderAlias(resolved.provider)}/${resolved.model}`,
  );
}

/**
 * Check if model is a combo and get models list
 * @returns {Promise<string[]|null>} Array of models or null if not a combo
 */
export async function getComboModels(modelStr) {
  // Only check if it's not in provider/model format
  if (modelStr.includes("/")) return null;

  const combo = await getComboByName(modelStr);
  if (combo && combo.models && combo.models.length > 0) {
    return combo.models;
  }
  return null;
}
