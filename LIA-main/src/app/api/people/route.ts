import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { parseBody } from '@/lib/infra/api-validation';
import {
  createPerson,
  deletePerson,
  listPeople,
  MAX_DISPLAY_NAME_LEN,
  MAX_PEOPLE,
  setDefaultPerson,
  updatePerson,
} from '@/lib/memory/people';
import { migrateLegacyUserFactsToPeople } from '@/lib/memory/person-binding';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const personBodySchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('create'),
    displayName: z.string().min(1).max(MAX_DISPLAY_NAME_LEN),
    aliases: z.array(z.string().max(MAX_DISPLAY_NAME_LEN)).max(8).optional(),
    isDefault: z.boolean().optional(),
  }),
  z.object({
    action: z.literal('update'),
    id: z.string().min(1),
    displayName: z.string().min(1).max(MAX_DISPLAY_NAME_LEN).optional(),
    aliases: z.array(z.string().max(MAX_DISPLAY_NAME_LEN)).max(8).optional(),
    isDefault: z.boolean().optional(),
  }),
  z.object({
    action: z.literal('delete'),
    id: z.string().min(1),
  }),
  z.object({
    action: z.literal('setDefault'),
    id: z.string().min(1),
  }),
]);

export async function GET() {
  await migrateLegacyUserFactsToPeople();
  const people = await listPeople();
  return NextResponse.json({ people, maxPeople: MAX_PEOPLE });
}

export async function POST(req: NextRequest) {
  try {
    const parsed = await parseBody(req, personBodySchema);
    if (!parsed.success) return parsed.response;
    const body = parsed.data;

    await migrateLegacyUserFactsToPeople();

    if (body.action === 'create') {
      const person = await createPerson({
        displayName: body.displayName,
        aliases: body.aliases,
        isDefault: body.isDefault,
      });
      return NextResponse.json({ people: await listPeople(), person });
    }
    if (body.action === 'update') {
      const person = await updatePerson(body.id, {
        displayName: body.displayName,
        aliases: body.aliases,
        isDefault: body.isDefault,
      });
      return NextResponse.json({ people: await listPeople(), person });
    }
    if (body.action === 'delete') {
      await deletePerson(body.id);
      return NextResponse.json({ people: await listPeople() });
    }
    if (body.action === 'setDefault') {
      const person = await setDefaultPerson(body.id);
      return NextResponse.json({ people: await listPeople(), person });
    }

    return NextResponse.json({ error: 'unknown action' }, { status: 400 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'people update failed';
    logger.warn('api', 'POST /api/people failed', { msg });
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
