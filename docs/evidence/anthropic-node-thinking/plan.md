# Anthropic thinking contract on dynamic anthropic-compatible-* nodes

## Context
Model `bifrost/glm-5.3` is served by a dynamic node `anthropic-compatible-<id>` (Anthropic Messages, `/messages`). The global capability pattern `*glm-5.3*` (`thinkingFormat: "zai"`, `thinkingCanDisable: false`, `thinkingEffortSupported: true`) also applies to that node. As a result, `applyThinking` rewrites every request to the Z.AI shape `thinking:{type:"enabled"}` + `reasoning_effort`, and this affects Claude→Claude requests too. The effects: `disabled` gets dropped, `budget_tokens` gets dropped, and OpenAI effort never becomes a budget.

Fix: on dynamic Anthropic-compatible nodes, a non-Claude vendor thinking format coming from a model rule is replaced by the Anthropic budget contract. Static vendor providers stay unchanged: `glm`, `kimi`, `deepseek`, `minimax`, `opencode-go`, etc. legitimately send vendor formats on their own Claude transports. Native Z.AI must not regress.

Reproduced pre-fix in the planning session with `translateRequest`, provider `anthropic-compatible-t`, model `glm-5.3`:
- claude→claude `thinking:{type:"disabled"}` → `{"thinking":{"type":"enabled"},"reasoning_effort":"low"}`
- claude→claude `{type:"enabled",budget_tokens:2048}` → `{"thinking":{"type":"enabled"},"reasoning_effort":"low"}`
- openai→claude `reasoning_effort:"low"` / `"max"` → `{"thinking":{"type":"enabled"},"reasoning_effort":"low"|"max"}`
- `getThinkingLevels("anthropic-compatible-t","glm-5.3")` → `["thinking"]`

Live direct probes against `https://bifrost.yorizon-prod.ai.advisori-apps.de/api/v1/messages` (model `glm-5.3`, all HTTP 200):
- `thinking:{type:"disabled"}` returns only a text block.
- `{type:"enabled",budget_tokens:1024}` returns a signed thinking block plus text.
- The Z.AI shape `{type:"enabled"}` + `reasoning_effort:"low"` returns a thinking block. This is why the bug is visible in production.
- `thinking.display:"summarized"` is accepted.
- `max_tokens:128000` + `budget_tokens:126976` is accepted.
- Replay turn after `[thinking(signed), tool_use]` + `tool_result` succeeds (200) in five variants: original signature, `DEFAULT_THINKING_CLAUDE_SIGNATURE`, signature removed, garbage signature, and thinking block dropped. Bifrost does not validate replayed signatures.

## Approach

### 0. Worktrees and dependencies
Run from `/Users/tim/git/9router`:
```bash
git worktree add .worktrees/anthropic-node-thinking -b fix/anthropic-node-thinking-contract master
git worktree add --detach .worktrees/anthropic-node-thinking-baseline master
for w in anthropic-node-thinking anthropic-node-thinking-baseline; do
  ln -s /Users/tim/git/9router/node_modules .worktrees/$w/node_modules
  ln -s /Users/tim/git/9router/tests/node_modules .worktrees/$w/tests/node_modules
done
```
- Root `.gitignore` has `/node_modules` and `.worktrees/`. `tests/.gitignore` allows `tests/node_modules`. The symlinks therefore stay untracked; confirm with `git -C .worktrees/anthropic-node-thinking status --short`, which must be empty.
- All edits, tests, and commits happen in `.worktrees/anthropic-node-thinking`. The baseline worktree is read-only and is used only for negative controls.
- Copy this plan to `.worktrees/anthropic-node-thinking/docs/evidence/anthropic-node-thinking/plan.md`. All evidence for this task goes into that directory; it follows the convention of `docs/evidence/custom-model-caps/`.
- Run the plan gate once:
  ```bash
  node /Users/tim/git/oh-my-openagent/packages/shared-skills/skills/review-work/scripts/validate-gate-record.mjs --plan-only --plan <abs path to docs/evidence/anthropic-node-thinking/plan.md> --repo /Users/tim/git/9router/.worktrees/anthropic-node-thinking
  ```
  It must exit 0. If it complains about a criterion field, fix the field wording in both copies of the plan and do not drop the criterion.

