/**
 * Capability route — single payload describing what Ollama can do right now.
 *
 * GET /api/capability → CapabilityProfile (Ollama health + models + effective slot resolution)
 *
 * Used by the frontend Settings dialog to populate the model dropdowns with
 * actually-pulled models and show effective fallback names.
 */

import { Hono } from "hono";
import { getCapabilityProfile } from "../llm/ollama.js";
import type { CapabilityProfile } from "@lia/shared";

export const capabilityRoute = new Hono();

capabilityRoute.get("/", async (c) => {
  try {
    const profile = await getCapabilityProfile();
    return c.json(profile satisfies CapabilityProfile);
  } catch (err) {
    // Never leave the UI with an empty Vite/proxy body — always JSON.
    return c.json(
      {
        ollamaOk: false,
        error: err instanceof Error ? err.message : String(err),
        models: [],
        chatModels: [],
        embedModels: [],
        effective: { chat: "", agent: "", heavy: "", embed: "" },
        embedExplicit: false,
      } satisfies CapabilityProfile,
      200,
    );
  }
});
