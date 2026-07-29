import { describe, it, expect } from "vitest";
import { normalizeClaudeToolSchemas, normalizeToolSchemaRoot } from "../../open-sse/translator/concerns/toolSchema.js";
import { prepareClaudeRequest } from "../../open-sse/translator/formats/claude.js";
import { checkFallbackError } from "../../open-sse/services/accountFallback.js";

// Real shape emitted by lean-ctx 3.9.13 (ctx_shell) — a root-level anyOf holding
// conditional-requirement branches. Anthropic 400s on this:
//   tools.N.custom.input_schema: input_schema does not support oneOf, allOf,
//   or anyOf at the top level
function ctxShellTool() {
  return {
    name: "ctx_shell",
    description: "Run a shell command.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Command to run" },
        background_action: { type: "string", enum: ["start", "poll"] },
        job_id: { type: "string" },
      },
      anyOf: [{ required: ["command"] }, { required: ["background_action", "job_id"] }],
    },
  };
}

// lean-ctx ctx_callgraph — root allOf holding if/then conditionals.
function ctxCallgraphTool() {
  return {
    name: "ctx_callgraph",
    description: "Trace call edges.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["callers", "callees", "risk", "trace"] },
        symbol: { type: "string" },
        from: { type: "string" },
        to: { type: "string" },
      },
      required: ["action"],
      allOf: [
        { if: { properties: { action: { enum: ["callers", "callees", "risk"] } }, required: ["action"] }, then: { required: ["symbol"] } },
        { if: { properties: { action: { const: "trace" } }, required: ["action"] }, then: { required: ["from", "to"] } },
      ],
    },
  };
}

describe("normalizeToolSchemaRoot", () => {
  it("strips a root anyOf and reports what it removed", () => {
    const schema = ctxShellTool().input_schema;

    const hint = normalizeToolSchemaRoot(schema);

    expect(schema.anyOf).toBeUndefined();
    expect(hint).toContain("at least one of");
    expect(hint).toContain("command");
    expect(hint).toContain("job_id");
  });

  it("strips a root allOf of if/then conditionals and keeps the condition readable", () => {
    const schema = ctxCallgraphTool().input_schema;

    const hint = normalizeToolSchemaRoot(schema);

    expect(schema.allOf).toBeUndefined();
    expect(hint).toContain("when action=trace");
    expect(hint).toContain("from, to");
  });

  it("preserves properties, required and type", () => {
    const schema = ctxCallgraphTool().input_schema;

    normalizeToolSchemaRoot(schema);

    expect(schema.type).toBe("object");
    expect(Object.keys(schema.properties).sort()).toEqual(["action", "from", "symbol", "to"]);
    expect(schema.required).toEqual(["action"]);
  });

  it("does not promote a conditional requirement into an unconditional one", () => {
    const schema = ctxCallgraphTool().input_schema;

    normalizeToolSchemaRoot(schema);

    // symbol/from/to are only required for specific actions — required must not grow
    expect(schema.required).not.toContain("symbol");
    expect(schema.required).not.toContain("from");
  });

  it("leaves nested combinators alone (Anthropic only rejects the root)", () => {
    const schema = {
      type: "object",
      properties: {
        inline_spec: { anyOf: [{ type: "object", properties: { name: { type: "string" } } }, { type: "string" }] },
      },
    };

    const hint = normalizeToolSchemaRoot(schema);

    expect(hint).toBe("");
    expect(schema.properties.inline_spec.anyOf).toHaveLength(2);
  });

  it("is a no-op on a clean schema", () => {
    const schema = { type: "object", properties: { path: { type: "string" } }, required: ["path"] };

    expect(normalizeToolSchemaRoot(schema)).toBe("");
    expect(schema).toEqual({ type: "object", properties: { path: { type: "string" } }, required: ["path"] });
  });

  it("keeps branch-only property definitions so their descriptions survive", () => {
    const schema = {
      type: "object",
      properties: { action: { type: "string" } },
      oneOf: [{ properties: { query: { type: "string", description: "search text" } }, required: ["query"] }],
    };

    normalizeToolSchemaRoot(schema);

    expect(schema.properties.query).toEqual({ type: "string", description: "search text" });
  });
});