### 1. RED: regression test first
Create `tests/unit/anthropic-compatible-thinking-contract.test.js`. Imports follow the style of `tests/unit/claude-opus-5-5.test.js`:
- `translateRequest` from `../../open-sse/translator/index.js`
- `FORMATS` from `../../open-sse/translator/formats.js`
- `LEVEL_TO_BUDGET` from `../../open-sse/translator/concerns/thinking.js`
- `getThinkingLevels` from `../../open-sse/providers/thinkingLevels.js`
- the side-effect import `"../translator/registerAll.js"`

Constants: `const NODE = "anthropic-compatible-thinking-test";` and a helper `run(source, provider, body)` that calls `translateRequest(source, FORMATS.CLAUDE, "glm-5.3", { model: "glm-5.3", messages: [{ role: "user", content: "hi" }], ...body }, false, null, provider)`.

Cases, all asserted on the returned body:
1. **claude→claude disabled** (`NODE`, `{ thinking: { type: "disabled" } }`):
   - `out.thinking` toEqual `{ type: "disabled" }`
   - `out` not.toHaveProperty `reasoning_effort`
   - `out` not.toHaveProperty `enable_thinking`
2. **claude→claude explicit budget** (`NODE`, `{ max_tokens: 4096, thinking: { type: "enabled", budget_tokens: 2048 } }`):
   - `out.thinking` toEqual `{ type: "enabled", budget_tokens: 2048 }`
   - no `reasoning_effort`
3. **openai→claude effort** (`FORMATS.OPENAI` source, `NODE`, `{ reasoning_effort: "low" }` and `{ reasoning_effort: "max" }`). For both:
   - `thinking.type === "enabled"`, `thinking.budget_tokens > 0`, no `reasoning_effort`, and `thinking.budget_tokens < max_tokens`
   - low: `budget_tokens === LEVEL_TO_BUDGET.low`
   - max: `budget_tokens > low.budget_tokens`

   Do not pin max's exact value. `prepareClaudeRequest` reconciles it against `max_tokens`; the value is 126976 today.
