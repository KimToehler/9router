// OpenAI Chat Completions streams end with exactly one `data: [DONE]`, also
// when the upstream speaks another format and sends no sentinel.
import { describe, expect, it } from "vitest";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.js";

function byteStream(text) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

async function drain(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

const sse = (events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
const doneCount = (text) => text.split("\n").filter((l) => l.trim() === "data: [DONE]").length;

const CLAUDE_EVENTS = [
  { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "glm-5.3", content: [], usage: { input_tokens: 3, output_tokens: 0 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "pong" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
  { type: "message_stop" },
];

describe("OpenAI chat stream termination", () => {
  it("ends a Claude upstream translated for an OpenAI client with one [DONE]", async () => {
    const out = await drain(byteStream(sse(CLAUDE_EVENTS)).pipeThrough(
      createSSETransformStreamWithLogger(FORMATS.CLAUDE, FORMATS.OPENAI, "anthropic-compatible-x", null, null, "glm-5.3"),
    ));

    expect(out).toContain('"content":"pong"');
    expect(doneCount(out)).toBe(1);
    expect(out.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  it("forwards the upstream [DONE] once when an OpenAI stream is translated", async () => {
    const chunks = [
      { id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "pong" }, finish_reason: null }] },
      { id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ];
    const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
    const toolNameMap = new Map([["tool_x", "tool"]]);

    const out = await drain(byteStream(body).pipeThrough(
      createSSETransformStreamWithLogger(FORMATS.OPENAI, FORMATS.OPENAI, "deepseek", null, toolNameMap, "deepseek-chat"),
    ));

    expect(doneCount(out)).toBe(1);
  });

  it("does not add [DONE] for an Anthropic client", async () => {
    const chunks = [
      { id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "pong" }, finish_reason: "stop" }] },
    ];
    const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";

    const out = await drain(byteStream(body).pipeThrough(
      createSSETransformStreamWithLogger(FORMATS.OPENAI, FORMATS.CLAUDE, "deepseek", null, null, "deepseek-chat"),
    ));

    expect(out).toContain("message_stop");
    expect(doneCount(out)).toBe(0);
  });
});
