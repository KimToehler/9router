import { describe, it, expect, vi } from "vitest";

import { handleComboChat, handleFusionChat } from "../../open-sse/services/combo.js";
import { peekStreamForContent, EMPTY_STREAM_MESSAGE } from "../../open-sse/utils/emptyStreamPeek.js";
import { checkFallbackError } from "../../open-sse/services/accountFallback.js";
import { createErrorResult } from "../../open-sse/utils/error.js";

const log = { info: () => {}, warn: () => {}, debug: () => {} };

function okResponse(content = "hi") {
  const json = { choices: [{ message: { role: "assistant", content } }] };
  const make = () => ({ ok: true, status: 200, clone: make, json: async () => json });
  return make();
}

function emptyStreamResponse() {
  const json = { error: { message: `[503]: ${EMPTY_STREAM_MESSAGE}` } };
  const make = () => ({ ok: false, status: 503, clone: make, json: async () => json });
  return make();
}

function sseResponse(body) {
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const CLAUDE_EMPTY = [
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"m","content":[]}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
].join("\n");

const CLAUDE_WITH_TEXT = [
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"m","content":[]}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}',
  '',
].join("\n");

async function drain(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

describe("empty stream detection", () => {
  describe("#given a claude SSE stream with no content block", () => {
    it("#then reports no content", async () => {
      const peek = await peekStreamForContent(sseResponse(CLAUDE_EMPTY));
      expect(peek.hasContent).toBe(false);
    });
  });

  describe("#given a claude SSE stream carrying a text delta", () => {
    it("#then reports content and replays every byte downstream", async () => {
      const peek = await peekStreamForContent(sseResponse(CLAUDE_WITH_TEXT));
      expect(peek.hasContent).toBe(true);
      expect(await drain(peek.replacementBody)).toBe(CLAUDE_WITH_TEXT);
    });
  });

  describe("#given an upstream error delivered inside a 200 body", () => {
    it("#then does not classify it as empty so existing error handling still runs", async () => {
      const body = 'event: error\ndata: {"type":"error","error":{"message":"overloaded"}}\n\n';
      const peek = await peekStreamForContent(sseResponse(body));
      expect(peek.hasContent).toBe(true);
    });
  });

  describe("#given a non-SSE response", () => {
    it("#then passes through untouched", async () => {
      const res = new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      const peek = await peekStreamForContent(res);
      expect(peek.hasContent).toBe(true);
      expect(peek.reason).toBe("not-sse");
    });
  });

  describe("#given frames that only look like content to a substring match", () => {
    const cases = [
      ["openai terminal-only turn", 'data: {"choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'],
      ["openai empty tool_calls array", 'data: {"choices":[{"delta":{"content":"","tool_calls":[]}}]}\n\n'],
      ["gemini empty parts", 'data: {"candidates":[{"content":{"parts":[]}}]}\n\n'],
    ];
    for (const [name, body] of cases) {
      it(`#then ${name} is still empty`, async () => {
        const peek = await peekStreamForContent(sseResponse(body));
        expect(peek.hasContent).toBe(false);
      });
    }
  });

  describe("#given real content in each upstream format", () => {
    const cases = [
      ["openai text", 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'],
      ["openai tool call", 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"x"}}]}}]}\n\n'],
      ["claude tool_use", 'data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"echo"}}\n\n'],
      ["gemini functionCall", 'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"x"}}]}}]}\n\n'],
      ["gemini text", 'data: {"candidates":[{"content":{"parts":[{"text":"hi"}]}}]}\n\n'],
      ["responses output_text delta", 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hi"}\n\n'],
    ];
    for (const [name, body] of cases) {
      it(`#then ${name} counts as content`, async () => {
        const peek = await peekStreamForContent(sseResponse(body));
        expect(peek.hasContent).toBe(true);
      });
    }
  });

  describe("#given a body whose lock is already held", () => {
    it("#then it passes through instead of throwing", async () => {
      const res = sseResponse(CLAUDE_WITH_TEXT);
      res.body.getReader();
      const peek = await peekStreamForContent(res);
      expect(peek.hasContent).toBe(true);
      expect(peek.reason).toBe("body-locked");
    });
  });
});

