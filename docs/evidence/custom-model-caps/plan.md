# Custom-model capability flags drive routing

## Context
9router decides per request whether a model can read images via `getCapabilitiesForModel(provider, model)` (`open-sse/providers/capabilities.js`). For `glm-5.3`, the `*glm-5.3*` pattern (line ~493) has no `vision`, so `chatCore` strips images (`stripUnsupportedModalities`, `open-sse/handlers/chatCore.js` ~l.191) and replaces them with `[image omitted: model has no vision support]`. That matches z.ai's own docs ("GLM-5.3 currently supports text-only inputs", https://docs.z.ai/guides/llm/glm-5.3), but the user's anthropic-compatible gateway Bifrost (`https://bifrost.yorizon-prod.ai.advisori-apps.de/api/v1`) does serve images for `glm-5.3`: a 4-colour quadrant PNG was answered `blue, yellow, green, purple` with the image and guessed wrong without it. A global `vision: true` on the pattern would be wrong for z.ai/OpenRouter/opencode-go, so it must NOT be changed.

Goal: the custom-model "Vision" / "Reasoning" flags a user sets on a model (stored as `caps` on the custom-model record) become authoritative for routing for exactly that provider + model. The user then registers `glm-5.3` on the Bifrost node with Vision on, renames clients to `bifrost/glm-5.3`, and gets 1M/128k limits (from the pattern) plus images passed through. Compatible-node model lists get a Vision/Reasoning toggle per model, since today only the built-in-provider "Add Custom Model" modal exposes them.

Work in a worktree: `git worktree add .worktrees/custom-model-caps -b feat/custom-model-caps master` from `/Users/tim/git/9router`, then `npm install --no-package-lock` at the worktree root and in `tests/`. Default branch is `master`; the user merges locally with `git merge --ff-only` and pushes `master` to remote `fork` (no PRs). Commit style: Conventional Commits, no `Co-Authored-By`.

## Approach

### 1. Override layer in `getCapabilitiesForModel` (pure, browser-safe)
In `open-sse/providers/capabilities.js`, next to the catalog-source slot (`setCatalogSource` / `getCatalogSource`, ~l.637-652), add a second injected source with the same globalThis pattern (module copies in Next route chunks must share it — read the existing comment at ~l.629-636 and mirror it):

```js
let customCapsSource = null;
/**
 * Install the user's per-model capability flags (server only).
 * @param {{ get: (provider: string, model: string) => object|null } | null} source
 */
export function setCustomCapsSource(source) {
  customCapsSource = source;
  if (typeof globalThis !== "undefined") globalThis.__9rCustomCapsSource = source;
}
function getCustomCapsSource() {
  if (typeof globalThis === "undefined") return customCapsSource;
  return globalThis.__9rCustomCapsSource || null;
}
```

Rename the existing `export function getCapabilitiesForModel(provider, model)` body into a non-exported `function resolveCapabilities(provider, model)` (unchanged logic), and make the exported function:

```js
export function getCapabilitiesForModel(provider, model) {
  const resolved = resolveCapabilities(provider, model);
  const custom = provider && model ? getCustomCapsSource()?.get(provider, model) : null;
  return custom ? { ...resolved, ...custom } : resolved;
}
```

Rules, stated in a comment above the function and in the header comment list (~l.3-20, add a bullet "• user custom-model flags — `vision` / `reasoning` set on a custom model in the dashboard; applied last and win in both directions, because the user knows their gateway"):
- Only the boolean keys the dashboard writes (`vision`, `reasoning` — the keys of `CAPACITY_META` in `src/shared/constants/models.js`) are ever returned by the source; the merge does not filter, the source does (step 2).
- Applied after every other layer, including step 1 provider overrides and `refine()`, and may turn a capability OFF as well as ON.
- `model` may carry a thinking suffix (`glm-5.3(high)`); the source handles that (step 2), not this function.

