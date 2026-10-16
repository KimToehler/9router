PASS

1. Goal and behavioural contract

Custom flags apply after table/catalog resolution in `open-sse/providers/capabilities.js:744-747`. Server-only DB index filters stored flags to `CAPACITY_META` boolean keys in `src/lib/customModelCaps.js:41-44`. It keys compatible-node records by node ID and, when routing owns prefix, by prefix seat at `:48-50`.

Capacity adapter sees prefix seat before node resolution. `src/lib/customModelCaps.js:35-38` uses shared `resolvePrefixNode()` rule. `src/sse/services/model.js:22-30` preserves prior built-in-reserved and duplicate-prefix precedence.

Compatible-node UI passes stored `caps`, renders only custom-row toggles, PATCHes node-ID storage alias, then refetches. Evidence: `CompatibleModelsSection.js:58-69,202-214`; provider page `:584-600`.

2. Correctness, regressions, architecture, wire contracts

No blocker found.

- Browser-safe capability module retains no server import. Startup installs source after catalog source: `src/instrumentation.js:7-15`.
- Cross-chunk state handled: source reads `globalThis.__9rCustomCapsIndex`; reloader replaces same global map. Regression test covers install/reload from separate module copies: `tests/unit/custom-model-caps-store.test.js:79-91`.
- Thinking suffix stripping matches intended terminal-parenthesis form: `src/lib/customModelCaps.js:22-26`.
- Write-path search run: `(?:addCustomModel|updateCustomModelCaps|deleteCustomModel|scope = 'customModels'|scope: "customModels")`. Changed custom-model POST/PATCH/DELETE reload at `src/app/api/models/custom/route.js:49,73,91`; node PUT/DELETE reload at `src/app/api/provider-nodes/[id]/route.js:78,98`; DB import reload at `src/app/api/settings/database/route.js:35`. No open stale-index class found in changed writer sites.
- Capability-caller search run: `getCapabilitiesForModel\(`. Relevant routing consumers include chat-core, capacity adapter, combo ordering, and thinking translation. Prefix-seat test covers adapter outcome; node-ID tests cover routing-capability outcome.
- `updateCustomModelCaps()` is transactional and merges only supplied valid flags with existing stored flags: `src/lib/db/repos/aliasRepo.js:55-67`. PATCH returns 404 before reload for absent row, matching contract.

3. Security and privacy delta

No security blocker. `security_delta: no`.

New PATCH endpoint remains under deny-by-default `/api/*` authentication in `src/dashboardGuard.js:219-223`; no new public-path or local-only bypass added. Route whitelists capability keys and booleans at `src/app/api/models/custom/route.js:8-15`, preventing arbitrary stored fields from entering routing source. QA artifact redacts Bifrost and 9router keys. No secret appears in reviewed changed source or supplied QA transcript.

Security note: this conclusion depends on existing dashboard proxy deployment. Direct route invocation outside Next proxy remains pre-existing architecture, not introduced by this diff.

4. Verification adequacy

Reviewed:
- Pure override tests: provider isolation, preserved table fields, explicit OFF override.
- Store tests: module-copy sharing, node-ID and built-in alias keys, suffixes, PATCH/POST/DELETE refresh, retained sibling flag, invalid/unknown PATCH, prefix seats, reserved aliases, duplicate prefixes, rename.
- QA transcript at `docs/evidence/custom-model-caps/qa-api.txt`: observed Bifrost fallback with Vision off; direct `glm-5.3` route and quadrant result with Vision on; immediate off transition; `/v1/models` limits and vision fields; PATCH error cases; text-only regression.
- Dashboard artifact `docs/evidence/custom-model-caps/qa-dashboard-toggle.webp`: Vision on and Reasoning off switches rendered for `bifrost/glm-5.3`.

Residual verification risk, non-blocking: supplied automated tests do not directly exercise database-import replacement or provider-node deletion after an installed index. Code reloads both paths. Supplied evidence states full-suite no pass-to-fail transition, but no independent command was run in this read-only audit.

5. Final

No blocking defect found.

REVIEW-TRAILER-v1
invocation: implementation-audit
sections_covered: 1, 2, 3, 4, 5
model_id: onara/cx/gpt-5.6-terra
security_delta: no
verdict: PASS
adversarial_criteria:
- invariant: A successful database import replacing custom models must replace, not retain, every installed node-ID and prefix-seat capability entry.
  positive_witness: Importing a backup with no flagged `bifrost/glm-5.3` record makes both node-ID and `bifrost` seat resolve table Vision false immediately after `POST /api/settings/database` returns.
  negative_control: A stale global index leaves either lookup Vision true and prevents capacity-adapter fallback; this MUST fail.
  observable: Resolved `vision` values and `augmentModelsWithCapacityAdapter(["bifrost/glm-5.3"], new Set(["vision"]), settings)` candidate order after import.
  boundary: `src/app/api/settings/database/route.js` import completion through `reloadCustomModelCaps()` into `globalThis.__9rCustomCapsIndex`.
END-REVIEW-TRAILER