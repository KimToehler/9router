// Anthropic's current thinking signatures use a protobuf envelope (CAIS/CAQS):
// base64 starts with "C", decoded[0] == 0x08 (field 1 varint), and the classic
// 0x12 container only follows at offset 2. Treating those as foreign stripped
// every prior thinking block from Claude Code histories before they reached
// Anthropic. Foreign signatures from combo turns must still be dropped.
import { describe, it, expect } from "vitest";
import { normalizeClaudePassthrough, prepareClaudeRequest } from "../../open-sse/translator/formats/claude.js";
import {
  DEFAULT_THINKING_CLAUDE_SIGNATURE,
  DEFAULT_THINKING_GEMINI_CLI_SIGNATURE,
} from "../../open-sse/config/defaultThinkingSignature.js";

// Real claude-sonnet-5-5 signature (CAQS, envelope version 4) with its thinking
// text, taken verbatim from an omp session routed through cc/claude-sonnet-5-5.
const REAL_THINKING = "I should start by looking over the plan and the existing code to get my bearings.\n\n";
const REAL_CAQS_SIGNATURE = "CAQSsAUKEAgTGAI4AUIIdGhpbmtpbmcSDL3rwd2ZslatshEKGRoMV7gQL80NqI85/uS/IjD469t1TfonWX4atHHoDgDKIfOww42ZAjmP6/u8QHRoKyNJxJ/JLR+Nj5zFIftx9MQqzQSzi5wt4B4nnE+TwYGUy7wtmosb96AQ+KqvHMv/nmR/EYJycwEcivpX0GQE0Y/PW1F4OwcOvv/IHiGAWc0L+HaaHjFHWcy0qSHJSdg963wFqMoaDj+ucx7KUq/I4X23SnEioUXKe+Di4SCP7iSEh3NVg/HJbayfNmf66vDeK6ix/e+gaJIKZRkUH11T/H34oJ8XZid/Hw8hcG9gOPYdvSGXIKCXwuVxDPmRtsUnTLI5tbaourRSXnff1DATEdAiPA+5DVplXDz0EmWbUQHg0LByoNsLygUkF6TKK8vMKXG/OZ0rHoduxatQi7VxbIRSvIMNv0kxZOCQ2/ck+cYfwnDPj1zCmiIYmD3mc+vvjFU39ZobwMncsI1Go3zmzGis0KfnvyGJv0hS+cewj94d5p2pLuVg1g6+UOXKQjFgbITk8yWYonAFVxDwkcNZsI9NOoY0dXJpUew91c1LEIDdBwCpAUq2fKhKkpOgcI94tJbXAmsIRZqbP9pv0yM8U1+tP0yKCmZNYQbQklsPTYvdxIcx5FoYb2C57WnSlRfrwwTFPEfBSusFxmur8rX0OlZ6LMelSlxPuTqqe5VwebY8bnVznf+apIrHshmhtIo3FIFI6wyfDse+XgrxYWzQs00tEusyWLbJMGCbln1UZDOL3O3qnPuZyeNIQpEZzXe+4VizdFZFyAAPUG8F1YA4n2F7lGEgcjK0E8aQZV4YZgJgOS5aPG2fTJbDjMmqz7BgrsB8wdd7IxMA1vRxGxmJvl+fzqAi/OmJW0SnldFc2kJWGAE=";

const toolUse = { type: "tool_use", id: "toolu_01", name: "Read", input: { path: "plan.md" } };

function history(thinkingBlock) {
  return {
    model: "claude-sonnet-5-5",
    max_tokens: 32000,
    thinking: { type: "enabled", budget_tokens: 16000 },
    messages: [
      { role: "user", content: [{ type: "text", text: "start" }] },
      { role: "assistant", content: [thinkingBlock, toolUse] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_01", content: "plan" }] },
    ],
  };
}

const realBlock = () => ({ type: "thinking", thinking: REAL_THINKING, signature: REAL_CAQS_SIGNATURE });
const b64 = (bytes) => Buffer.from(bytes).toString("base64");

describe("Claude CAIS/CAQS thinking signatures", () => {
  it("passthrough keeps a real C-form thinking block byte-identical", () => {
    const original = realBlock();
    const out = normalizeClaudePassthrough(history(realBlock()), "claude-sonnet-5-5");
    expect(out.messages[1].content).toEqual([original, toolUse]);
  });

  it("translated claude path keeps a real C-form thinking block", () => {
    const out = prepareClaudeRequest(history(realBlock()), "claude");
    const thinking = out.messages[1].content.find(b => b.type === "thinking");
    expect(thinking.signature).toBe(REAL_CAQS_SIGNATURE);
    expect(thinking.thinking).toBe(REAL_THINKING);
  });

  it.each([
    ["Gemini CLI default (also C-prefixed)", DEFAULT_THINKING_GEMINI_CLI_SIGNATURE],
    ["random base64 starting with C", "CwtPtKDlJUsU0DlodR0cVa1iIbzNu5/41k9ByX9Qkjg="],
    ["0x08 envelope without container", b64([0x08, 0x04, 0x18, 0x01])],
    ["0x08 envelope whose container is not protobuf", b64([0x08, 0x04, 0x12, 0x05, 0x01, 0x02, 0x03, 0x04, 0x05])],
    ["real signature truncated", REAL_CAQS_SIGNATURE.slice(0, -8)],
  ])("drops a foreign signature: %s", (_label, signature) => {
    const out = normalizeClaudePassthrough(history({ type: "thinking", thinking: "foreign", signature }), "claude-sonnet-5-5");
    const content = out.messages[1].content;
    expect(content.map(b => b.type)).toEqual(["thinking", "tool_use"]);
    expect(content[0]).toEqual({ type: "thinking", thinking: ".", signature: DEFAULT_THINKING_CLAUDE_SIGNATURE });
  });

  it.each([
    ["E-form", DEFAULT_THINKING_CLAUDE_SIGNATURE],
    ["R-form", Buffer.from(DEFAULT_THINKING_CLAUDE_SIGNATURE).toString("base64")],
  ])("keeps legacy %s signatures", (_label, signature) => {
    const block = { type: "thinking", thinking: "legacy", signature };
    const out = normalizeClaudePassthrough(history({ ...block }), "claude-sonnet-5-5");
    expect(out.messages[1].content[0]).toEqual(block);
  });

  it("rejects a field-dense signature near the size limit without per-field allocation", () => {
    // 08 04 then ~12M empty varint fields (18 00) and no container: ~32 MB of base64.
    const bytes = Buffer.alloc(2 + 12_000_000 * 2);
    bytes[0] = 0x08;
    bytes[1] = 0x04;
    for (let i = 2; i < bytes.length; i += 2) bytes[i] = 0x18;
    const signature = bytes.toString("base64");
    const heapBefore = process.memoryUsage().heapUsed;
    const out = normalizeClaudePassthrough(history({ type: "thinking", thinking: "dense", signature }), "claude-sonnet-5-5");
    const heapGrowth = process.memoryUsage().heapUsed - heapBefore;
    expect(out.messages[1].content[0].signature).toBe(DEFAULT_THINKING_CLAUDE_SIGNATURE);
    expect(heapGrowth).toBeLessThan(64 * 1024 * 1024);
  });
});