### 2. Server-side source backed by the custom-model store
New file `src/lib/customModelCaps.js` (no equivalent exists; `catalogOverride.js` is the file-backed analogue, this one is DB-backed). It keeps an in-memory index, because `getCapabilitiesForModel` is synchronous and per-request:

```js
import { getCustomModels } from "@/lib/db/index.js";
import { ALIAS_TO_ID } from "@/shared/constants/providers";
import { setCustomCapsSource } from "open-sse/providers/capabilities.js";
import { CAPACITY_META } from "@/shared/constants/models";

const CAP_KEYS = Object.keys(CAPACITY_META);
let index = new Map();   // `${providerId}|${modelId}` -> { vision?: boolean, reasoning?: boolean }

function stripSuffix(model) { const m = String(model).match(/^(.*)\([^()]+\)\s*$/); return m ? m[1].trim() : String(model); }

export async function reloadCustomModelCaps() {
  const next = new Map();
  for (const m of await getCustomModels()) {
    if (!m?.id || !m.providerAlias || (m.type || "llm") !== "llm" || !m.caps) continue;
    const caps = {};
    for (const k of CAP_KEYS) if (typeof m.caps[k] === "boolean") caps[k] = m.caps[k];
    if (!Object.keys(caps).length) continue;
    const providerId = ALIAS_TO_ID[m.providerAlias] || m.providerAlias;
    next.set(`${providerId}|${m.id}`, caps);
  }
  index = next;
}

export async function installCustomModelCaps() {
  await reloadCustomModelCaps();
  setCustomCapsSource({ get: (provider, model) => index.get(`${provider}|${stripSuffix(model)}`) || null });
}
```

Key decisions baked in:
- Key = provider **id** (`ALIAS_TO_ID` maps built-in storage aliases such as `cc` → `claude`; compatible nodes store the node id, e.g. `anthropic-compatible-<uuid>`, which is already the routed provider id — verified: `providerStorageAlias = isCompatible ? providerId : providerAlias` in `src/app/(dashboard)/dashboard/providers/[id]/page.js` ~l.187, and `getModelInfo` resolves prefix `bifrost` to the node id).
- Thinking suffix stripped with the same regex as `stripThinkingSuffix` (`open-sse/translator/concerns/thinkingUnified.js` l.26-30). Do not import thinkingUnified here (it pulls the translator graph); inline the regex with a comment naming that function.
- Records without `caps`, or with no boolean `vision`/`reasoning`, contribute nothing — existing custom models keep today's behaviour exactly.
- `type !== "llm"` records (stt, embedding, …) are ignored.

Wire it at startup in `src/instrumentation.js` (inside the existing `NEXT_RUNTIME === "nodejs"` block, after `installCatalogSource()`):
```js
const { installCustomModelCaps } = await import("@/lib/customModelCaps.js");
await installCustomModelCaps().catch((err) => console.warn("[CustomCaps] install failed:", err?.message));
```
On failure routing falls back to table caps (the source stays unset) — never block startup.

