// Shared SSE primitives (no imports → safe for executors + stream.js)
export const SSE_DONE = "data: [DONE]\n\n";

// Keep this literal in sync with UPSTREAM_MODEL_HEADER in open-sse/services/combo.js.
export const UPSTREAM_MODEL_HEADER_NAME = "X-9Router-Upstream-Model";
export const EXPOSE_HEADERS_HEADER = "Access-Control-Expose-Headers";

export const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  "Connection": "keep-alive"
};

// Variant for web-cookie executors behind nginx (disable proxy buffering)
export const SSE_HEADERS_NO_BUFFER = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  "X-Accel-Buffering": "no"
};

// Variant for client-facing SSE responses (adds permissive CORS)
export const SSE_HEADERS_CORS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  "Connection": "keep-alive",
  "Access-Control-Allow-Origin": "*",
  [EXPOSE_HEADERS_HEADER]: UPSTREAM_MODEL_HEADER_NAME
};

export const JSON_HEADERS_CORS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  [EXPOSE_HEADERS_HEADER]: UPSTREAM_MODEL_HEADER_NAME
};
