import 'server-only';

// People — up to 3 interlocutors per install (Person + PersonFact).
// Episode binds via EpisodeFact `lia.personId` (see person-binding.ts).

import { db } from '@/lib/db';
import { encryptField, decryptField } from '@/lib/infra/field-crypto';
import { escapeForPrompt } from '@/lib/infra/prompt-safety';

export const MAX_PEOPLE = 3;
export const MAX_DISPLAY_NAME_LEN = 80;

export type PersonRecord = {
  id: string;
  displayName: string;
  aliases: string[];
  isDefault: boolean;
  lastSeenAt: Date | null;
};

export type PersonFactRecord = {
  key: string;
  value: string;
  confidence: number;
};

function parseAliases(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((a): a is string => typeof a === 'string')
      .map((a) => a.trim())
      .filter(Boolean)
      .slice(0, 8);
  } catch {
    return [];
  }
}

function serializeAliases(aliases: string[]): string {
  return JSON.stringify(
    aliases.map((a) => a.trim()).filter(Boolean).slice(0, 8),
  );
}

function rowToPerson(row: {
  id: string;
  displayName: string;
  aliasesJson: string;
  isDefault: boolean;
  lastSeenAt: Date | null;
}): PersonRecord {
  return {
    id: row.id,
    displayName: row.displayName,
    aliases: parseAliases(row.aliasesJson),
    isDefault: row.isDefault,
    lastSeenAt: row.lastSeenAt,
  };
}

export async function listPeople(): Promise<PersonRecord[]> {
  const rows = await db.person.findMany({
    orderBy: [{ isDefault: 'desc' }, { lastSeenAt: 'desc' }, { createdAt: 'asc' }],
  });
  return rows.map(rowToPerson);
}

export async function getPerson(id: string): Promise<PersonRecord | null> {
  const row = await db.person.findUnique({ where: { id } });
  return row ? rowToPerson(row) : null;
}

export async function getDefaultPerson(): Promise<PersonRecord | null> {
  const def = await db.person.findFirst({ where: { isDefault: true } });
  if (def) return rowToPerson(def);
  const first = await db.person.findFirst({ orderBy: { createdAt: 'asc' } });
  return first ? rowToPerson(first) : null;
}

export async function countPeople(): Promise<number> {
  return db.person.count();
}

export function assertUnderPeopleCap(currentCount: number, adding = 1): void {
  if (currentCount + adding > MAX_PEOPLE) {
    throw new Error(`Максимум ${MAX_PEOPLE} человека в памяти Лии`);
  }
}

export async function createPerson(params: {
  displayName: string;
  aliases?: string[];
  isDefault?: boolean;
}): Promise<PersonRecord> {
  const displayName = params.displayName.trim();
  if (!displayName) throw new Error('display name required');
  if (displayName.length > MAX_DISPLAY_NAME_LEN) {
    throw new Error(`display name too long (max ${MAX_DISPLAY_NAME_LEN})`);
  }

  const count = await countPeople();
  assertUnderPeopleCap(count);

  const makeDefault = params.isDefault === true || count === 0;
  if (makeDefault) {
    await db.person.updateMany({ data: { isDefault: false } });
  }

  const row = await db.person.create({
    data: {
      displayName,
      aliasesJson: serializeAliases(params.aliases ?? []),
      isDefault: makeDefault,
      lastSeenAt: new Date(),
    },
  });
  return rowToPerson(row);
}

export async function updatePerson(
  id: string,
  patch: { displayName?: string; aliases?: string[]; isDefault?: boolean },
): Promise<PersonRecord> {
  const existing = await db.person.findUnique({ where: { id } });
  if (!existing) throw new Error('person not found');

  if (patch.isDefault === true) {
    await db.person.updateMany({ data: { isDefault: false } });
  }

  let displayName = existing.displayName;
  if (patch.displayName !== undefined) {
    displayName = patch.displayName.trim();
    if (!displayName) throw new Error('display name required');
    if (displayName.length > MAX_DISPLAY_NAME_LEN) {
      throw new Error(`display name too long (max ${MAX_DISPLAY_NAME_LEN})`);
    }
  }

  const row = await db.person.update({
    where: { id },
    data: {
      displayName,
      ...(patch.aliases !== undefined
        ? { aliasesJson: serializeAliases(patch.aliases) }
        : {}),
      ...(patch.isDefault !== undefined ? { isDefault: patch.isDefault } : {}),
    },
  });
  return rowToPerson(row);
}

export async function setDefaultPerson(id: string): Promise<PersonRecord> {
  return updatePerson(id, { isDefault: true });
}

export async function deletePerson(id: string): Promise<void> {
  const existing = await db.person.findUnique({ where: { id } });
  if (!existing) return;
  await db.person.delete({ where: { id } });
  if (existing.isDefault) {
    const next = await db.person.findFirst({ orderBy: { createdAt: 'asc' } });
    if (next) {
      await db.person.update({ where: { id: next.id }, data: { isDefault: true } });
    }
  }
}

export async function touchPersonSeen(id: string): Promise<void> {
  await db.person.update({
    where: { id },
    data: { lastSeenAt: new Date() },
  }).catch(() => { /* ignore missing */ });
}

export async function getPersonFacts(personId: string): Promise<PersonFactRecord[]> {
  const rows = await db.personFact.findMany({
    where: { personId },
    orderBy: { key: 'asc' },
  });
  return rows.map((r) => ({
    key: r.key,
    value: decryptField(r.value),
    confidence: r.confidence,
  }));
}