describe("empty stream combo behaviour", () => {
  describe("#given a model that always returns an empty stream", () => {
    it("#when the combo runs #then it retries once then falls through to the next model", async () => {
      const calls = [];
      const handleSingleModel = vi.fn(async (_body, model) => {
        calls.push(model);
        return model === "cc/opus" ? emptyStreamResponse() : okResponse("from fallback");
      });

      const res = await handleComboChat({
        body: { messages: [{ role: "user", content: "hi" }] },
        models: ["cc/opus", "cx/sol"],
        handleSingleModel,
        log,
      });

      expect(res.ok).toBe(true);
      expect(calls).toEqual(["cc/opus", "cc/opus", "cx/sol"]);
    });
  });

  describe("#given an empty stream that resolves on the retry", () => {
    it("#then it never reaches the second model", async () => {
      let attempts = 0;
      const calls = [];
      const handleSingleModel = vi.fn(async (_body, model) => {
        calls.push(model);
        attempts++;
        return attempts === 1 ? emptyStreamResponse() : okResponse("recovered");
      });

      const res = await handleComboChat({
        body: { messages: [{ role: "user", content: "hi" }] },
        models: ["cc/opus", "cx/sol"],
        handleSingleModel,
        log,
      });

      expect(res.ok).toBe(true);
      expect(calls).toEqual(["cc/opus", "cc/opus"]);
    });
  });

  describe("#given every model returns an empty stream", () => {
    it("#then the caller gets a real error instead of a silent success", async () => {
      const handleSingleModel = vi.fn(async () => emptyStreamResponse());

      const res = await handleComboChat({
        body: { messages: [{ role: "user", content: "hi" }] },
        models: ["cc/opus", "cx/sol"],
        handleSingleModel,
        log,
      });

      expect(res.ok).toBe(false);
      expect(handleSingleModel).toHaveBeenCalledTimes(4);
    });
  });

  describe("#given a system prompt array that downstream mutates", () => {
    it("#then each attempt starts from an unmutated body", async () => {
      const body = {
        messages: [{ role: "user", content: "hi" }],
        system: [{ type: "text", text: "A" }, { type: "text", text: "B", cache_control: { type: "ephemeral" } }],
      };
      const seenLengths = [];
      const handleSingleModel = vi.fn(async (b) => {
        seenLengths.push(b.system.length);
        const idx = b.system.findIndex((x) => x.cache_control);
        b.system.splice(idx, 0, { type: "text", text: "CAVEMAN" });
        return emptyStreamResponse();
      });

      await handleComboChat({ body, models: ["cc/opus", "cx/sol"], handleSingleModel, log });

      expect(seenLengths).toEqual([2, 2, 2, 2]);
      expect(body.system).toHaveLength(2);
    });
  });

  describe("#given an openai body whose system message is appended to in place", () => {
    it("#then the injection never stacks across attempts", async () => {
      const body = { messages: [{ role: "system", content: "BASE" }, { role: "user", content: "hi" }] };
      const handleSingleModel = vi.fn(async (b) => {
        b.messages[0].content = `${b.messages[0].content}\n\nCAVEMAN`;
        return emptyStreamResponse();
      });

      await handleComboChat({ body, models: ["cx/sol", "glm/glm"], handleSingleModel, log });

      expect(body.messages[0].content).toBe("BASE");
    });
  });

  describe("#given a gemini body whose systemInstruction parts are pushed to", () => {
    it("#then the injection never stacks across attempts", async () => {
      const body = { systemInstruction: { parts: [{ text: "BASE" }] }, contents: [] };
      const handleSingleModel = vi.fn(async (b) => {
        b.systemInstruction.parts.push({ text: "CAVEMAN" });
        return emptyStreamResponse();
      });

      await handleComboChat({ body, models: ["gem/pro", "glm/glm"], handleSingleModel, log });

      expect(body.systemInstruction.parts).toHaveLength(1);
    });
  });
});

