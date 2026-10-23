# Upstream draft for decolua/9router (NOT POSTED)

Target: `decolua/9router`, base `master` (f39d8f07). `open-sse/utils/claudeSignature.js` is byte-identical upstream (md5 be73ab64…), so the patch applies unchanged.
No existing issue/PR found (searched: "signature thinking", "CAIS OR CAQS OR isValidClaudeSignature", "thinking blocks dropped claude"). Related but different: #2925 (Responses envelope).

Plan: one PR that also describes the bug (no separate issue), unless the maintainer prefers issue-first.

---

## PR title
fix(claude): accept current CAIS/CAQS thinking signatures instead of dropping all prior thinking

## PR body

### Problem
`isValidClaudeSignature` (`open-sse/utils/claudeSignature.js`) only accepts the legacy `E…` (decoded[0] == 0x12) and `R…` (double base64) signature forms. Current Anthropic models (claude-*-5-5, claude-opus-5, haiku-5-5) sign thinking with a protobuf envelope whose base64 starts with `C` (`CAQS…`, `CAIS…`): decoded `08 <version> 12 <len> <container> …`. The old 0x12 container sits at offset 2.

Both callers treat those signatures as foreign and drop the thinking block:
- `normalizeClaudePassthrough` step 5 (Claude Code → `claude` / `anthropic-compatible-*`)
- `prepareClaudeRequest` for provider `claude` (translated path)

Effect: every prior thinking block is stripped before the request reaches Anthropic. Models lose reasoning continuity across tool turns and re-derive it each request; for clients that count context locally, the router silently sends much less than the client thinks.

### Fix
Add a `C` branch with a structural check (no field values pinned):
- strict base64, decoded[0] == 0x08
- the whole payload parses as protobuf, with exactly one length-delimited field 2 (container)
- the container parses, with exactly one non-empty length-delimited field 1 (channel block)
- the channel block parses as protobuf

`E`/`R` handling is unchanged. A bare `C` prefix is not enough: Gemini CLI thought signatures (`CiQB…`) also start with `C` and must still be dropped. This mirrors the CAIS branch CLIProxyAPI added to the validator this file was ported from (`internal/signature/claude_validation.go`, `InspectClaudeCAISSignature`), but stays structural instead of requiring model text or block kind, because those already differ between envelope versions 2 and 4.

Removed the unused `hasClaudeSignaturePrefix` export (no callers).

### Evidence
- Corpus of 15,642 real signatures from claude-opus-5-5 / sonnet-5-5 / haiku-5-5 / opus-5 / sonnet-5 / haiku-4-5 (C and E forms): all accepted. 41 GLM (Anthropic-compatible gateway) and 18 GPT reasoning signatures: all rejected. `DEFAULT_THINKING_GEMINI_CLI_SIGNATURE` and `DEFAULT_THINKING_VERTEX_SIGNATURE`: rejected. 300k random buffers forced to a 0x08 lead byte: 0 accepted.
- Capture probe through a real dev server (`POST /v1/messages`, `User-Agent: claude-cli/…`, assistant `[thinking(C-signature), tool_use]` in history):
  - master: the upstream body has assistant content `[tool_use]`, so the thinking is gone.
  - this branch: the upstream body has `[thinking, tool_use]`, with the signature byte-identical to the input.
- Live against Anthropic (Claude Code OAuth, `cc/claude-sonnet-5-5`, adaptive thinking, one tool call, streaming). Turn 2 replays turn 1's assistant content unchanged plus a `tool_result`. Billed input is `input + cache_read + cache_creation`.

  | | turn-1 thinking tokens | turn-1 billed input | turn-2 billed input | delta |
  |---|---|---|---|---|
  | master | 21,267 | 502 | 1,522 | +1,020 |
  | this branch | 27,828 | 502 | 29,235 | +28,733 |

  On master the replayed thinking never reaches Anthropic. With the fix, turn 2 grows by roughly turn 1's thinking, and Anthropic accepts the replayed `C` signature (HTTP 200).
- New `tests/unit/claude-cais-signature.test.js` (9 cases): before the fix, the two keep cases fail and the foreign and legacy cases pass; after the fix, all pass. The full suite has no pass→fail transitions versus master.

### Security note
This is a wire change toward Anthropic: thinking blocks that were stripped before are now forwarded. A signature that passes the structural check but is not genuine gets a 400 from Anthropic, which is the same failure mode as an invalid `E` signature today. No auth, credential or header handling is touched.

### Not in this PR
- `thinkingEnabled` in both call sites checks only `type === "enabled"`, so the signed placeholder is not inserted for `type: "adaptive"`. This is separate and does not affect signature validity.
- Whether Anthropic still accepts `DEFAULT_THINKING_CLAUDE_SIGNATURE` (legacy E) as a placeholder is unverified.