4. **native Z.AI unchanged** (provider `"glm"`):
   - (a) `translateRequest(FORMATS.OPENAI, FORMATS.OPENAI, "glm-5.3", {model, messages, reasoning_effort:"low"}, false, null, "glm")`:
     - `thinking` toEqual `{type:"enabled"}`
     - `reasoning_effort === "low"`
   - (b) claude→claude with `run(FORMATS.CLAUDE, "glm", { thinking:{type:"disabled"} })`:
     - `thinking` toEqual `{type:"enabled"}`
     - `reasoning_effort === "low"`
     - `enable_thinking` undefined

     This is the documented Z.AI Anthropic-transport contract: `glm.js` transport `format:"claude"` plus capabilities `zai` with `thinkingCanDisable:false` (#4409, `tests/unit/glm53-thinking-cannot-disable.test.js`). Disabled is clamped to minimal, which becomes `low`.
5. **Claude-native formats on a node untouched**: `translateRequest(FORMATS.CLAUDE, FORMATS.CLAUDE, "claude-opus-5-5", {model:"claude-opus-5-5", messages, thinking:{type:"disabled"}}, false, null, NODE)`:
   - `out.thinking?.type` not "disabled"
   - `out.output_config.effort === "low"`

   `claude-adaptive` with `thinkingCanDisable:false` from `MODEL_CAPABILITIES["claude-opus-5-5"]` must survive. Opus 5.5 answers 400 to disabled.
6. **thinking replay** (`NODE`, claude→claude). Body:
   ```js
   {
     max_tokens: 4096,
     thinking: { type: "enabled", budget_tokens: 2048 },
     tools: [{ name: "calc", description: "d", input_schema: { type: "object", properties: { expr: { type: "string" } } } }],
     messages: [
       { role: "user", content: "compute" },
       { role: "assistant", content: [
         { type: "thinking", thinking: "plan the call", signature: "sig-upstream" },
         { type: "tool_use", id: "toolu_1", name: "calc", input: { expr: "1+1" } }
       ] },
       { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "2" }] }
     ]
   }
   ```
   Assert:
   - The assistant message content types equal `["thinking","tool_use"]`.
   - `content[0].thinking === "plan the call"`.
   - `typeof content[0].signature === "string"` and it is non-empty.
   - `content[1].id === "toolu_1"`.
   - `out.thinking` toEqual `{ type: "enabled", budget_tokens: 2048 }`.
   - No `reasoning_effort`.

   Do not assert the signature value. `prepareClaudeRequest` (open-sse/translator/formats/claude.js:649-653) deliberately substitutes `DEFAULT_THINKING_CLAUDE_SIGNATURE` on anthropic-compatible nodes, and Bifrost accepts it (see Context).
7. **level picker**: `getThinkingLevels(NODE, "glm-5.3")` toEqual `["none","low","medium","high","xhigh","max"]`. That is the `claude-budget` set in `open-sse/providers/thinkingLevels.js`. The dashboard model picker reads it.

Run RED before touching source:
```bash
cd .worktrees/anthropic-node-thinking/tests && npx vitest run unit/anthropic-compatible-thinking-contract.test.js 2>&1 | tail -40 > ../docs/evidence/anthropic-node-thinking/qa-red.txt
```
- Expected: cases 1, 2, 3, 6, 7 fail; cases 4 and 5 pass, because they are guards.
- If case 4 or 5 fails pre-fix, the assertion is wrong. Re-read the code path and correct the assertion to the current behaviour before continuing, because those cases must stay unchanged.

### 2. Fix: transport-aware thinking contract in capability resolution
File: `open-sse/providers/capabilities.js`.

Wrap the resolved result inside `getCapabilitiesForModel` (line ~744) before the custom-flag merge, so every consumer sees one contract: `applyThinking`, `resolveFormat`, `getThinkingLevels`/dashboard picker, and `prepareClaudeRequest`.
```js
export function getCapabilitiesForModel(provider, model) {
  const resolved = applyTransportThinkingContract(provider, resolveCapabilities(provider, model));
  const custom = provider && model ? getCustomCapsSource()?.get(provider, model) : null;
  return custom ? { ...resolved, ...custom } : resolved;
}
```

Add directly above it:
```js
// Dynamic anthropic-compatible-* nodes speak plain Anthropic Messages whatever
// weights sit behind them. A vendor thinking format from a model rule (z.ai's
// thinking+reasoning_effort for *glm-5.3*, deepseek, kimi, qwen, openai, ...)
// describes that vendor's own API, not the node's: on these nodes the Anthropic
// budget contract applies (thinking.type disabled | enabled + budget_tokens).
// Claude-native formats stay as resolved, so a Claude model behind a gateway
// keeps adaptive thinking and its can-disable limits.
const CLAUDE_THINKING_FORMATS = new Set(["claude-budget", "claude-adaptive"]);
const ANTHROPIC_MESSAGES_THINKING = {
  thinkingFormat: "claude-budget",
  thinkingCanDisable: true,
  thinkingEffortSupported: false,
  thinkingRange: null,
};

function applyTransportThinkingContract(provider, caps) {
  if (!provider?.startsWith?.("anthropic-compatible-")) return caps;
  if (!caps.thinkingFormat || CLAUDE_THINKING_FORMATS.has(caps.thinkingFormat)) return caps;
  return { ...caps, ...ANTHROPIC_MESSAGES_THINKING };
}
```

Notes:
- Use the inline `provider?.startsWith?.("anthropic-compatible-")` check, which is the existing pattern in `open-sse/executors/base.js:37`, `default.js:152`, and `translator/formats/claude.js:505`. Do not import `src/shared/constants/providers.js`, which would pull the registry into `open-sse`. Do not import `open-sse/providers/shared.js`, which imports `os`. `capabilities.js` is also bundled into the dashboard, so it must stay import-free beyond `pricing.js`/`visionPatterns.js`.
- `thinkingFormat: null` already falls back to `FORMAT_TO_NATIVE.claude = "claude-budget"` in `thinkingUnified.js` `resolveFormat`, so leaving it alone is correct.
- `resolveCapabilities` keeps its four-step lookup unchanged.
- Extend the header comment block at the top of the file (lines 9-25, "Two extra layers then refine the result") by one bullet: "• dynamic anthropic-compatible-* nodes: non-Claude thinking formats are replaced by the Anthropic budget contract (applyTransportThinkingContract) before the user's custom flags apply."
- Leave unchanged: `thinkingUnified.js`, `translator/index.js`, `formats/claude.js`, the static `PROVIDER_CAPABILITIES`, and every registry file. No schema/UI/DB change; `customModelCaps` (vision/reasoning only) is unaffected and still merges last.
- `openai-compatible-*` nodes are out of scope. They speak OpenAI wire, where vendor formats are a separate question.

### 3. Adjust the existing test that pinned the old behaviour
`tests/unit/custom-model-caps.test.js` line 24 `expect(caps.thinkingFormat).toBe("zai");` asserts on `anthropic-compatible-x` + `glm-5.3`, which is the buggy contract. It is incidental to that test, which is about vision flags; line 23 `contextWindow` already proves the other fields survive. Delete line 24 and do not re-pin it. No other test asserts thinking on an `anthropic-compatible-*` provider: the planning grep found only header, URL, and stream-response tests.

### 4. GREEN + suites
From `.worktrees/anthropic-node-thinking/tests`:
```bash
npx vitest run unit/anthropic-compatible-thinking-contract.test.js unit/glm53-thinking-cannot-disable.test.js unit/custom-model-caps.test.js unit/custom-model-caps-store.test.js unit/claude-opus-5-5.test.js unit/opencode-go-claude-haiku-55-thinking.test.js unit/minimax-code.test.js translator/ 2>&1 | tail -30 > ../docs/evidence/anthropic-node-thinking/qa-green-focused.txt
```
All tests in the new file and in the glm/custom-caps files must pass.

Full-suite regression, a pass→fail diff against master:
```bash
(cd /Users/tim/git/9router/.worktrees/anthropic-node-thinking-baseline/tests && npx vitest run --reporter=json --outputFile=/tmp/9r-thinking-base.json >/dev/null 2>&1)
(cd /Users/tim/git/9router/.worktrees/anthropic-node-thinking/tests && npx vitest run --reporter=json --outputFile=/tmp/9r-thinking-fix.json >/dev/null 2>&1)
```
- Do not use `tests/__baseline__/verify-no-regression.mjs`. It keys tests by `name.split("/app/")[1]`, a Docker path, and yields `undefined` for local checkouts.
- Instead, write a throwaway `/tmp/9r-thinking-diff.mjs`:
  - Build the map `<path relative to tests/> :: <fullName>` → status for both JSON files.
  - Print every key that is `passed` in base and not `passed` in fix, plus counts.
  - Exit 1 if any such key exists.
- Save its output to `docs/evidence/anthropic-node-thinking/qa-suite-diff.txt`. It must list zero pass→fail entries. Expect about 64 known failures on both sides; tests that are new in fix are allowed.

Commit in the worktree, staging explicit paths only:
```bash
git add open-sse/providers/capabilities.js tests/unit/anthropic-compatible-thinking-contract.test.js tests/unit/custom-model-caps.test.js
git commit -m "fix(capabilities): apply Anthropic thinking contract on anthropic-compatible nodes"
```
The commit message has no Co-Authored-By line.

### 5. Runtime smoke (real HTTP surface, after the code commit)
Prerequisites:
- `BIFROST_API_KEY`. The user supplied a temporary key during planning. It is held in the Python eval kernel global `_K` if that kernel survived; otherwise ask the user for it.
- Pass it only through the process environment or Python `urllib` request bodies. Never print it, put it on a command line, write it to a file, or commit it.
- Start every server with `ENABLE_REQUEST_LOGS=false`, because `open-sse/utils/requestLogger.js` writes unmasked headers when this is enabled.

Services. Run as named long-lived bash services, `ready` on the port:
- Capture upstream on 20190: a throwaway `/tmp/9r-capture.py` using `http.server`.
  - On `POST /v1/messages` it appends the JSON request body only, never headers, as one line to `/tmp/9r-capture-<label>.jsonl`, where `<label>` comes from the query string or a counter.
  - It answers `200` with `{"id":"msg_cap","type":"message","role":"assistant","model":"glm-5.3","content":[{"type":"text","text":"ok"}],"stop_reason":"end_turn","stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":1}}`.
- Fix server on 20191, from `.worktrees/anthropic-node-thinking`:
  ```bash
  DATA_DIR=/tmp/9r-thinking-fix JWT_SECRET=smoke-jwt INITIAL_PASSWORD=smoke-pass API_KEY_SECRET=smoke-aks MACHINE_ID_SALT=smoke-salt ENABLE_REQUEST_LOGS=false npx next dev --webpack --port 20191
  ```
- Baseline server on 20192: the same command from `.worktrees/anthropic-node-thinking-baseline`, with `DATA_DIR=/tmp/9r-thinking-base`.

If `next dev` fails to resolve modules through the symlinked `node_modules`, remove the symlink in that worktree and run `npm ci` there instead.

Per server, provision through a throwaway Python script, `/tmp/9r-smoke.py <port> <evidence-prefix>`. It reads the key from env and never prints it. Steps:
1. `POST /api/auth/login` with `{"password":"smoke-pass"}` and keep the cookie.
2. `PATCH /api/settings` with `{"requireApiKey":false}`.
3. `POST /api/provider-nodes` with `{"type":"anthropic-compatible","name":"Capture","prefix":"cap","baseUrl":"http://127.0.0.1:20190/v1"}`, then `POST /api/providers` with `{"provider":<node.id>,"apiKey":"capture-dummy","name":"cap"}`.
4. `POST /api/provider-nodes` with `{"type":"anthropic-compatible","name":"Bifrost","prefix":"bfx","baseUrl":"https://bifrost.yorizon-prod.ai.advisori-apps.de/api/v1"}`, then `POST /api/providers` with `{"provider":<node.id>,"apiKey":$BIFROST_API_KEY,"name":"bfx"}`.
5. All `/v1/*` calls send `User-Agent: 9r-smoke` (a Claude UA would trigger native passthrough per `open-sse/utils/clientDetector.js`) and `"stream": false`.

Capture scenarios (model `cap/glm-5.3`). Record the captured upstream `thinking`, `reasoning_effort`, `enable_thinking`, and `max_tokens`:
- C1 `/v1/messages` `{max_tokens:4096, thinking:{type:"disabled"}}`. Fix: `thinking == {"type":"disabled"}`, no `reasoning_effort`. Baseline: `{"type":"enabled"}` + `reasoning_effort:"low"`.
- C2 `/v1/messages` `{max_tokens:4096, thinking:{type:"enabled",budget_tokens:2048}}`. Fix: exactly `{"type":"enabled","budget_tokens":2048}`, no `reasoning_effort`.
- C3 `/v1/chat/completions` `reasoning_effort:"low"` and `"max"`. Fix: `thinking.type=="enabled"`, low `budget_tokens==1024`, max budget > 1024 and < `max_tokens`, no `reasoning_effort`.

Live Bifrost scenarios (model `bfx/glm-5.3`, prompt "Berechne 143/88 und erkläre kurz."):
- L1 `/v1/messages` disabled. Fix: HTTP 200, no content block of type `thinking`. Baseline: a `thinking` block is present, the negative control.
- L2 `/v1/messages` `budget_tokens:1024`, `max_tokens:4096`. Fix: HTTP 200, a `thinking` block with a non-empty `signature`.
- L3 `/v1/chat/completions` `reasoning_effort:"low"`. Fix: HTTP 200, non-empty `choices[0].message.reasoning_content`.
- L4 replay on the fix server:
  - Turn 1: `/v1/messages` with the `calc` tool, `budget_tokens:2048`, prompt "Think carefully about which expression to evaluate, then use the calc tool to compute (143/88)*17 - 3.". Retry up to 3× until the content has a `thinking` and a `tool_use` block.
  - Turn 2: send that assistant content back unchanged, followed by a user `tool_result` `"24.6249"`.
  - Expect HTTP 200 and `stop_reason:"end_turn"`.

The script writes per-scenario summaries to `docs/evidence/anthropic-node-thinking/qa-runtime-<fix|base>.txt`: status, block types, signature present yes/no, and captured body fields. Then grep those files for `bfk_`; the grep must return nothing.

Afterwards:
- Stop the services and remove `/tmp/9r-thinking-*`, `/tmp/9r-capture*`, and the throwaway scripts.
- Remove the baseline worktree with `git worktree remove .worktrees/anthropic-node-thinking-baseline`. If git refuses because of untracked `.next`/symlinks, delete the symlinks (`rm .worktrees/anthropic-node-thinking-baseline/node_modules .worktrees/anthropic-node-thinking-baseline/tests/node_modules`) and retry. If it still refuses, leave the worktree in place and report its `git status --short`. Do not use `--force` without asking the user.

### 6. Merge gate (review-work)
Follow `skill://review-work`, which reads the canonical `/Users/tim/git/oh-my-openagent/packages/shared-skills/skills/review-work/SKILL.md`.
- Mandatory class is `wire-contract-api`, so both `auditor` and `oracle` run, using the verbatim briefs with the diff (`git diff master...HEAD -- open-sse tests > /tmp/9r-thinking.diff`, then read it), the changed-file list, and the QA matrix from step 5.
- Store trailers and `merge-gate.json` (schema `omo.merge-gate/v2`) in `docs/evidence/anthropic-node-thinking/`.
- Stage the evidence by explicit paths and commit: `docs(evidence): anthropic-compatible thinking contract QA and gate`.
- Validate the full record with `--record ... --plan ... --repo /Users/tim/git/9router/.worktrees/anthropic-node-thinking`.
- A reviewer FAIL means fix, commit, re-run step 5 on the new head, and run a fresh review task.
- Do not merge into master and do not push.

## Critical files & anchors
- `open-sse/providers/capabilities.js` `getCapabilitiesForModel` (~744) / `resolveCapabilities` (~750): the single fix site.
- `open-sse/translator/concerns/thinkingUnified.js` `resolveFormat` (~130), `applyFormat` cases `claude-budget`/`zai` (~305-340): explain the resulting wire shapes; read only.
- `open-sse/translator/formats/claude.js` `prepareClaudeRequest` budget/max_tokens reconciliation (~533-545) and replay signature handling (~623-665): explain the case-3 max value and the case-6 signature; read only.
- `tests/unit/glm53-thinking-cannot-disable.test.js`: the native Z.AI contract that must stay green.
- `tests/unit/custom-model-caps.test.js:24`: the line to delete.

## Verification
- Step 1: `qa-red.txt` shows cases 1, 2, 3, 6, 7 failing on unmodified source.
- Step 4: the focused run is green, and `qa-suite-diff.txt` lists 0 pass→fail entries against master.
- Step 5:
  - Capture C1/C2/C3 show the exact Anthropic shapes on fix and the Z.AI shape on baseline.
  - Live L1 has no thinking block on fix and a thinking block on baseline.
  - L2 has a signed thinking block; L3 has reasoning_content; L4 turn 2 returns HTTP 200 end_turn.
  - Evidence files contain no `bfk_`.
- Report every changed file, each command, and the observed results.

## Assumptions & contingencies
- Thinking-replay signatures on anthropic-compatible nodes keep today's `DEFAULT_THINKING_CLAUDE_SIGNATURE` substitution. Live probes show Bifrost accepts real, default, missing, and garbage signatures. Preserving real signatures for all dynamic nodes is a separate behaviour change. If L4 fails on the fix server, stop and report it as a separate finding with the turn-2 status/body; do not widen this fix.
- The scope covers all non-Claude formats on `anthropic-compatible-*` nodes (user decision). Static vendor providers are unchanged.
- Commits go only on branch `fix/anthropic-node-thinking-contract` in the worktree (user decision). No merge, push, or deploy. Production (`router.onara.eu`) is not re-verified because it is not redeployed.
- `~/.omp/agent/models.yml` is not touched.
- The user invalidates the temporary Bifrost key after the task.

## Execution notes
- Code commit: e1d827da `fix(capabilities): apply Anthropic thinking contract on anthropic-compatible nodes`.
- RED (`qa-red.txt`): before the fix, cases 1, 2, 3, 6 and 7 failed and the three guards passed.
- Suite diff (`qa-suite-diff.txt`):
  - Base was 3937 tests (3598 passed); fix was 3945 (3606 passed). There were 0 pass→fail transitions and 8 new tests.
  - One test title embeds a runtime ISO timestamp (`upstream-cors-headers.test.js`), so the diff script normalizes ISO timestamps in keys. Without that, the test showed up as a spurious "missing".
  - Focused set (`qa-green-focused.txt`): 0 pass→fail. It has 164 failures, identical on master (`translator/` URL suites etc.).
- Runtime deps: the plan's symlinked `node_modules` failed under `next dev`. The main checkout's install lacked `@aws-sdk/credential-providers`, and the CSS loader failed. Per the contingency, the symlink was replaced by a real install. `package-lock.json` is git-ignored here, so `npm ci` refused; the main checkout's lockfile was copied in and `npm install` run.
- Capture port: the harness killed the capture service on 20190 after its output window, and the port stayed unbindable. Capture ran in-process on 20193 as node prefix `cap2` instead of `cap`.
- L3: `stream:true` returned reasoning_content (fix 130 chars; the baseline also had some, because Bifrost thinks by default under the Z.AI shape). `stream:false` drops `reasoning_content` on both trees whenever content is non-empty (`open-sse/handlers/chatCore/nonStreamingHandler.js:319-325`). That is pre-existing behaviour, unchanged here, and recorded as row L3n.
- L4 replay passed on the first attempt: turn 1 returned `[thinking(signed), tool_use]`, turn 2 returned HTTP 200 `end_turn`.
- The baseline worktree was removed after QA. The full Bifrost key appears in no evidence file (scanned by value).

## Final verification wave
- [x] F3. Whole-diff review: `integration-review` not needed: the change is one source module (`open-sse/providers/capabilities.js`) plus tests and evidence; tick with that reason
- [x] F1. Manual QA on the real surface, one evidence path per scenario, on the head after F3's last code commit: step 5 C1-C3 (`qa-runtime-fix.txt` / `qa-runtime-base.txt` capture lines) and L1-L4 (`qa-runtime-fix.txt`, L1 negative control in `qa-runtime-base.txt`)
- [x] F2. Merge gate: `review-work`, SHA-bound omo.merge-gate/v2 record validated

## Merge gate
- Author's risk assessment: The change rewrites the upstream thinking fields for every model on every dynamic anthropic-compatible node whose global rule names a non-Claude format (GLM, DeepSeek, Kimi, Qwen, MiniMax, GPT, Gemini behind an Anthropic gateway). A gateway that actually wanted the vendor shape would lose it. That is mitigated: such a gateway is by definition speaking Anthropic Messages, and Bifrost proves the Anthropic shape works. A too-broad match would break native vendor routes (z.ai rejects thinking disabled on GLM-5.3, #4409) or Claude-native models behind gateways (Opus 5.5 400s on disabled). Both are guarded by tests and by the provider-prefix check. No auth, secrets, or schema involved. The temporary API key is kept out of files and logs.
- Mandatory class: wire-contract-api
- Whole-diff review: not needed (one source module plus tests and evidence)
- Feature-specific criteria:
  - Invariant: on an anthropic-compatible-* node with Claude target, the client's thinking intent reaches the upstream as Anthropic thinking: disabled stays `{type:"disabled"}`, an explicit budget passes unchanged, OpenAI effort becomes `budget_tokens` via LEVEL_TO_BUDGET, and neither `reasoning_effort` nor `enable_thinking` is sent.
    Positive witness: captured upstream body for C1 is `{"type":"disabled"}` and for C2 is `{"type":"enabled","budget_tokens":2048}`; C3 low has budget 1024 and max has a larger budget below max_tokens; live L1 has no thinking block and L2 has a signed thinking block.
    Negative control: the same requests against the master baseline server capture `{"type":"enabled"}` + `reasoning_effort:"low"` and live L1 returns a thinking block; the new unit test cases 1, 2, 3, 6, 7 fail on unmodified source (`qa-red.txt`).
    Observable: `thinking` / `reasoning_effort` / `enable_thinking` keys of the captured upstream JSON body; content block types and signature presence in the Bifrost response.
    Boundary: HTTP `POST /v1/messages` and `/v1/chat/completions` on a local 9router, forwarded to the node's upstream `/messages`.
  - Invariant: native Z.AI routes keep the Z.AI contract (thinking enabled + reasoning_effort; GLM-5.3 never disabled).
    Positive witness: provider `glm` claude→claude with `thinking:{type:"disabled"}` yields `{thinking:{type:"enabled"}, reasoning_effort:"low"}`; provider `glm` openai→openai keeps `reasoning_effort:"low"`; `tests/unit/glm53-thinking-cannot-disable.test.js` stays green.
    Negative control: an override keyed on model id instead of provider transport would emit `thinking:{type:"disabled"}` for provider `glm`, and test case 4b must fail on that.
    Observable: `thinking`, `reasoning_effort`, `enable_thinking` of the `translateRequest` output.
    Boundary: `translateRequest` in `open-sse/translator/index.js` with provider `glm`.
  - Invariant: Claude-native thinking formats on anthropic-compatible nodes are left as resolved.
    Positive witness: `claude-opus-5-5` on the node with `thinking:{type:"disabled"}` yields no disabled thinking and `output_config.effort:"low"`.
    Negative control: overriding every format would emit `{type:"disabled"}` (Opus 5.5 400), and test case 5 must fail on that.
    Observable: `thinking.type` and `output_config.effort` of the `translateRequest` output.
    Boundary: `translateRequest` with provider `anthropic-compatible-thinking-test`.
  - Mechanical: no existing test regresses.
    Invariant: the full vitest suite has no pass→fail transition versus master.
    Observable: per-test status diff of two `vitest --reporter=json` runs (`qa-suite-diff.txt`).
    Boundary: `tests/` suite.
