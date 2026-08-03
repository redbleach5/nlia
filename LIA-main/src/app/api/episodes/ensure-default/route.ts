// POST /api/episodes/ensure-default — атомарно создать первый эпизод если БД пуста
//
// Решает проблему гонки: при mount UI два параллельных fetch'а к GET /api/episodes
// оба видят 0 эпизодов, оба вызывают POST /api/episodes — получается 2 пустых чата.
//
// Этот endpoint в одной транзакции:
//   1. Считает эпизоды
//   2. Если 0 — создаёт один
//   3. Возвращает список (либо существующий, либо только что созданный)
//
// Идемпотентен: сколько раз ни вызови — если эпизоды уже есть, новые не создаются.

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { listEpisodes } from '@/lib/memory/episodes';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  try {
    // Транзакция — гарантирует атомарность даже при параллельных вызовах
    const result = await db.$transaction(async (tx) => {
      const count = await tx.episode.count();
      if (count === 0) {
        const created = await tx.episode.create({ data: {} });
        return { created: true, episodeId: created.id };
      }
      return { created: false, episodeId: null };
    });

    // Загружаем полный список (с messageCount и т.д.)
    const episodes = await listEpisodes(50);

    return NextResponse.json({
      episodes,
      created: result.created,
      episodeId: result.episodeId,
    });
  } catch (e) {
    logger.error('api', 'failed', {}, e);
    return NextResponse.json({ error: 'failed' }, { status: 500 });
  }
}
