import 'server-only';

// Episode ↔ Person binding via EpisodeFact `lia.personId`.
// One-time migrate of legacy GlobalFact `user.*` → Person #1.

import {
  getAllGlobalFacts,
  getGlobalFact,
  upsertGlobalFact,
  upsertEpisodeFact,
  getEpisodeFacts,
  USER_NAME_FACT_KEY,
} from '@/lib/memory/facts';
import {
  countPeople,
  createPerson,
  getPerson,
  getPersonFacts,
  listPeople,
  upsertPersonFact,
  touchPersonSeen,
  type PersonRecord,
  type PersonFactRecord,
  MAX_PEOPLE,
  extractClaimedNameFromUtterance,
  resolvePersonFromUtterance,
  formatPersonProfileForPrompt,
} from '@/lib/memory/people';
import { logger } from '@/lib/logger';

export const PERSON_EPISODE_FACT_KEY = 'lia.personId';
export const PEOPLE_MIGRATED_FACT_KEY = 'lia.peopleMigrated';

export async function getEpisodePersonId(episodeId: string): Promise<string | null> {
  const facts = await getEpisodeFacts(episodeId);
  const row = facts.find((f) => f.key === PERSON_EPISODE_FACT_KEY);
  const id = row?.value?.trim();
  if (!id) return null;
  const person = await getPerson(id);
  return person ? id : null;
}

export async function bindEpisodePerson(
  episodeId: string,
  personId: string,
): Promise<void> {
  await upsertEpisodeFact(episodeId, PERSON_EPISODE_FACT_KEY, personId);
  await touchPersonSeen(personId);
}

/**
 * Migrate legacy user.* GlobalFacts into a single Person once.
 * Idempotent: skips if any Person exists or lia.peopleMigrated is set.
 */
export async function migrateLegacyUserFactsToPeople(): Promise<{
  migrated: boolean;
  personId: string | null;
}> {
  const existing = await countPeople();
  if (existing > 0) {
    return { migrated: false, personId: null };
  }

  const flag = await getGlobalFact(PEOPLE_MIGRATED_FACT_KEY);
  if (flag === '1') {
    return { migrated: false, personId: null };
  }

  const all = await getAllGlobalFacts();
  const userFacts = all.filter((f) => f.key.startsWith('user.'));
  if (userFacts.length === 0) {
    await upsertGlobalFact(PEOPLE_MIGRATED_FACT_KEY, '1', 1);
    return { migrated: false, personId: null };
  }

  const nameFact =
    userFacts.find((f) => f.key === USER_NAME_FACT_KEY)
    ?? userFacts.find((f) => f.key === 'user.user.name');
  const displayName = nameFact?.value?.trim() || 'Собеседник';

  try {
    const person = await createPerson({
      displayName,
      isDefault: true,
    });
    for (const f of userFacts) {
      const key = f.key.replace(/^(user\.)+/i, '');
      if (!key || key === 'name' || key === 'user.name') continue;
      await upsertPersonFact(person.id, key, f.value, f.confidence);
    }
    await upsertGlobalFact(PEOPLE_MIGRATED_FACT_KEY, '1', 1);
    logger.info('memory', 'Migrated legacy user.* to Person', {
      personId: person.id.slice(0, 8),
      factCount: userFacts.length,
    });
    return { migrated: true, personId: person.id };
  } catch (e) {
    logger.warn('memory', 'Legacy people migrate failed', {}, e);
    return { migrated: false, personId: null };
  }
}

export type SpeakerResolution = {
  people: PersonRecord[];
  personId: string | null;
  person: PersonRecord | null;
  facts: PersonFactRecord[];
  /** Bound this turn via utterance match or auto-bind. */
  newlyBound: boolean;
  /** Unbound with ≥2 people and no match — ask who. */
  needIdentifySpeaker: boolean;
  knownPeopleNames: string[];
  userProfile: string | undefined;
  userNameKnown: boolean;
};

/**
 * Ensure people migrated, resolve/bind speaker for this episode+message.
 */
export async function resolveSpeakerForTurn(params: {
  episodeId: string;
  userText: string;
}): Promise<SpeakerResolution> {
  await migrateLegacyUserFactsToPeople();

  const people = await listPeople();
  const knownPeopleNames = people.map((p) => p.displayName);
  let personId = await getEpisodePersonId(params.episodeId);
  let newlyBound = false;

  if (!personId) {
    const matched = resolvePersonFromUtterance(params.userText, people);
    if (matched) {
      await bindEpisodePerson(params.episodeId, matched.id);
      personId = matched.id;
      newlyBound = true;
    } else if (people.length === 1 && people[0]) {
      await bindEpisodePerson(params.episodeId, people[0].id);
      personId = people[0].id;
      newlyBound = true;
    } else if (people.length === 0) {
      const claimed = extractClaimedNameFromUtterance(params.userText);
      if (claimed) {
        try {
          const created = await createPerson({ displayName: claimed, isDefault: true });
          await bindEpisodePerson(params.episodeId, created.id);
          personId = created.id;
          newlyBound = true;
        } catch {
          /* cap or validation — leave unbound */
        }
      }
    } else if (people.length >= 2) {
      // Cap: if they claim a new name and under max, create+bind.
      const claimed = extractClaimedNameFromUtterance(params.userText);
      if (claimed && people.length < MAX_PEOPLE) {
        const already = resolvePersonFromUtterance(claimed, people);
        if (!already) {
          try {
            const created = await createPerson({ displayName: claimed });
            await bindEpisodePerson(params.episodeId, created.id);
            personId = created.id;
            newlyBound = true;
          } catch {
            /* ignore */
          }
        }
      }
    }
  }

  // Refresh list if we created someone
  const peopleNow = newlyBound ? await listPeople() : people;
  const person = personId
    ? (peopleNow.find((p) => p.id === personId) ?? await getPerson(personId))
    : null;
  const facts = personId ? await getPersonFacts(personId) : [];
  const needIdentifySpeaker = !personId && peopleNow.length >= 2;
  const userProfile = person
    ? formatPersonProfileForPrompt(person, facts)
    : undefined;

  return {
    people: peopleNow,
    personId,
    person,
    facts,
    newlyBound,
    needIdentifySpeaker,
    knownPeopleNames: peopleNow.map((p) => p.displayName),
    userProfile,
    userNameKnown: !!person?.displayName,
  };
}
