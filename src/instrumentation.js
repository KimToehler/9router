export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initConsoleLogCapture } = await import("@/lib/consoleLogBuffer");
    initConsoleLogCapture();

    // Server-only: lets capabilities.js read the synced catalog without pulling
    // node:fs into the dashboard's browser bundle.
    const { installCatalogSource } = await import("open-sse/providers/catalogOverride.js");
    await installCatalogSource();

    // Custom-model capability flags; routing falls back to table caps on failure.
    const { installCustomModelCaps } = await import("@/lib/customModelCaps.js");
    await installCustomModelCaps().catch((err) => console.warn("[CustomCaps] install failed:", err?.message));

    const { startModelCatalogSync } = await import("@/lib/modelCatalog/sync.js");
    startModelCatalogSync();
  }
}
