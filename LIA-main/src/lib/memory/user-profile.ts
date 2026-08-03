import 'server-only';

import {
  createPerson,
  getDefaultPerson,
  listPeople,
  updatePerson,
  type PersonRecord,
} from './people';
import { migrateLegacyUserFactsToPeople } from './person-binding';

export { MAX_DISPLAY_NAME_LEN } from './people';

/** Display name = default (or only) person's name after migrate. */
export async function getUserDisplayName(): Promise<string | null> {
  await migrateLegacyUserFactsToPeople();
  const person = await getDefaultPerson();
  const name = person?.displayName?.trim();
  return name ? name : null;
}

/**
 * Set display name on the default person (create if none).
 * Empty string deletes nothing — clears to remove default name by deleting person
 * only when they have no other facts... Plan: empty → delete person if sole empty.
 * Keep simple: empty → rename not allowed; delete via people API. Here empty clears
 * by updating default person name only if we keep person — better create/update.
 */
export async function setUserDisplayName(name: string): Promise<void> {
  await migrateLegacyUserFactsToPeople();
  const trimmed = name.trim();
  const people = await listPeople();
  const def = people.find((p) => p.isDefault) ?? people[0] ?? null;

  if (!trimmed) {
    // Compatibility: clearing settings name does not wipe all people.
    return;
  }

  if (def) {
    await updatePerson(def.id, { displayName: trimmed, isDefault: true });
    return;
  }
  await createPerson({ displayName: trimmed, isDefault: true });
}

export async function listPeopleForSettings(): Promise<PersonRecord[]> {
  await migrateLegacyUserFactsToPeople();
  return listPeople();
}
