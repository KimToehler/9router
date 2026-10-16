import { ANTHROPIC_API_VERSION, buildAnthropicCompatibleMessagesUrl } from "../providers/shared.js";

const DEFAULT_PROBE_MODEL = "claude-3-haiku-20240307";

// Anthropic answers an unknown model with 404 not_found_error "model: <id>".
// That proves the key and the messages route work; only the probe model is
// not served there.
async function isUnknownModelError(res) {
  const body = await res.json().catch(() => null);
  return body?.type === "error"
    && body.error?.type === "not_found_error"
    && /model/i.test(body.error?.message || "");
}

/**
 * Check an anthropic-compatible key and base URL with a 1-token Messages call
 * on the same URL the executor routes to.
 *
 * 401/403 reject the key. Any other 404 means the messages route does not
 * exist at this base URL. Everything else (200, 400 bad model, 429, 529)
 * confirms the key was accepted.
 *
 * @param {{ baseUrl?: string, apiKey: string, model?: string }} probe
 * @param {(url: string, options: object) => Promise<Response>} [fetchFn]
 * @returns {Promise<{ valid: boolean, error: string|null }>}
 */
export async function probeAnthropicCompatible({ baseUrl, apiKey, model }, fetchFn = fetch) {
  const res = await fetchFn(buildAnthropicCompatibleMessagesUrl(baseUrl), {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_API_VERSION,
      "content-type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: model || DEFAULT_PROBE_MODEL,
      max_tokens: 1,
      messages: [{ role: "user", content: "test" }],
    }),
  });

  if (res.status === 401 || res.status === 403) {
    return { valid: false, error: "Invalid API key" };
  }
  if (res.status === 404 && !(await isUnknownModelError(res))) {
    return { valid: false, error: "Messages endpoint not found (404) - check the base URL" };
  }
  return { valid: true, error: null };
}
