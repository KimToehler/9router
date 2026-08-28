import { describe, it, expect } from "vitest";

import { buildComboEntry } from "@/app/api/v1/models/route.js";

describe("/v1/models combo catalog entry", () => {
  it("#given a combo with members #when the entry is built #then candidates are listed in preference order", () => {
    const entry = buildComboEntry({
      name: "oracle",
      kind: null,
      models: ["anthropic/claude-opus-5", "openai/gpt-5.6-sol", "glm/glm-5.2"],
    });

    expect(entry.id).toBe("oracle");
    expect(entry.object).toBe("model");
    expect(entry.owned_by).toBe("combo");
    expect(entry.upstream_models).toEqual([
      "anthropic/claude-opus-5",
      "openai/gpt-5.6-sol",
      "glm/glm-5.2",
    ]);
  });

  it("#given a combo #when the entry is built #then it does NOT claim a single upstream model", () => {
    // At catalog time nothing has served anything. Naming one member would be a
    // guess, and wrong precisely when a fallback fires. The authoritative answer
    // is the X-9Router-Upstream-Model response header.
    const entry = buildComboEntry({
      name: "oracle",
      models: ["anthropic/claude-opus-5", "openai/gpt-5.6-sol"],
    });

    expect(entry.upstream_model).toBeUndefined();
  });

  it("#given a web combo #when the entry is built #then the kind is preserved alongside candidates", () => {
    const entry = buildComboEntry({
      name: "search-combo",
      kind: "webSearch",
      models: ["provider-a/search", "provider-b/search"],
    });

    expect(entry.kind).toBe("webSearch");
    expect(entry.upstream_models).toHaveLength(2);
  });

  it("#given a combo with no usable members #when the entry is built #then no empty field is emitted", () => {
    const empty = buildComboEntry({ name: "broken", models: [] });
    const missing = buildComboEntry({ name: "broken2" });
    const junk = buildComboEntry({ name: "broken3", models: ["", "   ", null, 7] });

    expect(empty.upstream_models).toBeUndefined();
    expect(missing.upstream_models).toBeUndefined();
    expect(junk.upstream_models).toBeUndefined();
  });

  it("#given a non-web combo #when the entry is built #then no kind field is invented", () => {
    const entry = buildComboEntry({ name: "oracle", models: ["anthropic/claude-opus-5"] });

    expect("kind" in entry).toBe(false);
  });
});
