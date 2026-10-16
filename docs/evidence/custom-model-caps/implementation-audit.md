PASS

1. Goal and behavioural contract

Contract met.

- `open-sse/providers/capabilities.js:744-747` resolves table/catalog caps first, then applies custom flags last. No server import enters browser-safe module.
- `src/lib/customModelCaps.js:41-50` admits only boolean `vision`/`reasoning`, keys built-ins by canonical ID, and adds compatible-node prefix seats only when `resolvePrefixNode()` says routing owns that prefix.
- Thinking suffix handling at `src/lib/customModelCaps.js:22-26` preserves override for `model(high)`.
- Capacity adapter prefix-seat path uses same resolver outcome. `tests/unit/custom-model-caps-store.test.js:166-184` distinguishes retaining Bifrost seat from prepending fallback.
- Compatible-node row toggles render only for `source === "custom"` at `CompatibleModelsSection.js:58-69,202-214`; PATCH stores by node ID at provider page `:584-600`.

2. Correctness, regressions, architecture, wire contracts

No blocker found.

- Cross-chunk state fixed. Installed source reads `globalThis.__9rCustomCapsIndex`; reload replaces global map. Separate-module-copy regression test at `tests/unit/custom-model-caps-store.test.js:79-90`.
- Prior class `collision-prone raw concatenated capability-index key` closed. Search run: `(?:setCustomCapsSource|reloadCustomModelCaps|installCustomModelCaps|__9rCustomCapsIndex)`. Capability-index insert at `src/lib/customModelCaps.js:46-50`; lookup at `:65`; both use nested `Map`, no joined provider/model key remains.
- Writer search run: `(?:addCustomModel|updateCustomModelCaps|deleteCustomModel|importDb|customModels)`. Index refresh covers custom-model POST/PATCH/DELETE at `src/app/api/models/custom/route.js:49,72,91`; node rename/delete at `src/app/api/provider-nodes/[id]/route.js:78,98`; DB import at `src/app/api/settings/database/route.js:35`.
- `updateCustomModelCaps()` transaction merges only supplied sanitized flags and preserves sibling flags at `src/lib/db/repos/aliasRepo.js:55-67`.
- Capability caller search run: `getCapabilitiesForModel\(`. Chat-core uses routed node ID; capacity adapter and combo use seat prefix; `/v1/models` uses provider ID. Both lookup forms have index entries.
- `resolvePrefixNode()` extraction preserves prior reserved-prefix and duplicate-prefix precedence at `src/sse/services/model.js:22-30,64-70`. Tests cover reserved aliases, duplicate prefixes, separator-bearing IDs, rename, delete, and import replacement.
- No obsolete alias path found. `resolvePrefixNode()` has two live consumers: routing and custom-cap index.

3. Security and privacy delta

No security blocker. Security delta: no.

- New PATCH stays behind deny-by-default `/api/*` protection at `src/dashboardGuard.js:216-223`. Diff adds no public-path exemption, CORS change, auth bypass, or secret-bearing response.
- `src/app/api/models/custom/route.js:8-15` whitelists capability names and boolean values. Imported/stored unknown `caps` fields are also dropped before source publication by `src/lib/customModelCaps.js:41-44`.
- New global state contains model IDs and two booleans only. No credentials, connection data, or keys enter it.
- Reviewed QA transcript and dashboard image. Transcript marks Bifrost and 9router keys redacted; image contains model/toggle UI only.

4. Verification adequacy

Evidence sufficient.

- Pure tests cover default table result, provider isolation, preserved table fields, and explicit capability OFF.
- Store tests cover node-ID lookup, built-in alias lookup, suffix stripping, real modality stripping, POST/PATCH/DELETE refresh, retained sibling flag, invalid/unknown PATCH, prefix-seat adapter behaviour, reserved/duplicate prefixes, separator collision, node rename/delete, and DB-import replacement.
- Supplied automated evidence reports 3600 pass / 239 pre-existing fail, zero pass-to-fail against master.
- Reviewed `docs/evidence/custom-model-caps/qa-api.txt`: Vision off routes image request to fallback; Vision on routes Bifrost `glm-5.3`, returns expected quadrants, and advertises Vision plus 1M/128k limits; immediate Vision off reverts routing; text-only request remains direct.
- Reviewed `docs/evidence/custom-model-caps/qa-dashboard-toggle.webp`: `bifrost/glm-5.3` row renders Vision on and Reasoning off toggles. Transcript records persistence across reload.
- Residual non-blocking gap: no test explicitly imports a custom-model record containing extra non-capability `caps` fields. Static filtering at `src/lib/customModelCaps.js:41-44` covers it.

5. Final

PASS

REVIEW-TRAILER-v1
invocation: implementation-audit
sections_covered: 1, 2, 3, 4, 5
model_id: onara/cx/gpt-5.6-terra
security_delta: no
verdict: PASS
adversarial_criteria:
- invariant: Persisted or imported custom-model `caps` fields outside `CAPACITY_META` must never change resolved token limits, formats, or unrelated capabilities.
  positive_witness: Importing a record with `{ vision: true, contextWindow: 1, maxOutput: 1 }` resolves Vision true while retaining catalog/table `contextWindow` and `maxOutput`.
  negative_control: If unfiltered persisted fields reach custom-source merge, `contextWindow: 1` or `maxOutput: 1` changes routing limits; this MUST fail.
  observable: Resolved `vision`, `contextWindow`, and `maxOutput` from `getCapabilitiesForModel` after database import.
  boundary: `reloadCustomModelCaps()` field filtering before `setCustomCapsSource()` exposes global index to capability resolution.
END-REVIEW-TRAILER