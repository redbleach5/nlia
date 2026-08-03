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
  const profile = await getCapabilityProfile();
  return c.json(profile satisfies CapabilityProfile);
});
