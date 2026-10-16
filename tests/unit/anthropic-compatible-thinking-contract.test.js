// A dynamic anthropic-compatible-* node speaks Anthropic Messages whatever
// weights sit behind it. bifrost/glm-5.3 inherited the global *glm-5.3* rule
// (thinkingFormat "zai", cannot disable), so every request — Claude clients
// included — reached the gateway as thinking:{type:"enabled"} + reasoning_effort:
// "disabled" was ignored, budget_tokens dropped, and OpenAI effort never became
// a budget. Native z.ai keeps its own contract (#4409).
import { describe, expect, it } from "vitest";

import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";
import { LEVEL_TO_BUDGET } from "../../open-sse/translator/concerns/thinking.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import "../translator/registerAll.js";

const NODE = "anthropic-compatible-thinking-test";
const MODEL = "glm-5.3";

const run = (source, provider, body, model = MODEL) =>
  translateRequest(source, FORMATS.CLAUDE, model, { model, messages: [{ role: "user", content: "hi" }], ...body }, false, null, provider);

describe("anthropic-compatible node: Anthropic thinking contract for glm-5.3", () => {
  it("Claude client: thinking disabled reaches the upstream as disabled", () => {
    const out = run(FORMATS.CLAUDE, NODE, { thinking: { type: "disabled" } });
    expect(out.thinking).toEqual({ type: "disabled" });
    expect(out).not.toHaveProperty("reasoning_effort");
    expect(out).not.toHaveProperty("enable_thinking");
  });

  it("Claude client: an explicit budget passes through unchanged", () => {
    const out = run(FORMATS.CLAUDE, NODE, { max_tokens: 4096, thinking: { type: "enabled", budget_tokens: 2048 } });
    expect(out.thinking).toEqual({ type: "enabled", budget_tokens: 2048 });
    expect(out).not.toHaveProperty("reasoning_effort");
  });

  it("OpenAI client: effort becomes a budget, higher effort a larger one", () => {
    const low = run(FORMATS.OPENAI, NODE, { reasoning_effort: "low" });
    const max = run(FORMATS.OPENAI, NODE, { reasoning_effort: "max" });
    for (const out of [low, max]) {
      expect(out.thinking.type).toBe("enabled");
      expect(out.thinking.budget_tokens).toBeGreaterThan(0);
      expect(out.thinking.budget_tokens).toBeLessThan(out.max_tokens);
      expect(out).not.toHaveProperty("reasoning_effort");
    }
    expect(low.thinking.budget_tokens).toBe(LEVEL_TO_BUDGET.low);
    expect(max.thinking.budget_tokens).toBeGreaterThan(low.thinking.budget_tokens);
  });

  it("replays a signed thinking block before its tool_use on the next turn", () => {
    const out = run(FORMATS.CLAUDE, NODE, {
      max_tokens: 4096,
      thinking: { type: "enabled", budget_tokens: 2048 },
      tools: [{ name: "calc", description: "d", input_schema: { type: "object", properties: { expr: { type: "string" } } } }],
      messages: [
        { role: "user", content: "compute" },
        { role: "assistant", content: [
          { type: "thinking", thinking: "plan the call", signature: "sig-upstream" },
          { type: "tool_use", id: "toolu_1", name: "calc", input: { expr: "1+1" } },
        ] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "2" }] },
      ],
    });
    const assistant = out.messages.find((m) => m.role === "assistant");
    expect(assistant.content.map((b) => b.type)).toEqual(["thinking", "tool_use"]);
    expect(assistant.content[0].thinking).toBe("plan the call");
    expect(typeof assistant.content[0].signature).toBe("string");
    expect(assistant.content[0].signature.length).toBeGreaterThan(0);
    expect(assistant.content[1].id).toBe("toolu_1");
    expect(out.thinking).toEqual({ type: "enabled", budget_tokens: 2048 });
    expect(out).not.toHaveProperty("reasoning_effort");
  });

  it("offers the Anthropic budget levels in the picker, including none", () => {
    expect(getThinkingLevels(NODE, MODEL)).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
  });
});

describe("guards: contracts that must not move", () => {
  it("native z.ai OpenAI transport keeps thinking enabled + reasoning_effort", () => {
    const out = translateRequest(FORMATS.OPENAI, FORMATS.OPENAI, MODEL,
      { model: MODEL, messages: [{ role: "user", content: "hi" }], reasoning_effort: "low" }, false, null, "glm");
    expect(out.thinking).toEqual({ type: "enabled" });
    expect(out.reasoning_effort).toBe("low");
  });

  it("native z.ai Anthropic transport never disables GLM-5.3 thinking (#4409)", () => {
    const out = run(FORMATS.CLAUDE, "glm", { thinking: { type: "disabled" } });
    expect(out.thinking).toEqual({ type: "enabled" });
    expect(out.reasoning_effort).toBe("low");
    expect(out.enable_thinking).toBeUndefined();
  });

  it("a Claude model on a node keeps its Claude-native adaptive contract", () => {
    const out = run(FORMATS.CLAUDE, NODE, { thinking: { type: "disabled" } }, "claude-opus-5-5");
    expect(out.thinking?.type).not.toBe("disabled");
    expect(out.output_config.effort).toBe("low");
  });
});
