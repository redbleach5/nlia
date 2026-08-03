/**
 * Memory routes — facts, memories, decisions, reflection.
 *
 * GET  /api/episodes/:episodeId/facts        — episode facts
 * GET  /api/global-facts                      — all global facts
 * DELETE /api/global-facts/:key               — delete a global fact
 * GET  /api/episodes/:episodeId/memories      — emotional memories
 * GET  /api/episodes/:episodeId/decisions     — decision log
 * POST /api/episodes/:episodeId/reflect       — trigger reflection (stub by default; full via LIA_REFLECTION_LLM=1)
 */

import { Hono } from "hono";
import {
  getEpisodeFacts,
  getAllGlobalFacts,
  deleteGlobalFact,
  type GlobalFactDTO,
  type EpisodeFactDTO,
} from "../memory/facts.js";
import {
  listEmotionalMemories,
  type EmotionalMemoryDTO,
} from "../memory/emotional-memory.js";
import {
  listDecisions,
  createDecision,
  type DecisionDTO,
  type DecisionModelRole,
} from "../memory/decisions.js";
import { runReflection, type ReflectionResult } from "../memory/reflection-engine.js";
import { listPeople, createPerson, type Person } from "../memory/people.js";
import { z } from "zod";


export const memoryRoute = new Hono();

const createDecisionSchema = z.object({
  situation: z.string().trim().min(1).max(2000),
  options: z.array(z.string().trim().min(1).max(500)).min(1).max(10),
  chosen: z.string().trim().min(1).max(500),
  rationale: z.string().trim().min(1).max(2000),
  modelRole: z.enum(["day", "heavy", "agent"]).optional(),
  taskId: z.string().trim().max(100).optional(),
});

// ─── Episode facts ────────────────────────────────────────────────────
memoryRoute.get("/episodes/:episodeId/facts", (c) => {
  const episodeId = c.req.param("episodeId") ?? "";
  if (!episodeId) return c.json({ error: "missing_episodeId" }, 400);
  const facts = getEpisodeFacts(episodeId);
  return c.json({ facts: facts satisfies EpisodeFactDTO[] });
});

// ─── Global facts ─────────────────────────────────────────────────────
memoryRoute.get("/global-facts", (c) => {
  const facts = getAllGlobalFacts();
  return c.json({ facts: facts satisfies GlobalFactDTO[] });
});

memoryRoute.delete("/global-facts/:key", (c) => {
  const key = c.req.param("key");
  if (!key) return c.json({ error: "missing_key" }, 400);
  deleteGlobalFact(decodeURIComponent(key));
  return c.json({ ok: true, key });
});

// ─── Emotional memories ───────────────────────────────────────────────
memoryRoute.get("/episodes/:episodeId/memories", (c) => {
  const episodeId = c.req.param("episodeId") ?? "";
  if (!episodeId) return c.json({ error: "missing_episodeId" }, 400);
  const includeConsolidated = c.req.query("includeConsolidated") === "true";
  const memories = listEmotionalMemories(episodeId, { limit: 50, includeConsolidated });
  return c.json({ memories: memories satisfies EmotionalMemoryDTO[] });
});

// ─── Decisions ────────────────────────────────────────────────────────
memoryRoute.get("/episodes/:episodeId/decisions", (c) => {
  const episodeId = c.req.param("episodeId") ?? "";
  if (!episodeId) return c.json({ error: "missing_episodeId" }, 400);
  const taskId = c.req.query("taskId") ?? undefined;
  const decisions = listDecisions(episodeId, { limit: 50, taskId });
  return c.json({ decisions: decisions satisfies DecisionDTO[] });
});

memoryRoute.post("/episodes/:episodeId/decisions", async (c) => {
  const episodeId = c.req.param("episodeId") ?? "";
  if (!episodeId) return c.json({ error: "missing_episodeId" }, 400);

  const parsed = createDecisionSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "invalid_body", issues: parsed.error.issues }, 400);
  }

  const decision = createDecision({
    episodeId,
    taskId: parsed.data.taskId,
    situation: parsed.data.situation,
    options: parsed.data.options,
    chosen: parsed.data.chosen,
    rationale: parsed.data.rationale,
    modelRole: (parsed.data.modelRole ?? "day") as DecisionModelRole,
  });
  return c.json({ decision }, 201);
});

// ─── People (multi-person profiles) ──────────────────────────────────
memoryRoute.get("/people", (c) => {
  const people = listPeople();
  return c.json({ people: people satisfies Person[] });
});

const createPersonSchema = z.object({
  displayName: z.string().trim().min(1).max(100),
  isDefault: z.boolean().optional(),
});

memoryRoute.post("/people", async (c) => {
  const parsed = createPersonSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "invalid_body", issues: parsed.error.issues }, 400);
  }
  const person = createPerson({
    displayName: parsed.data.displayName,
    isDefault: parsed.data.isDefault,
  });
  return c.json({ person: person satisfies Person }, 201);
});

// ─── Reflection ───────────────────────────────────────────────────────
memoryRoute.post("/episodes/:episodeId/reflect", async (c) => {

  const episodeId = c.req.param("episodeId") ?? "";
  if (!episodeId) return c.json({ error: "missing_episodeId" }, 400);

  const result = await runReflection(episodeId);
  return c.json(result satisfies ReflectionResult);
});
