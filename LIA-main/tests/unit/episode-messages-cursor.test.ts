import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db } from '@/lib/db';
import { getMessages } from '@/lib/memory/episodes';

describe('getMessages cursor pagination', () => {
  let episodeId: string;
  const ids: string[] = [];

  beforeAll(async () => {
    const ep = await db.episode.create({ data: { title: 'cursor-page-test' } });
    episodeId = ep.id;
    // 5 messages with distinct timestamps
    for (let i = 0; i < 5; i++) {
      const row = await db.message.create({
        data: {
          episodeId,
          role: i % 2 === 0 ? 'user' : 'companion',
          content: `msg-${i}`,
          createdAt: new Date(Date.UTC(2026, 0, 1, 12, 0, i)),
        },
      });
      ids.push(row.id);
    }
  });

  afterAll(async () => {
    await db.message.deleteMany({ where: { episodeId } }).catch(() => null);
    await db.episode.delete({ where: { id: episodeId } }).catch(() => null);
  });

  it('without cursor returns last N chronologically', async () => {
    const page = await getMessages(episodeId, 3);
    expect(page.map(m => m.content)).toEqual(['msg-2', 'msg-3', 'msg-4']);
  });

  it('with cursor returns older messages before the window', async () => {
    const newest = await getMessages(episodeId, 2);
    expect(newest.map(m => m.content)).toEqual(['msg-3', 'msg-4']);
    const older = await getMessages(episodeId, 2, {
      createdAt: newest[0].createdAt,
      id: newest[0].id,
    });
    expect(older.map(m => m.content)).toEqual(['msg-1', 'msg-2']);
  });
});
