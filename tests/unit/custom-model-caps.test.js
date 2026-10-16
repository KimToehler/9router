// The user's per-model capability flags (custom models in the dashboard) are
// the last word for that provider + model: a gateway can serve images for a
// model its vendor documents as text-only, and the other way round.
import { afterEach, describe, expect, it } from "vitest";
import { getCapabilitiesForModel, setCustomCapsSource } from "../../open-sse/providers/capabilities.js";

const NODE = "anthropic-compatible-x";

afterEach(() => setCustomCapsSource(null));

describe("custom model capability override", () => {
  it("without flags, glm-5.3 resolves from the table as text-only with 1M context", () => {
    const caps = getCapabilitiesForModel(NODE, "glm-5.3");
    expect(caps.vision).toBe(false);
    expect(caps.contextWindow).toBe(1000000);
  });

  it("a vision flag turns vision on for that provider and model only", () => {
    setCustomCapsSource({ get: (p, m) => (p === NODE && m === "glm-5.3" ? { vision: true } : null) });

    const caps = getCapabilitiesForModel(NODE, "glm-5.3");
    expect(caps.vision).toBe(true);
    expect(caps.contextWindow).toBe(1000000);
    expect(getCapabilitiesForModel("zai", "glm-5.3").vision).toBe(false);
  });

  it("a flag can also turn a capability off", () => {
    expect(getCapabilitiesForModel("claude", "claude-sonnet-4-6").vision).toBe(true);
    setCustomCapsSource({ get: (p, m) => (p === "claude" && m === "claude-sonnet-4-6" ? { vision: false } : null) });

    expect(getCapabilitiesForModel("claude", "claude-sonnet-4-6").vision).toBe(false);
  });
});
