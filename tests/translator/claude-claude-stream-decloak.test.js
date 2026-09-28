// Regression test: claude → claude streaming passthrough must still decloak
// tool names. translateRequest() cloaks client tool names with CLAUDE_TOOL_SUFFIX
// for OAuth-cloaked Claude providers (cloakToolsOnOAuth) even when source and
// target formats match; the same-format fast path in translateResponse() used
// to return chunks untouched, leaking the suffixed name (e.g. "run_code_ide")
// to the client, which then rejected the call as an unknown tool.
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(() => Promise.resolve()),
  saveRequestDetail: vi.fn(() => Promise.resolve()),
  saveRequestUsage: vi.fn(() => Promise.resolve()),
  trackPendingRequest: vi.fn(),
}));

import "./registerAll.js";
import { translateResponse } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { CLAUDE_TOOL_SUFFIX } from "../../open-sse/config/appConstants.js";
import { handleStreamingResponse } from "../../open-sse/handlers/chatCore/streamingHandler.js";

const CLOAKED = "run_code" + CLAUDE_TOOL_SUFFIX;

const toolUseStart = (name) => ({
  type: "content_block_start",
  index: 1,
  content_block: { type: "tool_use", id: "toolu_01XYZ", name, input: {} }
});

function claudeSseResponse(chunk) {
  return new Response(`event: ${chunk.type}\ndata: ${JSON.stringify(chunk)}\n\n`, {
    headers: { "content-type": "text/event-stream" },
  });
}

function streamingHandlerOptions(toolNameMap) {
  return {
    providerResponse: claudeSseResponse(toolUseStart(CLOAKED)),
    provider: "claude",
    model: "claude-opus-5",
    sourceFormat: FORMATS.CLAUDE,
    targetFormat: FORMATS.CLAUDE,
    body: { model: "claude-opus-5", messages: [], stream: true },
    stream: true,
    requestStartTime: Date.now(),
    connectionId: "test",
    apiKey: "test-key",
    clientRawRequest: {},
    toolNameMap,
    streamController: {
      signal: new AbortController().signal,
      startTime: Date.now(),
      isConnected: () => true,
      handleComplete: vi.fn(),
      handleError: vi.fn(),
      handleDisconnect: vi.fn(),
      abort: vi.fn(),
    },
    streamDetailId: "claude-stream-decloak",
  };
}

async function firstDataFrame(response) {
  const line = (await response.text())
    .split("\n")
    .find((candidate) => candidate.startsWith("data: "));
  return JSON.parse(line.slice(6));
}

describe("Claude → Claude streaming passthrough (OAuth tool cloak)", () => {
  const state = { toolNameMap: new Map([[CLOAKED, "run_code"]]) };

  it("restores the original tool name on tool_use content_block_start", () => {
    const [out] = translateResponse(FORMATS.CLAUDE, FORMATS.CLAUDE, toolUseStart(CLOAKED), state);
    expect(out.content_block.name).toBe("run_code");
  });

  it("restores the original tool name through the streaming handler", async () => {
    const result = await handleStreamingResponse(streamingHandlerOptions(state.toolNameMap));

    const frame = await firstDataFrame(result.response);

    expect(frame.content_block.name).toBe("run_code");
  });

  it("keeps same-format streaming passthrough when no tool names were cloaked", async () => {
    const result = await handleStreamingResponse(streamingHandlerOptions(null));

    const frame = await firstDataFrame(result.response);

    expect(frame.content_block.name).toBe(CLOAKED);
  });

  it("leaves uncloaked chunks untouched (identity passthrough)", () => {
    const chunk = toolUseStart("Bash"); // decoy name, not in the map
    const [out] = translateResponse(FORMATS.CLAUDE, FORMATS.CLAUDE, chunk, state);
    expect(out).toBe(chunk);

    const textChunk = { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } };
    const [outText] = translateResponse(FORMATS.CLAUDE, FORMATS.CLAUDE, textChunk, state);
    expect(outText).toBe(textChunk);
  });

  it("falls back to suffix-stripping when no cloak map is present", () => {
    const chunk = toolUseStart(CLOAKED);
    const [out] = translateResponse(FORMATS.CLAUDE, FORMATS.CLAUDE, chunk, {});
    expect(out.content_block.name).toBe("run_code");
  });

  it("tolerates the null flush chunk", () => {
    const [out] = translateResponse(FORMATS.CLAUDE, FORMATS.CLAUDE, null, state);
    expect(out).toBeNull();
  });
});