export async function upsertPersonFact(
  personId: string,
  key: string,
  value: string,
  confidence = 0.7,
): Promise<void> {
  const normKey = key
    .replace(/^(user\.)+/i, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[._]+|[._]+$/g, '');
  if (!normKey || normKey === 'name') return; // name lives on Person.displayName
  if (value.trim().length === 0 || value.trim().length >= 500) return;

  const encryptedValue = encryptField(value.trim());
  const existing = await db.personFact.findUnique({
    where: { personId_key: { personId, key: normKey } },
  });
  if (existing) {
    const prev = decryptField(existing.value);
    if (prev !== value.trim()) {
      await db.personFact.update({
        where: { personId_key: { personId, key: normKey } },
        data: { value: encryptedValue, confidence, updatedAt: new Date() },
      });
    } else {
      await db.personFact.update({
        where: { personId_key: { personId, key: normKey } },
        data: {
          confidence: Math.min(0.95, existing.confidence + 0.1),
          updatedAt: new Date(),
        },
      });
    }
  } else {
    try {
      await db.personFact.create({
        data: { personId, key: normKey, value: encryptedValue, confidence },
      });
    } catch (e: unknown) {
      if ((e as { code?: string })?.code !== 'P2002') throw e;
    }
  }
}

export async function renamePersonDisplayName(personId: string, name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > MAX_DISPLAY_NAME_LEN) return;
  const person = await getPerson(personId);
  if (!person) return;
  if (person.displayName.toLowerCase() === trimmed.toLowerCase()) return;
  const aliases = [...new Set([...person.aliases, person.displayName])]
    .filter((a) => a.toLowerCase() !== trimmed.toLowerCase())
    .slice(0, 8);
  await updatePerson(personId, { displayName: trimmed, aliases });
}

/**
 * Build prompt block for the active interlocutor only (not all people).
 */
export function formatPersonProfileForPrompt(
  person: PersonRecord,
  facts: PersonFactRecord[],
): string {
  const lines: string[] = ['Собеседник:'];
  lines.push(`  name: ${escapeForPrompt(person.displayName, { label: 'fact' })}`);
  if (person.aliases.length > 0) {
    lines.push(
      `  aliases: ${escapeForPrompt(person.aliases.join(', '), { label: 'fact' })}`,
    );
  }
  for (const f of facts) {
    lines.push(
      `  ${escapeForPrompt(`${f.key}: ${f.value}`, { label: 'fact' })}`,
    );
  }
  return lines.join('\n');
}

/** Normalize for name matching. */
export function normalizeNameToken(s: string): string {
  return s.trim().toLowerCase().replace(/ё/g, 'е');
}

/**
 * Deterministic speaker resolution from utterance.
 * Returns null if none or ambiguous.
 */
export function resolvePersonFromUtterance(
  text: string,
  people: PersonRecord[],
): PersonRecord | null {
  if (people.length === 0) return null;
  const raw = text.trim();
  if (!raw) return null;

  const candidates = new Map<string, PersonRecord>();

  const consider = (person: PersonRecord, matched: string) => {
    if (!matched.trim()) return;
    candidates.set(person.id, person);
  };

  const allLabels = (p: PersonRecord) =>
    [p.displayName, ...p.aliases].map((n) => n.trim()).filter(Boolean);

  // Explicit intro patterns: capture a name token after the cue.
  const introRes = [
    /(?<![\p{L}\p{N}])(?:меня\s+зовут|моё\s+имя|зови\s+меня)\s+([\p{L}][\p{L}\p{M}'-]{0,40})/giu,
    /(?<![\p{L}\p{N}])(?:это|я)\s+([\p{L}][\p{L}\p{M}'-]{0,40})(?![\p{L}\p{N}])/giu,
    /(?<![\p{L}\p{N}])(?:привет|здравствуй(?:те)?|hi|hello)\s*,?\s+([\p{L}][\p{L}\p{M}'-]{0,40})(?![\p{L}\p{N}])/giu,
  ];

  for (const re of introRes) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw)) !== null) {
      const token = normalizeNameToken(m[1] ?? '');
      if (!token || token.length < 2) continue;
      for (const p of people) {
        for (const label of allLabels(p)) {
          if (normalizeNameToken(label) === token) {
            consider(p, label);
          }
        }
      }
    }
  }

  // Whole-word mention of a known name (longer names first to reduce partials).
  const byLen = [...people].sort(
    (a, b) => b.displayName.length - a.displayName.length,
  );
  for (const p of byLen) {
    for (const label of allLabels(p)) {
      const esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, 'iu');
      if (re.test(raw)) consider(p, label);
    }
  }

  if (candidates.size === 1) return [...candidates.values()][0] ?? null;
  return null; // none or ambiguous
}

/**
 * Extract a claimed new name from intro phrases (for creating a person).
 */
export function extractClaimedNameFromUtterance(text: string): string | null {
  const patterns = [
    /(?<![\p{L}\p{N}])(?:меня\s+зовут|моё\s+имя|зови\s+меня)\s+([\p{L}][\p{L}\p{M}'-]{0,40})/iu,
    /(?<![\p{L}\p{N}])я\s+([\p{L}][\p{L}\p{M}'-]{0,40})(?![\p{L}\p{N}])/iu,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    const name = m?.[1]?.trim();
    if (name && name.length >= 2 && name.length <= MAX_DISPLAY_NAME_LEN) {
      const lower = normalizeNameToken(name);
      // Skip common non-names after «я »
      if (['не', 'же', 'тут', 'здесь', 'сейчас', 'просто', 'хочу', 'могу'].includes(lower)) {
        continue;
      }
      return name;
    }
  }
  return null;
}
