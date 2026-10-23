# Keep Claude CAIS (`C…`) thinking signatures on Claude routes

## Context
`isValidClaudeSignature` (`open-sse/utils/claudeSignature.js`) accepts only `E…` (decoded[0] == 0x12) and `R…` (double base64). Current Anthropic signatures start with `C`: decoded `08 <envelope version> 12 <len> <container>`, a protobuf envelope whose field 1 is a varint and field 2 the container that the old format put first. Both callers drop every thinking block whose signature fails the check:
- `normalizeClaudePassthrough` step 5 (`open-sse/translator/formats/claude.js:~274`), reached for Claude Code UA → provider `claude` / `anthropic-compatible-*`.
- `prepareClaudeRequest` (`claude.js:~641`), provider `claude` on the translated path (e.g. non-Claude-Code clients such as omp).

Result: all prior thinking is stripped before it reaches Anthropic; reasoning continuity and prompt-cache prefix are lost on every request.

Evidence gathered in planning (local omp sessions, `~/.omp/agent/sessions/**`):
- 15,642 non-empty `cc/*` signatures. All `cc/*-5-5` and `cc/claude-opus-5` ones start with `C` (`CAQS…` = version 4, `CAIS…` = version 2); `cc/claude-sonnet-5` / haiku-4-5 ones start with `E`.
- Structural check (envelope parses as protobuf → exactly one field-2 container → container parses → exactly one non-empty field-1 channel block → channel block parses) accepts 15,642/15,642 Claude signatures and rejects 41/41 Bifrost/GLM, 18/18 Codex/GPT, `DEFAULT_THINKING_GEMINI_CLI_SIGNATURE` (`CiQB…`, also `C`!), `DEFAULT_THINKING_VERTEX_SIGNATURE`, and 1,000,000/1,000,000 random buffers.
- `DEFAULT_THINKING_CLAUDE_SIGNATURE` (`Epw…`) is a structurally well-formed legacy E signature; whether Anthropic still accepts it on replay is unverified (no credentials for a direct probe).
- CLIProxyAPI, which this validator was ported from, added the same structural "CAIS" branch upstream (`internal/signature/claude_validation.go`, `InspectClaudeCAISSignature`).

## Decision
**Option A, structural**, decided by the author with the evidence above:
- Add a `C` branch: base64-decode (strict alphabet), decoded[0] == 0x08, then the structural check above. Envelope version, channel id, model text and block kind are NOT pinned: they are incidental values that already differ between versions 2 and 4.
- E/R branches unchanged (acceptance 3; no behaviour change for legacy signatures or for `DEFAULT_THINKING_AG_SIGNATURE`, which passes E today).
- Rejected B (run step 5 only for combos/model switches): the passthrough handler cannot see where a replayed history came from; a single Claude Code session that once went through a GLM/Gemini combo would replay foreign signatures to Anthropic and 400 every later turn.
- Rejected C (drop only known-foreign formats): Bifrost/GLM signatures are random base64 with arbitrary first characters (41 samples, 25+ distinct prefixes), so a deny-list cannot recognise them, and an unrecognised one 400s the request. Fail-closed on unknown input stays correct; the structural check reduces the "next format change" risk because it keys on envelope shape, not on the first byte of the container.
- Remove dead `hasClaudeSignaturePrefix` (no caller in repo) instead of extending it.

Out of scope, recorded as follow-ups: `thinkingEnabled` in step 5 and in `prepareClaudeRequest` ignores `type:"adaptive"` (placeholder insertion only; unrelated to signature validity); replay validity of `DEFAULT_THINKING_CLAUDE_SIGNATURE` at Anthropic.

## Approach
0. Worktrees `.worktrees/claude-c-signature` (branch `fix/claude-c-signature` from `master` a27f9ae0) and detached baseline `.worktrees/claude-c-signature-baseline`; `tests/node_modules` symlinked from the main checkout; root deps installed per worktree with `npm install --no-package-lock`, because the main checkout's `node_modules` lacks `@aws-sdk/credential-providers` and breaks `next dev`.
1. RED: `tests/unit/claude-cais-signature.test.js`:
   - real `C` signature from `AcpV2Surface-2.jsonl` (928 chars, CAQS v4): `normalizeClaudePassthrough` keeps the thinking block, `toEqual` the original block (byte-identical signature); `prepareClaudeRequest(body, "claude")` keeps it too.
   - negative: `DEFAULT_THINKING_GEMINI_CLI_SIGNATURE`, a Bifrost-style random `C…` base64, a `C` string whose payload starts with 0x08 but has no container, and the real signature truncated by 8 chars are dropped; with tool_use + `thinking.type:"enabled"` the signed placeholder replaces them.
   - legacy: `DEFAULT_THINKING_CLAUDE_SIGNATURE` (E) and its double-base64 R form stay valid.
   RED expected on unmodified source: the real-C keep cases fail; negatives and legacy pass.
2. Fix `open-sse/utils/claudeSignature.js` as decided; update header comment.
3. GREEN: new test + `tests/unit/claude-*.test.js` + `translator/`; full-suite pass→fail JSON diff vs baseline (method from `ANTHROPIC_NODE_THINKING_PLAN.md` step 4).
4. Live probe against Anthropic: a `claude` OAuth connection seeded into each local dev server's DATA_DIR from the user's Claude Code keychain login. Access token only, no refresh token, so 9router never rotates the user's login. The probe is two turns on `cc/claude-sonnet-5-5`, streaming, adaptive thinking (`display: summarized`, effort max), one `calc` tool call, `User-Agent: claude-cli/…`, and the Claude Code system prompt the client itself sends (Anthropic answers 429 to OAuth requests without it; the user decided that 9router must not inject it). Fix server vs baseline server. Recorded: turn-2 `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` minus turn-1's total, against turn-1 thinking tokens → `qa-live.txt`.
5. Prepare upstream PR text for `decolua/9router` (`upstream-draft.md`). User decision: post it only after our merge and a passing merge gate.

