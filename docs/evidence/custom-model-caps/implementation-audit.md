PASS

1. Goal and behavioural contract

Contract met.

- `open-sse/providers/capabilities.js:744-747` resolves catalog/table capabilities first, then applies custom flags last. Browser-safe module gains no server import.
- `src/lib/customModelCaps.js:29-60` indexes only boolean `CAPACITY_META` keys, uses nested `Map`s, canonicalizes built-in aliases, and publishes node-prefix seats only when `resolvePrefixNode()` resolves that exact node.
- `src/lib/customModelCaps.js:24-26,65` handles thinking suffixes before map lookup.
- `src/app/api/models/custom/route.js:42-92` refreshes index after POST, PATCH, DELETE. Node PUT/DELETE and DB import refresh at `src/app/api/provider-nodes/[id]/route.js:77-98` and `src/app/api/settings/database/route.js:34-35`.
- Compatible-node UI passes stored caps and renders toggles only for custom rows: `CompatibleModelsSection.js:58-69,202-214`.

2. Correctness, regressions, architecture, wire contracts

No blocker found.

- Prior collision class closed. Search run: `(?:setCustomCapsSource|reloadCustomModelCaps|installCustomModelCaps|__9rCustomCapsIndex)` and custom source code show insert/lookup use nested provider/model `Map`s at `src/lib/customModelCaps.js:40-60,65`; no joined capability-index key remains.
- Writer search run: `(?:addCustomModel|updateCustomModelCaps|deleteCustomModel|importDb|customModels)`. Production custom-model writers refresh index. Legacy migration occurs before startup load.
- `updateCustomModelCaps()` atomically reads, merges supplied sanitized flags, writes, and reports absence at `src/lib/db/repos/aliasRepo.js:55-67`.
- Prefix resolver extraction preserves prior reserved-prefix and OpenAI→Anthropic→embedding duplicate precedence at `src/sse/services/model.js:22-30,64-70`.
- Tests cover cross-module source state, built-in aliases, thinking suffixes, prefix seats, reserved/duplicate prefixes, separator-bearing IDs, node rename/delete, DB import, PATCH validation, and modality stripping.
- Docker compose default now selects `rg.nl-ams.scw.cloud/onara/9router:fork` and `router.onara.eu` at `docker-compose.override.yml:44,64`. No custom-capability code path depends on either setting. Non-blocking documentation drift: deployment instructions still name `apollo.mittelstaedts.com` at `:9,12`.

3. Security and privacy delta

No security blocker. Security delta: no.

- New PATCH remains under deny-by-default `/api/*` protection in `src/dashboardGuard.js:216-223`.
- `sanitizeCaps()` permits only boolean `vision` and `reasoning` at `src/app/api/models/custom/route.js:8-15`; store reload repeats filtering before global publication at `src/lib/customModelCaps.js:51-54`.
- Global index holds provider/model IDs plus capability booleans. No credential, token, connection secret, or API key enters it.
- Compose host/image defaults change deployment selection, not exposed ports, Traefik TLS configuration, forwarded-header trust, or authentication policy.

4. Verification adequacy

Evidence reviewed.

- `docs/evidence/custom-model-caps/qa-api.txt` records default image request rerouting, immediate Vision ON/OFF behavior, correct quadrant answer on Bifrost, `/v1/models` capability advertisement, PATCH 404/400 boundaries, and text-only regression.
- `docs/evidence/custom-model-caps/implementation-audit.md` and supplied matrix report 3600 pass / 239 pre-existing failures with zero pass-to-fail transition.
- Tests inspect actual route/store/capability behavior, not only mocked UI prose.
- Residual process risk: current `docs/evidence/custom-model-caps/merge-gate.json:5` binds `reviewed_sha` `5260551d…`, not reviewed head `66d676d2…`. Rebind record and trailer after this audit before merge. QA artifact remains valid for feature source only per supplied byte-identity assertion; compose default change lacks a rendered `docker compose config` artifact.

5. Final

PASS

REVIEW-TRAILER-v1
invocation: implementation-audit
sections_covered: 1, 2, 3, 4, 5
model_id: onara/cx/gpt-5.6-terra
security_delta: no
verdict: PASS
adversarial_criteria:
- invariant: Deployment host selection remains operator-configurable after default-domain switch; explicit `NINEROUTER_HOST` must replace the default host in the Traefik router rule.
  positive_witness: Rendering Compose with `NINEROUTER_HOST=staging.example` produces `Host(\`staging.example\`)`, while unset configuration produces `Host(\`router.onara.eu\`)`.
  negative_control: A hard-coded `router.onara.eu` rule ignores explicit `NINEROUTER_HOST=staging.example`; this MUST fail.
  observable: Rendered `docker compose config` value of `traefik.http.routers.9router.rule`.
  boundary: Docker Compose environment interpolation before Traefik router configuration.
END-REVIEW-TRAILER