describe("normalizeClaudeToolSchemas", () => {
  it("normalizes every offending tool and appends the constraint to its description", () => {
    const body = { tools: [ctxShellTool(), { name: "clean", description: "ok", input_schema: { type: "object", properties: {} } }, ctxCallgraphTool()] };

    const normalized = normalizeClaudeToolSchemas(body);

    expect(normalized).toEqual(["ctx_shell", "ctx_callgraph"]);
    expect(body.tools[0].description).toContain("Run a shell command.");
    expect(body.tools[0].description).toContain("Input constraints:");
    expect(body.tools[1].description).toBe("ok");
  });

  it("handles the tools[].custom.input_schema shape from the error message", () => {
    const body = {
      tools: [{ name: "wrapped", custom: { name: "wrapped", input_schema: { type: "object", properties: {}, oneOf: [{ required: ["a"] }] } } }],
    };

    const normalized = normalizeClaudeToolSchemas(body);

    expect(normalized).toEqual(["wrapped"]);
    expect(body.tools[0].custom.input_schema.oneOf).toBeUndefined();
  });

  it("is idempotent so passthrough + translated paths can both run it", () => {
    const body = { tools: [ctxShellTool()] };

    normalizeClaudeToolSchemas(body);
    const descriptionAfterFirst = body.tools[0].description;
    const second = normalizeClaudeToolSchemas(body);

    expect(second).toEqual([]);
    expect(body.tools[0].description).toBe(descriptionAfterFirst);
  });

  it("tolerates missing/!array tools", () => {
    expect(normalizeClaudeToolSchemas({})).toEqual([]);
    expect(normalizeClaudeToolSchemas({ tools: null })).toEqual([]);
    expect(normalizeClaudeToolSchemas(null)).toEqual([]);
  });

  it("leaves no root combinator anywhere in a mixed 3-tool payload", () => {
    const body = { tools: [ctxShellTool(), ctxCallgraphTool(), { name: "x", input_schema: { type: "object", properties: {}, allOf: [{ required: ["y"] }] } }] };

    normalizeClaudeToolSchemas(body);

    for (const tool of body.tools) {
      const schema = tool.input_schema || tool.custom?.input_schema;
      expect(schema.anyOf).toBeUndefined();
      expect(schema.oneOf).toBeUndefined();
      expect(schema.allOf).toBeUndefined();
    }
  });
});

describe("prepareClaudeRequest tool schemas", () => {
  it("sanitizes tool schemas on the translated path", () => {
    const body = { model: "claude-opus-5", messages: [{ role: "user", content: "hi" }], tools: [ctxShellTool()] };

    prepareClaudeRequest(body, "claude");

    expect(body.tools[0].input_schema.anyOf).toBeUndefined();
    expect(body.tools[0].input_schema.properties.command).toBeDefined();
  });
});

describe("checkFallbackError payload-fault classification", () => {
  it("marks a 400 as not-an-account-fault so the account is not locked", () => {
    const result = checkFallbackError(400, "input_schema does not support oneOf, allOf, or anyOf at the top level");

    expect(result.accountFault).toBe(false);
    expect(result.cooldownMs).toBe(0);
  });

  it("still allows the model loop to try the next combo rung", () => {
    // A different provider may accept a body Anthropic rejects.
    expect(checkFallbackError(400, "bad schema").shouldFallback).toBe(true);
  });

  it("keeps treating a 400 whose body says rate limit as a quota error", () => {
    const result = checkFallbackError(400, "rate limit exceeded for this org");

    expect(result.accountFault).toBeUndefined();
    expect(result.cooldownMs).toBeGreaterThan(0);
  });

  it("leaves 429 and 401 classification unchanged", () => {
    expect(checkFallbackError(429, "").cooldownMs).toBeGreaterThan(0);
    expect(checkFallbackError(429, "").accountFault).toBeUndefined();
    expect(checkFallbackError(401, "").cooldownMs).toBeGreaterThan(0);
    expect(checkFallbackError(401, "").accountFault).toBeUndefined();
  });

  it("still applies the transient default to unmatched errors", () => {
    const result = checkFallbackError(500, "boom");

    expect(result.shouldFallback).toBe(true);
    expect(result.cooldownMs).toBeGreaterThan(0);
    expect(result.accountFault).toBeUndefined();
  });
});
