import { describe, it, expect } from "vitest";
import { translateNonStreamingResponse } from "../../open-sse/handlers/chatCore/nonStreamingHandler.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

// Antigravity / gemini-cli wrap generateContent in { response: {...} }.
const cloudCodeBody = (usageMetadata) => ({
  response: {
    candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }],
    usageMetadata,
    modelVersion: "gemini-test",
  },
  traceId: "t",
});

describe("non-streaming Gemini-family usage", () => {
  describe("#given an antigravity reply that hit the implicit prompt cache", () => {
    it("#then the cached prompt tokens reach the OpenAI client", () => {
      const out = translateNonStreamingResponse(cloudCodeBody({
        promptTokenCount: 1000, cachedContentTokenCount: 800, candidatesTokenCount: 20, thoughtsTokenCount: 30, totalTokenCount: 1050,
      }), FORMATS.ANTIGRAVITY, FORMATS.OPENAI);
      expect(out.usage).toEqual({
        prompt_tokens: 1000,
        completion_tokens: 50,
        total_tokens: 1050,
        prompt_tokens_details: { cached_tokens: 800 },
        completion_tokens_details: { reasoning_tokens: 30 },
      });
    });
  });

  describe("#given a plain Gemini reply without cache hits", () => {
    it("#then thoughts count as completion tokens, not prompt tokens", () => {
      const out = translateNonStreamingResponse(cloudCodeBody({
        promptTokenCount: 100, candidatesTokenCount: 5, thoughtsTokenCount: 7, totalTokenCount: 112,
      }).response, FORMATS.GEMINI, FORMATS.OPENAI);
      expect(out.usage).toEqual({
        prompt_tokens: 100,
        completion_tokens: 12,
        total_tokens: 112,
        completion_tokens_details: { reasoning_tokens: 7 },
      });
    });
  });
});
