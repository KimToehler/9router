import { handleChat } from "@/sse/handlers/chat.js";
import { initTranslators } from "open-sse/translator/index.js";
import { transformToOllama } from "open-sse/utils/ollamaTransform.js";

let initialized = false;

async function ensureInitialized() {
  if (!initialized) {
    await initTranslators();
    initialized = true;
  }
}

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*"
    }
  });
}

export async function POST(request) {
  await ensureInitialized();
  
  let body;
  try {
    body = await request.clone().json();
  } catch {
    // Let handleChat answer the malformed body with its usual 400.
    return transformToOllama(await handleChat(request), "llama3.2");
  }
  const modelName = body.model || "llama3.2";

  // Ollama's /api/chat streams unless the client sends stream:false.
  if (typeof body.stream !== "boolean") body.stream = true;

  const response = await handleChat(new Request(request.url, {
    method: "POST",
    headers: request.headers,
    body: JSON.stringify(body),
  }));
  return transformToOllama(response, modelName);
}