describe("fusion panel body isolation", () => {
  describe("#given a panel that fans out concurrently over a shared body", () => {
    it("#then every model sees the caller's original system prompt", async () => {
      const body = {
        messages: [{ role: "user", content: "hi" }],
        system: [{ type: "text", text: "BASE" }],
      };
      const seen = [];
      const handleSingleModel = vi.fn(async (b, model, isPanel) => {
        if (isPanel) {
          seen.push(b.system.map((s) => s.text).join("|"));
          // mirrors injectClaudeSystem mutating the body in place
          b.system.push({ type: "text", text: `INJECTED-${model}` });
          return okResponse(`answer from ${model}`);
        }
        return okResponse("judged");
      });

      await handleFusionChat({
        body,
        models: ["a/one", "b/two", "c/three"],
        handleSingleModel,
        log,
        judgeModel: "a/one",
      });

      expect(seen).toEqual(["BASE", "BASE", "BASE"]);
      expect(body.system).toHaveLength(1);
    });
  });

  describe("#given a single-model fusion panel", () => {
    it("#then the caller's body is not mutated", async () => {
      const body = { messages: [{ role: "user", content: "hi" }], system: [{ type: "text", text: "BASE" }] };
      const handleSingleModel = vi.fn(async (b) => {
        b.system.push({ type: "text", text: "INJECTED" });
        return okResponse("solo");
      });

      await handleFusionChat({ body, models: ["a/only"], handleSingleModel, log });

      expect(body.system).toHaveLength(1);
    });
  });
});

describe("empty stream account handling", () => {
  describe("#given an empty stream failure", () => {
    it("#then it falls through without locking the account", () => {
      const result = checkFallbackError(503, `[503]: ${EMPTY_STREAM_MESSAGE}`);
      expect(result.shouldFallback).toBe(true);
      expect(result.accountFault).toBe(false);
      expect(result.cooldownMs).toBe(0);
    });
  });

  describe("#given the result object the streaming handler actually returns", () => {
    it("#then it carries status and error so the account loop can classify it", () => {
      // chat.js passes result.status / result.error to markAccountUnavailable().
      // A bare { success, response } silently degrades to the default 30s lock.
      const result = createErrorResult(503, `[503]: ${EMPTY_STREAM_MESSAGE}`);
      expect(result.status).toBe(503);
      expect(result.error).toContain(EMPTY_STREAM_MESSAGE);

      const classified = checkFallbackError(result.status, result.error);
      expect(classified.accountFault).toBe(false);
      expect(classified.cooldownMs).toBe(0);
    });
  });

  describe("#given a genuine overloaded error", () => {
    it("#then it still backs the account off", () => {
      const result = checkFallbackError(503, "provider is overloaded");
      expect(result.shouldFallback).toBe(true);
      expect(result.accountFault).not.toBe(false);
    });
  });

  describe("#given the non-SSE guard result", () => {
    // Only 2xx reaches that guard: chatCore.js returns early for !providerResponse.ok,
    // so the status carried here is always a success code with an HTML/text body.
    it("#then a generic upstream page keeps the previous cooldown", () => {
      const result = createErrorResult(200, "[200]: Upstream returned non-SSE response (text/html)");
      expect(result.status).toBe(200);
      const classified = checkFallbackError(result.status, result.error);
      expect(classified.shouldFallback).toBe(true);
      expect(classified.cooldownMs).toBe(30000);
    });

    it("#then an upstream page naming a rate limit backs off instead of a flat wait", () => {
      const result = createErrorResult(200, "[200]: Rate limit exceeded - please retry");
      const classified = checkFallbackError(result.status, result.error);
      expect(classified.newBackoffLevel).toBe(1);
    });

    it("#then the message survives for the account loop to log", () => {
      const result = createErrorResult(200, "[200]: Attention Required! | Cloudflare");
      expect(result.error).toContain("Cloudflare");
      expect(result.response.status).toBe(200);
    });
  });
});