## TODOs
1. [x] F2 wave 1 B1 (`unbounded-field-alloc`): `parseFields` in `open-sse/utils/claudeSignature.js` allocates one object per protobuf field, so a field-dense C-prefixed signature near the 32 MiB limit costs ~736 MB of heap before it is rejected. Replace it with a scan that keeps only the wanted length-delimited field's range in O(1) memory and rejects a duplicate as soon as it is seen. Add a regression test with a multi-million-field payload: it must be rejected and the heap must stay bounded. Done: `scanFields`; evidence `qa-b1-dense.txt` (RED/GREEN + old/new equivalence on all local signatures), `qa-suite-diff.txt` re-run, `qa-live.txt` fix row re-run on this head.

## Final verification wave
- [x] F3. Whole-diff review: `integration-review` not needed: one source module (`open-sse/utils/claudeSignature.js`) plus one test file and evidence; tick with that reason
- [x] F1. Manual QA on the real surface, one evidence path per scenario, on the head after F3's last code commit: `docs/evidence/claude-cais-signature/qa-capture.txt` (upstream body capture, fix vs baseline) and `docs/evidence/claude-cais-signature/qa-live.txt` (live Anthropic token delta, fix vs baseline)
- [x] F2. Merge gate: `review-work`, SHA-bound omo.merge-gate/v2 record validated

## Merge gate
- Author's risk assessment: The change widens which thinking signatures 9router forwards to Anthropic on every Claude route. Too wide: a foreign or corrupted signature reaches Anthropic and the whole request fails with 400 for that user until the history is cleared. Too narrow (today): all prior thinking silently disappears, costing reasoning continuity, cache hits and money for every Claude Code user. The structural check is evaluated against 15.6k real signatures, all local foreign samples, and 1M random buffers. No auth, credential, schema or PII change. Wire payload to Anthropic changes (thinking blocks now included).
- Mandatory class: wire-contract-api
- Risk tier: product
- Whole-diff review: not needed (one source module plus tests and evidence)
- Accepted residual risks: a future Anthropic envelope that is not `C`/`E`/`R`-prefixed is again dropped (fail-closed, same as today); a hand-crafted foreign string that happens to be a well-formed nested protobuf with a 0x08 lead byte is forwarded and 400s.
- Out of scope for blocking: `thinkingEnabled` ignoring `adaptive` for placeholder insertion; Anthropic-side validity of `DEFAULT_THINKING_CLAUDE_SIGNATURE`; non-Claude providers' signature handling.
- Feature-specific criteria:
  - Invariant: a real Anthropic `C…` thinking signature survives `normalizeClaudePassthrough` and `prepareClaudeRequest` (provider `claude`) unchanged, together with its thinking block.
    Positive witness: the new unit test's keep cases pass, and in the live probe turn-2 billed input grows by roughly turn-1's thinking tokens on the fix server.
    Negative control: the same unit cases fail on unmodified source (`qa-red.txt`), and the live probe against the baseline server shows no such growth.
    Observable: assistant message content after normalization; `usage.input_tokens + cache_read_input_tokens + cache_creation_input_tokens` of turn 2 minus turn 1.
    Boundary: `normalizeClaudePassthrough` / `prepareClaudeRequest` exports; HTTP `POST /v1/messages` on a local 9router with `User-Agent: claude-cli/…`.
  - Invariant: foreign or malformed signatures are still dropped before reaching Anthropic.
    Positive witness: Gemini CLI default (`CiQB…`), Bifrost-style random `C…`, envelope-without-container and truncated real signatures are removed; the signed placeholder is inserted for tool_use turns with enabled thinking; `claude-foreign-server-tool-use.test.js` stays green.
    Negative control: a validator that accepts any `C` prefix or any base64 lets `DEFAULT_THINKING_GEMINI_CLI_SIGNATURE` through, and the negative test cases fail on it.
    Observable: block types and signatures of the normalized assistant message.
    Boundary: `normalizeClaudePassthrough` export.
  - Invariant: validating an untrusted `C…` signature uses auxiliary memory independent of its protobuf field count; a field-dense malformed signature near the 32 MiB limit is rejected without monopolising the shared gateway heap.
    Positive witness: the field-dense regression case (`08 04` + 12M empty varint fields, no container) is rejected with heap growth under 64 MiB.
    Negative control: the per-field-allocating parser of commit 41af9f30 grows the heap by ~680 MB on the same input and fails the case (`qa-b1-dense.txt` RED section).
    Observable: normalized signature (placeholder) and `process.memoryUsage().heapUsed` delta around `normalizeClaudePassthrough`.
    Boundary: `normalizeClaudePassthrough` export, the only request-facing entry besides `prepareClaudeRequest` that reaches the validator.
  - Mechanical: no existing test regresses.
    Invariant: the full vitest suite has no pass→fail transition versus master.
    Observable: per-test status diff of two `vitest --reporter=json` runs (`qa-suite-diff.txt`).
    Boundary: `tests/` suite.
