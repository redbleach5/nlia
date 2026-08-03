/**
 * People module — multi-person profiles (up to 3 per instance).
 * Ported from v2 src/lib/memory/people.ts. Per § Appendix A: "port".
 *
 * Supports 2-3 people profiles per Lia instance. Each episode is bound to
 * a person via EpisodeFact key `lia.personId`. Person + PersonFact tables
 * would be added in a schema migration.
 *
 * M8 patch: uses GlobalFact with prefixed keys as a fallback when
 * Person/PersonFact tables don't exist yet. This preserves multi-person
 * capability without requiring a schema migration.
 */

import { getAllGlobalFacts, upsertGlobalFact } from "./facts.js";

export interface Person {
  id: string;
  displayName: string;
  aliases: string[];
  isDefault: boolean;
  lastSeenAt: number | null;
}

export interface PersonFact {
  personId: string;
  key: string;
  value: string;
  confidence: number;
}

export const MAX_PEOPLE = 3;
const PERSON_KEY_PREFIX = "person.";

/**
 * List all people (from GlobalFact with person.* prefix).
 */
export function listPeople(): Person[] {
  const facts = getAllGlobalFacts();
  const personFacts = facts.filter((f) => f.key.startsWith(PERSON_KEY_PREFIX));

  // Group by personId
  const personMap = new Map<string, Person>();

  for (const fact of personFacts) {
    // key format: person.<personId>.<field>
    const parts = fact.key.split(".");
    if (parts.length < 3) continue;
    const personId = parts[1]!;
    const field = parts.slice(2).join(".");

    if (!personMap.has(personId)) {
      personMap.set(personId, {
        id: personId,
        displayName: personId,
        aliases: [],
        isDefault: false,
        lastSeenAt: null,
      });
    }

    const person = personMap.get(personId)!;
    if (field === "name") {
      person.displayName = fact.value;
    } else if (field === "aliases") {
      try {
        person.aliases = JSON.parse(fact.value);
      } catch {
        person.aliases = [];
      }
    } else if (field === "default") {
      person.isDefault = fact.value === "true";
    } else if (field === "lastSeen") {
      person.lastSeenAt = parseInt(fact.value, 10) || null;
    }
  }

  return Array.from(personMap.values());
}

/**
 * Create a new person profile.
 */
export function createPerson(opts: {
  displayName: string;
  isDefault?: boolean;
}): Person {
  const people = listPeople();
  if (people.length >= MAX_PEOPLE) {
    throw new Error(`Max ${MAX_PEOPLE} people per instance`);
  }

  const id = `p_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const now = Math.floor(Date.now() / 1000);

  upsertGlobalFact(`${PERSON_KEY_PREFIX}${id}.name`, opts.displayName, 0.9);
  upsertGlobalFact(`${PERSON_KEY_PREFIX}${id}.aliases`, "[]", 0.7);
  upsertGlobalFact(`${PERSON_KEY_PREFIX}${id}.default`, opts.isDefault ? "true" : "false", 0.9);
  upsertGlobalFact(`${PERSON_KEY_PREFIX}${id}.lastSeen`, String(now), 0.7);

  return {
    id,
    displayName: opts.displayName,
    aliases: [],
    isDefault: opts.isDefault ?? false,
    lastSeenAt: now,
  };
}

/**
 * Resolve a person from an utterance (name match against display name + aliases).
 */
export function resolvePersonFromUtterance(
  utterance: string,
  people: Person[],
): Person | null {
  const lower = utterance.toLowerCase();
  for (const person of people) {
    if (lower.includes(person.displayName.toLowerCase())) return person;
    for (const alias of person.aliases) {
      if (lower.includes(alias.toLowerCase())) return person;
    }
  }
  return null;
}

/**
 * Extract a claimed name from an utterance.
 * Matches patterns like "меня зовут X", "я X", "зови меня X".
 */
export function extractClaimedNameFromUtterance(utterance: string): string | null {
  const patterns = [
    /меня зовут\s+([А-Яа-яЁёA-Za-z]+)/i,
    /я\s+([А-Яа-яЁёA-Za-z]{2,20}),?\s*(?:а ты|приятно|давай)/i,
    /зови меня\s+([А-Яа-яЁёA-Za-z]+)/i,
    /мо[её] имя\s+([А-Яа-яЁёA-Za-z]+)/i,
  ];
  for (const re of patterns) {
    const match = utterance.match(re);
    if (match?.[1]) {
      const name = match[1].trim();
      // Capitalize first letter
      return name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
    }
  }
  return null;
}

/**
 * Rename a person's display name.
 */
export function renamePersonDisplayName(personId: string, newName: string): void {
  upsertGlobalFact(`${PERSON_KEY_PREFIX}${personId}.name`, newName, 0.9);
}

/**
 * Upsert a person fact.
 */
export function upsertPersonFact(personId: string, key: string, value: string): void {
  upsertGlobalFact(`${PERSON_KEY_PREFIX}${personId}.${key}`, value, 0.7);
}
