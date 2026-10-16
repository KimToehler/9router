Bottom line: Architecture holds under explicit rule that `anthropic-compatible-*` determines Anthropic thinking wire contract. Central override sits at correct capability boundary, preserves native providers and Claude-native formats, and matches supplied runtime evidence. Main residual risk is broad non-GLM applicability; intentional scope makes it non-blocking, but GLM/Bifrost is sole live witness.

1. **Architecture**
   - `applyTransportThinkingContract` runs after model/provider resolution and before custom flags in `open-sse/providers/capabilities.js:754-772`. Exact `anthropic-compatible-` predicate prevents static provider spillover.
   - Central placement is coherent: `applyThinking` and `resolveFormat` consume it in `open-sse/translator/concerns/thinkingUnified.js:130-147,431-450`; `getThinkingLevels` consumes it in `open-sse/providers/thinkingLevels.js:97-113`; `prepareClaudeRequest` uses same capabilities in `open-sse/translator/formats/claude.js:505-545`.
   - Claude-native formats remain exempt. Native Z.AI and Claude adaptive guards pass in `tests/unit/anthropic-compatible-thinking-contract.test.js:76-97`.
   - Capture and live evidence at reviewed SHA prove disabled, explicit budget, effort conversion, signed thinking, and replay across actual HTTP boundaries.

2. **Structural miss**
   - Line-level audit lists consumers but underplays semantic coupling inside capability object. Change replaces not only wire encoder `thinkingFormat`, but also model semantics `thinkingCanDisable` and `thinkingRange`. For always-thinking non-Claude families, transport compatibility now overrides model-level inability to disable.
   - Resolver also drives product presentation. `/v1/models` publishes resolved capabilities through `buildModelsList` in `src/app/api/v1/models/route.js`, while dashboard picker calls `getThinkingLevels(providerId, modelId)` in `src/app/(dashboard)/dashboard/providers/[id]/page.js:183-197`. This is intended, but blast radius exceeds outbound translation.
   - Custom flags merge last. Today `src/lib/customModelCaps.js` restricts them to vision/reasoning, so safe. Future thinking-related custom flags could silently override transport contract unless precedence is reconsidered.

3. **Highest-impact production failure**
   - Worst plausible failure: non-GLM models behind dynamic Anthropic nodes reject or ignore `{type:"disabled"}` or Anthropic budgets after known vendor constraints are cleared. That could create broad 400s or silently change reasoning behavior across DeepSeek, Kimi, Qwen, Gemini, and OpenAI-family models.
   - Addressed structurally by explicit node-type contract, one uniform non-Claude branch, exact prefix isolation, and Bifrost proof that gateway semantics can differ from native model rules. Not addressed empirically beyond GLM/Bifrost. Given approved scope defines Anthropic-compatible nodes as owning this contract, this remains rollout risk rather than implementation blocker.
   - More catastrophic leakage into static `glm` or Claude-native adaptive models is directly addressed by prefix and format exemptions plus regression guards.

4. **Auditor findings**
   - No false positive. GLM-only runtime coverage is a real evidence limit.
   - Missing `openai-compatible-*` exclusion test is a valid non-blocking guard suggestion, not evidence of changed behavior. Exact changed predicate excludes that prefix; treating omission as an active regression would be false.
   - Non-stream reasoning-content stripping is unchanged and correctly classified outside this diff.

**Action plan**
1. Store trailer against reviewed SHA `e1d827da2a33290ba43e1611253bd1affe9b9602`.
2. Validate full merge-gate record with current plan and both reviewer trailers.
3. Non-blocking: when another vendor family is deployed through an Anthropic-compatible node, capture one disabled and one budget request before assuming identical runtime semantics.

**Effort:** Quick (<1h) for optional generic guard; no code fix required.

**Confidence:** Medium — source architecture and GLM evidence are strong; generic non-GLM runtime contract lacks independent live witness.

**Watch out for:**
- Gateways implementing Anthropic Messages generally but not Anthropic extended-thinking semantics.
- Future custom capability fields overriding transport normalization because custom merge remains last.
- User-visible picker/API capability changes being broader than request translation.

**Security:** No security delta. Diff moves no credential, PII, header, persistence field, or data class to a new recipient; it changes in-memory request-shape selection for the same configured upstream.

REVIEW-TRAILER-v1
invocation: strategic-risk-review
sections_covered: 1,2,3,4
model_id: onara/cx/gpt-5.6-sol
security_delta: no
verdict: PASS
adversarial_criteria:
- invariant: Transport normalization must not manufacture reasoning support for an unknown non-reasoning model merely because its provider ID is anthropic-compatible.
  positive_witness: An unknown text model with default reasoning false strips stray thinking controls and remains advertised as non-reasoning.
  negative_control: A transport-wide override assigns claude-budget or reasoning support to every model, forwarding thinking fields for an unknown model.
  observable: Published reasoning capability remains false and captured upstream JSON contains no thinking, reasoning_effort, enable_thinking, or thinking_budget field.
  boundary: Capability resolution through outbound Anthropic Messages request preparation.
END-REVIEW-TRAILER