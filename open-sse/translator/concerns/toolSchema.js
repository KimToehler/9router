// Tool input_schema normalization for Claude-format targets.
//
// Anthropic rejects schema combinators at the ROOT of a tool's input_schema:
//   tools.64.custom.input_schema: input_schema does not support oneOf, allOf,
//   or anyOf at the top level
// Nested combinators are accepted — only the root is rejected.
//
// MCP servers routinely put conditional-requirement blocks there, e.g.
//   { type: "object", properties: {...}, required: [...],
//     anyOf: [{ required: ["command"] }, { required: ["job_id"] }] }
// One such server in a session poisons the whole request: every model in a
// combo gets the same 400, and every account looks broken.
//
// These blocks are validation hints, not inference input — Anthropic does not
// validate tool arguments against them. Dropping the keyword and restating the
// constraint in the tool description preserves what the model actually reads.

const ROOT_COMBINATORS = ["anyOf", "oneOf", "allOf"];

const MAX_BRANCHES_DESCRIBED = 6;
const MAX_HINT_LENGTH = 400;

const HINT_PREFIX = "Input constraints: ";

const KEYWORD_LEAD = {
  anyOf: "satisfy at least one of",
  oneOf: "satisfy exactly one of",
  allOf: "satisfy all of",
};

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// First property carrying a const/enum discriminator, e.g. action=trace.
function findDiscriminator(schema) {
  if (!isPlainObject(schema?.properties)) return null;
  for (const [name, prop] of Object.entries(schema.properties)) {
    if (!isPlainObject(prop)) continue;
    if (prop.const !== undefined) return `${name}=${prop.const}`;
    if (Array.isArray(prop.enum) && prop.enum.length > 0) return `${name}=${prop.enum.join("|")}`;
  }
  return null;
}

function describeRequired(schema) {
  const required = Array.isArray(schema?.required) ? schema.required.filter(Boolean) : [];
  return required.length > 0 ? `requires ${required.join(", ")}` : "";
}

// Render one branch as a short clause. Handles both plain branches
// ({required:[...]}) and JSON Schema conditionals ({if,then}).
function describeBranch(branch) {
  if (!isPlainObject(branch)) return "";

  if (isPlainObject(branch.if)) {
    const condition = findDiscriminator(branch.if) || describeRequired(branch.if);
    const consequence = describeRequired(branch.then) || describeBranch(branch.then);
    if (condition && consequence) return `when ${condition}: ${consequence}`;
    if (consequence) return consequence;
    return "";
  }

  const parts = [findDiscriminator(branch), describeRequired(branch)].filter(Boolean);
  return parts.join(": ");
}

function describeBranches(keyword, branches) {
  const clauses = [];
  for (const branch of branches.slice(0, MAX_BRANCHES_DESCRIBED)) {
    const clause = describeBranch(branch);
    if (clause) clauses.push(`(${clause})`);
  }
  if (clauses.length === 0) return "";
  const omitted = branches.length - MAX_BRANCHES_DESCRIBED;
  const suffix = omitted > 0 ? `, and ${omitted} more` : "";
  return `${KEYWORD_LEAD[keyword]} ${clauses.join(", ")}${suffix}`;
}

// Pull property definitions out of the branches so their descriptions survive.
// Root definitions always win; branch `required` is deliberately NOT merged —
// a conditional requirement must not become an unconditional one.
function absorbBranchProperties(schema, branches) {
  for (const branch of branches) {
    if (!isPlainObject(branch)) continue;
    const nested = [branch.properties, branch.then?.properties, branch.else?.properties];
    for (const properties of nested) {
      if (!isPlainObject(properties)) continue;
      if (!isPlainObject(schema.properties)) schema.properties = {};
      for (const [name, definition] of Object.entries(properties)) {
        if (schema.properties[name] === undefined) schema.properties[name] = definition;
      }
    }
  }
}

/**
 * Strip root-level combinators from one tool schema.
 * @returns {string} constraint hint describing what was removed ("" if nothing).
 */
export function normalizeToolSchemaRoot(schema) {
  if (!isPlainObject(schema)) return "";

  const hints = [];
  for (const keyword of ROOT_COMBINATORS) {
    const branches = schema[keyword];
    if (!Array.isArray(branches) || branches.length === 0) {
      // A malformed non-array combinator is still rejected by Anthropic.
      if (schema[keyword] !== undefined) delete schema[keyword];
      continue;
    }
    absorbBranchProperties(schema, branches);
    const hint = describeBranches(keyword, branches);
    if (hint) hints.push(hint);
    delete schema[keyword];
  }

  if (hints.length === 0) return "";
  const hint = hints.join("; ");
  return hint.length > MAX_HINT_LENGTH ? `${hint.slice(0, MAX_HINT_LENGTH - 1)}…` : hint;
}

function getToolSchema(tool) {
  if (isPlainObject(tool?.input_schema)) return tool.input_schema;
  if (isPlainObject(tool?.custom?.input_schema)) return tool.custom.input_schema;
  return null;
}

function appendHint(tool, hint) {
  const line = `${HINT_PREFIX}${hint}`;
  const description = typeof tool.description === "string" ? tool.description : "";
  if (description.includes(line)) return;
  tool.description = description ? `${description}\n\n${line}` : line;
}

/**
 * Normalize every tool schema on a Claude-format body in place.
 * @param {object} body - Claude Messages API request body
 * @returns {string[]} names of tools that were normalized
 */
export function normalizeClaudeToolSchemas(body) {
  if (!Array.isArray(body?.tools)) return [];

  const normalized = [];
  for (const tool of body.tools) {
    const schema = getToolSchema(tool);
    if (!schema) continue;
    const hint = normalizeToolSchemaRoot(schema);
    if (!hint) continue;
    appendHint(tool, hint);
    normalized.push(tool.name || tool.custom?.name || "unnamed");
  }
  return normalized;
}
