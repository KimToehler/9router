// Ollama /api/chat answers stream:false with one JSON object, keeps the
// error status, and ends a stream with exactly one done:true line.
import { describe, expect, it } from "vitest";
import { transformToOllama } from "../../open-sse/utils/ollamaTransform.js";

function byteStream(text) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

const ndjson = (text) => text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));

describe("Ollama /api/chat responses", () => {
  it("turns a non-streaming chat completion into one Ollama JSON object", async () => {
    const completion = {
      id: "chatcmpl-1",
      object: "chat.completion",
      model: "glm-5.3",
      choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    };
    const output = await transformToOllama(new Response(JSON.stringify(completion), {
      headers: { "content-type": "application/json" },
    }), "bifrost/glm-5.3");

    expect(output.status).toBe(200);
    expect(output.headers.get("content-type")).toBe("application/json");
    expect(await output.json()).toMatchObject({
      model: "bifrost/glm-5.3",
      message: { role: "assistant", content: "pong" },
      done: true,
      done_reason: "stop",
      prompt_eval_count: 3,
      eval_count: 1,
    });
  });

  it("returns non-streaming tool calls with parsed arguments", async () => {
    const completion = {
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Berlin"}' } }],
        },
        finish_reason: "tool_calls",
      }],
    };
    const output = await transformToOllama(new Response(JSON.stringify(completion), {
      headers: { "content-type": "application/json" },
    }), "m");

    const body = await output.json();
    expect(body.message.content).toBe("");
    expect(body.message.tool_calls).toEqual([{ function: { name: "get_weather", arguments: { city: "Berlin" } } }]);
  });

  it("keeps the status of an error response", async () => {
    const output = await transformToOllama(new Response(JSON.stringify({ error: { message: "Invalid API key" } }), {
      status: 401,
      headers: { "content-type": "application/json" },
    }), "m");

    expect(output.status).toBe(401);
    expect(await output.json()).toEqual({ error: "Invalid API key" });
  });

  it("ends a stream with exactly one done line", async () => {
    const chunks = [
      { choices: [{ index: 0, delta: { content: "pong" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ];
    const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
    const output = await transformToOllama(new Response(byteStream(body), {
      headers: { "content-type": "text/event-stream" },
    }), "m");

    const lines = ndjson(await output.text());
    expect(lines.map((l) => l.message.content).join("")).toBe("pong");
    expect(lines.filter((l) => l.done)).toHaveLength(1);
    expect(lines.at(-1).done).toBe(true);
  });
});
