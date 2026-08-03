/**
 * Settings routes — model slots + identity.
 *
 * GET /api/settings         — current Ollama settings (ModelSlots shape)
 * PUT /api/settings         — update slots (partial update, empty string clears)
 *
 * M1 scope: model slots only. M3 adds identity (user name, persona) — same endpoint.
 */

import { Hono } from "hono";
import { z } from "zod";
import {
  getOllamaSettings,
  setOllamaSettings,
  isEmbedModelName,
} from "../llm/ollama.js";
import type { ModelSlots } from "@lia/shared";

export const settingsRoute = new Hono();

const updateSchema = z.object({
  baseUrl: z.string().trim().max(500).optional(),
  chat: z.string().trim().max(200).optional(),
  agent: z.string().trim().max(200).optional(),
  heavy: z.string().trim().max(200).optional(),
  embed: z.string().trim().max(200).optional(),
});

settingsRoute.get("/", async (c) => {
  const settings = await getOllamaSettings();
  return c.json({
    baseUrl: settings.baseUrl,
    chat: settings.chat,
    agent: settings.agent,
    heavy: settings.heavy,
    embed: settings.embed,
  } satisfies ModelSlots);
});

settingsRoute.put("/", async (c) => {
  const parsed = updateSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: "invalid_body", issues: parsed.error.issues }, 400);
  }

  const data = parsed.data;
  for (const slot of ["chat", "agent", "heavy"] as const) {
    const value = data[slot];
    if (value && isEmbedModelName(value)) {
      return c.json(
        {
          error: "invalid_model_slot",
          slot,
          message: `${slot} cannot use an embed-only model (${value})`,
        },
        400,
      );
    }
  }

  await setOllamaSettings(data);
  const settings = await getOllamaSettings();
  return c.json({
    baseUrl: settings.baseUrl,
    chat: settings.chat,
    agent: settings.agent,
    heavy: settings.heavy,
    embed: settings.embed,
  } satisfies ModelSlots);
});
