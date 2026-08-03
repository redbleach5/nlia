/**
 * Memory module tests — facts, emotional memory, decisions, reflection.
 *
 * Tests the M3 memory stack:
 *   - Global fact upsert/get/delete
 *   - Episode fact upsert/get
 *   - Emotional memory store/list/shouldStore
 *   - Decision CRUD (create/list/get/updateOutcome)
 *   - Reflection engine stub (returns ran=false)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { app } from "../src/index.js";
import { closeDb, getDb } from "../src/db/client.js";
import { pushSchema } from "../src/db/push.js";
import { createEpisode } from "../src/services/episodes.js";
import {
  upsertGlobalFact,
  getGlobalFact,
  getAllGlobalFacts,
  deleteGlobalFact,
  upsertEpisodeFact,
  getEpisodeFacts,
  getUserNameFromFacts,
  formatGlobalFactsForPrompt,
  formatEpisodeFactsForPrompt,
} from "../src/memory/facts.js";
import {
  storeEmotionalMemory,
  listEmotionalMemories,
  shouldStoreEmotionalMemory,
  formatEmotionalMemoriesForPrompt,
} from "../src/memory/emotional-memory.js";
import {
  createDecision,
  getDecision,
  listDecisions,
  updateDecisionOutcome,
  formatDecisionsForPrompt,
} from "../src/memory/decisions.js";
import { runReflection } from "../src/memory/reflection-engine.js";
import type { EmotionVector } from "../src/identity/emotional-state.js";

describe("Facts service", () => {
  beforeAll(() => {
    getDb();
    pushSchema();
  });
  afterAll(() => closeDb());

  it("upserts and retrieves global facts", () => {
    upsertGlobalFact("user.name", "TestUser", 0.8);
    expect(getGlobalFact("user.name")).toBe("TestUser");

    // Update same value → confidence bumps
    upsertGlobalFact("user.name", "TestUser", 0.8);
    const facts = getAllGlobalFacts();
    const nameFact = facts.find((f) => f.key === "user.name");
    expect(nameFact).toBeDefined();
    expect(nameFact!.confidence).toBeGreaterThan(0.8);

    // Update different value → value changes
    upsertGlobalFact("user.name", "NewName", 0.7);
    expect(getGlobalFact("user.name")).toBe("NewName");
  });

  it("deletes global facts", () => {
    upsertGlobalFact("test.temp", "value", 0.5);
    deleteGlobalFact("test.temp");
    expect(getGlobalFact("test.temp")).toBeNull();
  });

  it("extracts user name from facts", () => {
    upsertGlobalFact("user.name", "Alice", 0.9);
    upsertGlobalFact("user.profession", "developer", 0.7);
    const facts = getAllGlobalFacts();
    expect(getUserNameFromFacts(facts)).toBe("Alice");
  });

  it("upserts and retrieves episode facts", () => {
    const ep = createEpisode({ title: "Facts test" });
    upsertEpisodeFact(ep.id, "current.project", "Lia v3");
    upsertEpisodeFact(ep.id, "current.topic", "testing");

    const facts = getEpisodeFacts(ep.id);
    expect(facts.length).toBeGreaterThanOrEqual(2);
    const project = facts.find((f) => f.key === "current.project");
    expect(project?.value).toBe("Lia v3");
  });

  it("formats global facts for prompt", () => {
    upsertGlobalFact("user.name", "Bob", 0.9);
    const facts = getAllGlobalFacts();
    const formatted = formatGlobalFactsForPrompt(facts);
    expect(formatted).toContain("Собеседник:");
    expect(formatted).toContain("user.name: Bob");
  });

  it("formats episode facts for prompt", () => {
    const ep = createEpisode({ title: "Format test" });
    upsertEpisodeFact(ep.id, "current.task", "writing tests");
    const facts = getEpisodeFacts(ep.id);
    const formatted = formatEpisodeFactsForPrompt(facts);
    expect(formatted).toContain("current.task: writing tests");
  });
});

describe("Emotional memory service", () => {
  beforeAll(() => {
    getDb();
    pushSchema();
  });
  afterAll(() => closeDb());

  it("stores and lists emotional memories", () => {
    const ep = createEpisode({ title: "Emotional memory test" });
    storeEmotionalMemory({
      episodeId: ep.id,
      emotion: "joy",
      intensity: 0.8,
      trigger: "user expressed enthusiasm",
      context: "User said 'ура' after successful deploy",
      emotionVector: { joy: 0.8, curiosity: 0.5, calm: 0.6, irritation: 0.1, sadness: 0.1 },
    });

    const memories = listEmotionalMemories(ep.id);
    expect(memories.length).toBeGreaterThanOrEqual(1);
    expect(memories[0].emotion).toBe("joy");
    expect(memories[0].intensity).toBeLessThanOrEqual(0.8); // decay applied
  });

  it("shouldStoreEmotionalMemory detects significant moments", () => {
    const vec: EmotionVector = { joy: 0.7, curiosity: 0.5, calm: 0.6, irritation: 0.1, sadness: 0.1 };

    // Sad topic → should store
    expect(shouldStoreEmotionalMemory(["sadTopic"], vec).store).toBe(true);

    // Rudeness → should store
    expect(shouldStoreEmotionalMemory(["rudeness"], vec).store).toBe(true);

    // Enthusiasm with high joy → should store
    expect(shouldStoreEmotionalMemory(["enthusiasm"], { ...vec, joy: 0.8 }).store).toBe(true);

    // Neutral triggers → should not store
    expect(shouldStoreEmotionalMemory(["trivial"], vec).store).toBe(false);
  });

  it("formats emotional memories for prompt", () => {
    const ep = createEpisode({ title: "Format emotional test" });
    storeEmotionalMemory({
      episodeId: ep.id,
      emotion: "sadness",
      intensity: 0.7,
      trigger: "user mentioned loss",
      context: "User's grandfather passed away",
    });

    const memories = listEmotionalMemories(ep.id);
    const formatted = formatEmotionalMemoriesForPrompt(memories);
    expect(formatted).toContain("ЭМОЦИОНАЛЬНАЯ ПАМЯТЬ");
    expect(formatted).toContain("sadness");
  });
});

describe("Decisions service", () => {
  beforeAll(() => {
    getDb();
    pushSchema();
  });
  afterAll(() => closeDb());

  it("creates and retrieves a decision", () => {
    const ep = createEpisode({ title: "Decisions test" });
    const decision = createDecision({
      episodeId: ep.id,
      situation: "User asked about Python vs JavaScript",
      options: ["recommend Python", "recommend JavaScript", "ask for context"],
      chosen: "ask for context",
      rationale: "Need to know user's goal before recommending",
      modelRole: "day",
    });

    expect(decision.id).toBeTruthy();
    expect(decision.chosen).toBe("ask for context");
    expect(decision.options).toHaveLength(3);

    const fetched = getDecision(decision.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.rationale).toContain("Need to know");
  });

  it("lists decisions for an episode", () => {
    const ep = createEpisode({ title: "List decisions test" });
    createDecision({
      episodeId: ep.id,
      situation: "Situation 1",
      options: ["a", "b"],
      chosen: "a",
      rationale: "reason 1",
      modelRole: "day",
    });
    createDecision({
      episodeId: ep.id,
      situation: "Situation 2",
      options: ["c", "d"],
      chosen: "d",
      rationale: "reason 2",
      modelRole: "day",
    });

    const decisions = listDecisions(ep.id);
    expect(decisions.length).toBeGreaterThanOrEqual(2);
  });

  it("updates decision outcome", () => {
    const ep = createEpisode({ title: "Outcome test" });
    const decision = createDecision({
      episodeId: ep.id,
      situation: "Test outcome",
      options: ["option"],
      chosen: "option",
      rationale: "testing",
      modelRole: "day",
    });

    expect(decision.outcome).toBeNull();
    const updated = updateDecisionOutcome(decision.id, "User was satisfied");
    expect(updated?.outcome).toBe("User was satisfied");
  });

  it("formats decisions for prompt", () => {
    const ep = createEpisode({ title: "Format decisions test" });
    createDecision({
      episodeId: ep.id,
      situation: "Test situation for formatting",
      options: ["a", "b"],
      chosen: "a",
      rationale: "test rationale",
      modelRole: "day",
    });

    const decisions = listDecisions(ep.id);
    const formatted = formatDecisionsForPrompt(decisions);
    expect(formatted).toContain("ЖУРНАЛ РЕШЕНИЙ");
    expect(formatted).toContain("Test situation");
  });
});

describe("Reflection engine stub", () => {
  beforeAll(() => {
    getDb();
    pushSchema();
  });
  afterAll(() => closeDb());

  it("returns ran=false in M3 stub", async () => {
    const ep = createEpisode({ title: "Reflection test" });
    const result = await runReflection(ep.id);
    expect(result.ran).toBe(false);
    expect(result.newFacts).toEqual([]);
    expect(result.summary).toContain("stub");
  });

  it("summary mentions emotional memories + decisions considered", async () => {
    const ep = createEpisode({ title: "Reflection summary test" });
    storeEmotionalMemory({
      episodeId: ep.id,
      emotion: "joy",
      intensity: 0.7,
      trigger: "test",
      context: "test context",
    });
    const result = await runReflection(ep.id);
    expect(result.summary).toContain("emotional memories");
    expect(result.summary).toContain("decisions");
  });
});

describe("Memory API routes", () => {
  let episodeId: string;

  beforeAll(() => {
    getDb();
    pushSchema();
    const ep = createEpisode({ title: "API routes test" });
    episodeId = ep.id;
  });
  afterAll(() => closeDb());

  it("GET /api/episodes/:episodeId/facts returns episode facts", async () => {
    upsertEpisodeFact(episodeId, "current.test", "api test value");
    const res = await app.request(`/api/episodes/${episodeId}/facts`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.facts).toBeInstanceOf(Array);
    expect(body.facts.some((f: { key: string }) => f.key === "current.test")).toBe(true);
  });

  it("GET /api/global-facts returns all global facts", async () => {
    upsertGlobalFact("test.api", "test value", 0.5);
    const res = await app.request("/api/global-facts");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.facts).toBeInstanceOf(Array);
    expect(body.facts.some((f: { key: string }) => f.key === "test.api")).toBe(true);
  });

  it("GET /api/episodes/:episodeId/memories returns emotional memories", async () => {
    storeEmotionalMemory({
      episodeId,
      emotion: "curiosity",
      intensity: 0.6,
      trigger: "api test",
      context: "test context",
    });
    const res = await app.request(`/api/episodes/${episodeId}/memories`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.memories).toBeInstanceOf(Array);
    expect(body.memories.length).toBeGreaterThanOrEqual(1);
  });

  it("GET /api/episodes/:episodeId/decisions returns decision log", async () => {
    createDecision({
      episodeId,
      situation: "API test decision",
      options: ["a", "b"],
      chosen: "a",
      rationale: "testing API",
      modelRole: "day",
    });
    const res = await app.request(`/api/episodes/${episodeId}/decisions`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.decisions).toBeInstanceOf(Array);
    expect(body.decisions.length).toBeGreaterThanOrEqual(1);
  });

  it("POST /api/episodes/:episodeId/reflect returns stub result", async () => {
    const res = await app.request(`/api/episodes/${episodeId}/reflect`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ran).toBe(false);
    expect(body.newFacts).toEqual([]);
  });
});