### 3. Keep the index fresh on every write
Call `await reloadCustomModelCaps()` (import from `@/lib/customModelCaps.js`) after each successful write, inside the existing `try` before the success response, and swallow nothing (an error there should surface like the write's own errors):
- `src/app/api/models/custom/route.js` — `POST` after `addCustomModel(...)`, `DELETE` after `deleteCustomModel(...)`, and the new `PATCH` from step 4.
- `src/app/api/provider-nodes/[id]/route.js` — `DELETE` after `deleteProviderNode(id)` (it cascades `customModels` rows, `src/lib/db/repos/nodesRepo.js` l.93).
- `src/app/api/settings/database/route.js` — `POST` after `importDb(payload)`.
These are the only writers of scope `customModels` besides the one-time legacy migration in `src/lib/db/migrate.js`, which runs inside `getAdapter()` before the first `getCustomModels()` read and is therefore covered by the startup load.

### 4. Edit flags on an existing custom model
`addCustomModel` (`src/lib/db/repos/aliasRepo.js` l.34-51) merges `caps` over the stored value but only replaces the whole `caps` object, and the POST route returns `added:false` for an existing row — usable, but the compatible-node UI needs a toggle on an existing row. Add `PATCH /api/models/custom` in `src/app/api/models/custom/route.js`:
- Body `{ providerAlias, id, type = "llm", caps }`; 400 `{ error: "providerAlias, id and caps required" }` if any is missing; reuse the file's `sanitizeCaps`; 400 `{ error: "No valid capability flags" }` if it returns null.
- Implement via a new repo function in `aliasRepo.js`, exported through `src/lib/db/index.js`, `src/lib/localDb.js` and `src/models/index.js` exactly like `addCustomModel`:
  ```js
  export async function updateCustomModelCaps({ providerAlias, id, type = "llm", caps }) // -> boolean found
  ```
  Inside one `db.transaction`: read the row by `customKey(...)`; if absent return `false`; else write `{ ...prev, caps: { ...(prev.caps || {}), ...caps } }`.
- Route: `404 { error: "Custom model not found" }` when it returns false; otherwise `reloadCustomModelCaps()` and `{ success: true }`.

### 5. Toggles on compatible-node model rows
In `src/app/(dashboard)/dashboard/providers/[id]/CompatibleModelsSection.js`:
- `getProviderCustomModelRows` (`src/shared/utils/providerCustomModels.js`) must pass `caps` through: add `caps: model.caps || null` to the pushed custom row object (legacy-alias rows get no `caps` key). Update the `toEqual` expectations in `tests/unit/provider-custom-models.test.js` to include `caps: null` for custom rows.
- `CompatibleModelRow` gets props `caps` and `onToggleCap(key, value)`; render, for rows with `source === "custom"` only, one `Toggle` (`@/shared/components`, `size="sm"`) per `CAPACITY_META` entry (`label={meta.label}`, `checked={!!caps?.[key]}`), placed in the existing `flex items-center gap-1 mt-1` line after the test button. Legacy-alias rows show no toggles.
- New prop on `CompatibleModelsSection`: `onUpdateCustomModelCaps: PropTypes.func.isRequired`, called as `onUpdateCustomModelCaps(id, { [key]: value })`.
- In `src/app/(dashboard)/dashboard/providers/[id]/page.js`, add next to `handleAddCustomModel` (~l.565):
  ```js
  const handleUpdateCustomModelCaps = async (modelId, caps) => { /* PATCH /api/models/custom with { providerAlias: providerStorageAlias, id: modelId, type: "llm", caps } */ }
  ```
  On `res.ok`: `await fetchCustomModels()` and `window.dispatchEvent(new CustomEvent("customModelChanged"))` (same as `handleAddCustomModel`); else `alert(data.error || "Failed to update model")`. Pass it to `<CompatibleModelsSection onUpdateCustomModelCaps={handleUpdateCustomModelCaps} …>` (~l.1164).
- Built-in-provider custom models keep using `AddCustomModelModal` (unchanged; it already writes `caps` and now affects routing too).

### 6. Advertise the flags
- `src/app/api/v1/models/route.js` needs no change: it calls `getCapabilitiesForModel(providerId, modelId)` (~l.614, 630), which now includes the override once the source is installed.
- `src/app/api/models/route.js` already spreads `m.caps` over custom rows (l.73) — no change.

## Critical files & anchors
- `open-sse/providers/capabilities.js` — `getCapabilitiesForModel` (~l.718), catalog slot (~l.629-652), header comment (l.1-20); must stay free of server imports (bundled into the browser by `src/shared/hooks/useModelCaps.js`).
- `src/lib/customModelCaps.js` — new; index + installer.
- `src/app/api/models/custom/route.js` — `sanitizeCaps` (l.8-15) reused by PATCH; reload calls.
- `src/app/(dashboard)/dashboard/providers/[id]/CompatibleModelsSection.js` — `CompatibleModelRow` (l.7-72), row map (l.196-211).
- `src/lib/db/repos/aliasRepo.js` — `updateCustomModelCaps` next to `addCustomModel`.

## Verification
All from the worktree root; tests from `tests/` with `npx vitest run <file>`.

1. New `tests/unit/custom-model-caps.test.js` (pure, no DB): import `getCapabilitiesForModel`, `setCustomCapsSource`; `afterEach(() => setCustomCapsSource(null))`.
   - Without a source, `getCapabilitiesForModel("anthropic-compatible-x", "glm-5.3").vision === false` and `contextWindow === 1000000`.
   - With `setCustomCapsSource({ get: (p, m) => p === "anthropic-compatible-x" && m === "glm-5.3" ? { vision: true } : null })`: same call → `vision: true`, `contextWindow: 1000000`, `thinkingFormat: "zai"` (other fields untouched); `getCapabilitiesForModel("zai", "glm-5.3").vision === false` (other provider unaffected).
   - Override can turn OFF: source returns `{ vision: false }` for `("claude", "claude-sonnet-4-6")` → `vision === false`.
   Must be RED before step 1 (import of `setCustomCapsSource` fails / vision stays false) and GREEN after.
2. New `tests/unit/custom-model-caps-store.test.js` (temp DB, copy the setup of `tests/unit/bedrock-provider-api-secrets.test.js` l.40-68: `mkdtemp`, `process.env.DATA_DIR`, `delete global._dbAdapter`, `vi.resetModules()`, close + restore in `afterAll`):
   - `addCustomModel({ providerAlias: "anthropic-compatible-n1", id: "glm-5.3", caps: { vision: true } })`, `installCustomModelCaps()` → `getCapabilitiesForModel("anthropic-compatible-n1", "glm-5.3").vision === true` and `getCapabilitiesForModel("anthropic-compatible-n1", "glm-5.3(high)").vision === true`.
   - Built-in alias: `addCustomModel({ providerAlias: "cc", id: "my-text-model", caps: { vision: true } })` → `getCapabilitiesForModel("claude", "my-text-model").vision === true` after `reloadCustomModelCaps()`.
   - PATCH route: `PATCH /api/models/custom` (import `PATCH` from `src/app/api/models/custom/route.js`, mock `next/server` like `tests/unit/nous-provider-routes.test.js` l.17-26) with `{ providerAlias: "anthropic-compatible-n1", id: "glm-5.3", caps: { vision: false } }` → 200 and `getCapabilitiesForModel(...).vision === false` with no extra reload call; unknown id → 404; `caps: { foo: true }` → 400.
   - `DELETE` route for that model → `getCapabilitiesForModel(...).vision === false` (back to the pattern).
3. End-to-end strip check in the same store test: build a Claude body with an image block and call `stripUnsupportedModalities(body, "claude", getCapabilitiesForModel("anthropic-compatible-n1", "glm-5.3"))` (`open-sse/translator/concerns/modality.js`) → image block still present with Vision on; replaced by the `[image omitted: model has no vision support]` text with Vision off.
4. Full suite: `cd tests && npx vitest run --reporter=json --outputFile=/tmp/cmc.json`; compare failures against a run on `master` (same command in a `master` checkout) — no test may go from pass to fail. Known pre-existing noise: `db-sqlite-vs-lowdb` "reorder by priority" is flaky. `npx eslint` on every changed file must be clean.
5. Live smoke (local gateway, isolated data): `DATA_DIR=/tmp/9r-smoke-data JWT_SECRET=smoke-jwt-secret-0123456789abcdef INITIAL_PASSWORD=smoke-pass-4711 REQUIRE_API_KEY=true npx next dev --webpack --port 20199` in the worktree; log in via `POST /api/auth/login {"password":"smoke-pass-4711"}`; create node `POST /api/provider-nodes {"name":"Bifrost","prefix":"bifrost","type":"anthropic-compatible","baseUrl":"https://bifrost.yorizon-prod.ai.advisori-apps.de/api/v1"}`; add a connection with the user's Bifrost key (ask the user for it at execution time; never commit or log it); add custom model `POST /api/models/custom {"providerAlias":"<node id>","id":"glm-5.3"}`; insert a 9router API key into `/tmp/9r-smoke-data/db/data.sqlite` table `apiKeys`.
   - Send `POST /v1/messages` model `bifrost/glm-5.3`, `stream:false`, with a 128×128 PNG split into four quadrants (top-left blue `0,90,255`, top-right yellow `255,220,0`, bottom-left green `0,170,60`, bottom-right purple `160,0,200`) and the prompt "Name the color of each quadrant in this order: top-left, top-right, bottom-left, bottom-right. Answer as four comma-separated words." With Vision off (default) the answer must not be `blue, yellow, green, purple` and `input_tokens` stays small (~50-100, image stripped).
   - Toggle Vision on via `PATCH /api/models/custom {"providerAlias":"<node id>","id":"glm-5.3","caps":{"vision":true}}` → same request answers `blue, yellow, green, purple` and `input_tokens` ≈ 2600.
   - `GET /v1/models` (Bearer 9router key) lists `bifrost/glm-5.3` with `context_length: 1000000` and `capabilities.vision: true`.
   - Open `http://localhost:20199/dashboard/providers/<node id>` in the browser: the `glm-5.3` row shows Vision/Reasoning toggles; flipping Vision persists across reload.
   Stop the server and `rm -rf /tmp/9r-smoke-data` afterwards.

## Assumptions & contingencies
- Override wins in both directions (user can also switch Vision OFF for a model a table marks as vision-capable). If a reviewer objects, that is a one-line change in step 1 to only apply `true` values — not part of this plan.
- Only `vision` and `reasoning` are overridable, because those are the `CAPACITY_META` keys the API whitelists. Context window / max output stay table-driven; the Bifrost model needs no override there once named `glm-5.3`.
- If `import { getCustomModels } from "@/lib/db/index.js"` creates an import cycle at startup (symptom: `installCustomModelCaps` throws "Cannot access … before initialization"), import from `@/lib/localDb` instead, which re-exports the same function.
- If `ALIAS_TO_ID` from `@/shared/constants/providers` cannot be imported in `src/lib/customModelCaps.js` (registry side effects), use `resolveProviderId` from the same module; both map alias → id identically.

## Execution notes
- Vision OFF does not strip the image on this deployment: the default capacity adapter (`settings.capacityAdapter.vision.enabled: true`, fallback `oc/mimo-v2.6-flash-free`, `open-sse/services/capacityAdapter.js`) reroutes an image request for a text-only seat to its vision fallback model before `chatCore` runs. Live QA therefore observes the routed model, not image stripping, to tell ON from OFF.
- Live QA exposed that the adapter and combo reordering resolve capabilities on the seat string (`bifrost/glm-5.3`, i.e. provider = node prefix), not the node id. Commit `fix(models): apply custom-model flags to node prefix seats` indexes node models under the prefix too, using `resolvePrefixNode()` extracted from `getModelInfo` (`src/sse/services/model.js`) so reserved built-in aliases and duplicate prefixes resolve exactly as routing does; node PUT reloads the index.
- Review found the index was module-local per Next route chunk; it lives on `globalThis.__9rCustomCapsIndex` (folded into the feature commit, regression test "a reload from another module copy reaches the installed reader").
- The worktree's `next dev` overlay shows a pre-existing `@xyflow/react` CSS build error on every page (reproduced on unmodified `master`); dashboard QA ran on `next build --webpack` with the `.next/standalone` + `custom-server.js` layout the Dockerfile ships.
- The first gate (record bound to e3da39e7) went stale when the evidence commit also changed `.gitignore`. A fresh implementation audit on d0fa346e returned FAIL: the index joined `${provider}|${model}` into one string, and free-text node prefixes / model ids containing `|` could collide. Commit `fix(models): key the custom-caps index by provider, then model` nests the map and adds tests for the collision plus the node-delete and DB-import reload paths (each shown RED with the reload removed). QA re-ran on that head.
- Before merging, the maintainer committed 3deb1fc9 ("updated docker compose yml": default image `rg.nl-ams.scw.cloud/onara/9router:fork`, Traefik host default `router.onara.eu`) on master. The branch was rebased onto it (fix commit 60c90e21, content-identical to 13362198 for every feature file). A fresh implementation audit on 66d676d2 passed; its own criterion (operator-set `NINEROUTER_HOST` overrides the default host rule) is rendered in `qa-compose-config.txt`.

## Final verification wave
- [x] F3. Whole-diff review: `integration-review` over `master...feat/custom-model-caps` (change spans open-sse capabilities, DB repo, API routes and dashboard UI)
- [x] F1. Manual QA on the real surface, one evidence path per scenario, on the head after F3's last code commit: Verification step 5 (local gateway against Bifrost: image stripped with Vision off, quadrant colours correct with Vision on, `/v1/models` flags, dashboard toggle persists)
- [x] F2. Merge gate: `review-work`, SHA-bound omo.merge-gate/v2 record validated

## Merge gate
- Author's risk assessment: A wrong override key (alias vs provider id, or thinking suffix not stripped) would silently do nothing, leaving images stripped; a too-broad override would apply one node's flags to another provider and send images to text-only upstreams (upstream 400s). The override runs on every request via `getCapabilitiesForModel`, so a throwing source would break routing for all models — the source only does a Map lookup and the installer is wrapped in `catch`. No auth, secrets or schema migration involved (custom-model `caps` already exists in the `kv` value JSON).
- Mandatory class: none
- Whole-diff review: needed (spans open-sse capabilities, DB repo, three API routes and dashboard UI — 4 layers)
- Feature-specific criteria:
  - Invariant: a custom model's `vision` flag decides image stripping for exactly that provider id + model id, including a thinking-suffixed model id.
    Positive witness: `getCapabilitiesForModel("anthropic-compatible-n1", "glm-5.3(high)").vision === true` after `addCustomModel({ providerAlias: "anthropic-compatible-n1", id: "glm-5.3", caps: { vision: true } })` + `installCustomModelCaps()`, and the image block survives `stripUnsupportedModalities`.
    Negative control: `getCapabilitiesForModel("zai", "glm-5.3").vision === false` with the same record present (other provider must not inherit the flag); and with the record's `vision: false` the image block is replaced by `[image omitted: model has no vision support]`.
    Observable: `vision` field of the resolved capabilities and the content blocks after `stripUnsupportedModalities`.
    Boundary: `getCapabilitiesForModel` as called by `open-sse/handlers/chatCore.js` before translation; live: `POST /v1/messages` model `bifrost/glm-5.3` with the quadrant PNG.
  - Invariant: every write path keeps the in-memory index in sync without a restart.
    Positive witness: after `PATCH /api/models/custom` with `caps: { vision: false }`, the next `getCapabilitiesForModel` call returns `vision: false` with no explicit reload in the test.
    Negative control: after `DELETE /api/models/custom` the override is gone (`vision` back to the pattern value `false`); a stale index would still return `true`.
    Observable: resolved `vision` value immediately after each route call.
    Boundary: `src/app/api/models/custom/route.js` POST/PATCH/DELETE handlers.
  - Mechanical: existing custom models without `caps` change nothing.
    Invariant: full test suite has no pass→fail transition versus `master`.
    Observable: per-test status diff of two `vitest --reporter=json` runs.
    Boundary: `tests/` suite.

