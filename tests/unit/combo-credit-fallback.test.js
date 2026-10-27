import { describe, expect, it, vi } from "vitest";
import { handleComboChat } from "../../open-sse/services/combo.js";

describe("combo credit fallback", () => {
  it.each([
    ["You have insufficient credits to make this request."],
    ["Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."],
    // A request-scoped 400 also advances: the next member may accept the body.
    ["Bad request"],
  ])("advances to the next member on a 400: %s", async (message) => {
    const body = { messages: [{ role: "user", content: "Hello" }] };
    const models = ["cmc/deepseek/deepseek-v4-pro", "mistral/mistral-medium-latest"];
    const failure = Response.json({ error: { message } }, { status: 400 });
    const success = Response.json({ choices: [{ message: { content: "Hello" } }] });
    const handleSingleModel = vi.fn()
      .mockResolvedValueOnce(failure)
      .mockResolvedValueOnce(success);

    const response = await handleComboChat({
      body, models, handleSingleModel,
      log: { info: vi.fn(), warn: vi.fn() },
      comboName: "credit-fallback", comboStrategy: "fallback",
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("X-9Router-Upstream-Model")).toBe("mistral/mistral-medium-latest");
    expect(await response.json()).toEqual({ choices: [{ message: { content: "Hello" } }] });
    expect(handleSingleModel.mock.calls).toEqual(models.map((model) => [body, model]));
  });
});
