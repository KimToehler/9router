import { describe, it, expect, vi } from "vitest";

import { handleComboChat } from "../../open-sse/services/combo.js";
import { peekStreamForContent, EMPTY_STREAM_MESSAGE } from "../../open-sse/utils/emptyStreamPeek.js";
import { checkFallbackError } from "../../open-sse/services/accountFallback.js";

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

  describe("#given a genuine overloaded error", () => {
    it("#then it still backs the account off", () => {
      const result = checkFallbackError(503, "provider is overloaded");
      expect(result.shouldFallback).toBe(true);
      expect(result.accountFault).not.toBe(false);
    });
  });
});
