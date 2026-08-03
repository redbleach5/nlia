// ============================================================================
// GET /api/kb/health — health & stats для KB subsystem.
// ============================================================================
//
// Возвращает:
//   - Количество sources по типам и статусам
//   - Количество chunks (Prisma) vs векторов (kb_vec_virtual) — расхождение
//     сигнализирует о ghost entries или orphaned chunks
//   - Счётчики ghost entries из последнего reconciliation
//   - Старейший indexing source (если есть зависшие)
//   - Версии schema (kb_vec_virtual, kb_inverted_index tokenizer)
//   - Encryption status (доступен ли LIA_ENCRYPTION_KEY, сколько tokens
//     зашифровано / plaintext)
//
// Используется в UI (badge "KB health") и в diagnostics.

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { countKbVectors } from '@/lib/kb/db-vec-kb';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const [
      sourcesByType,
      sourcesByStatus,
      chunkCount,
      vectorCount,
    ] = await Promise.all([
      db.source.groupBy({ by: ['type'], _count: true }),
      db.source.groupBy({ by: ['status'], _count: true }),
      db.chunk.count(),
      Promise.resolve(countKbVectors()),
    ]);

    // Index version checks
    let tokenizerVersion: { stored: number; current: number; outdated: boolean } | null = null;
    let vecSchemaVersion: { stored: number; current: number } | null = null;
    try {
      const {
        getStoredTokenizerVersion,
        KB_TOKENIZER_VERSION,
        isTokenizerVersionOutdated,
      } = await import('@/lib/kb/inverted-index');
      tokenizerVersion = {
        stored: getStoredTokenizerVersion(),
        current: KB_TOKENIZER_VERSION,
        outdated: isTokenizerVersionOutdated(),
      };
    } catch { /* fresh install — tables not yet created */ }

    try {
      const { KB_VEC_SCHEMA_VERSION } = await import('@/lib/kb/db-vec-kb');
      const { getDb } = await import('@/lib/db-vec');
      const sqliteDb = getDb();
      const row = sqliteDb.prepare(
        `SELECT version FROM kb_schema_version WHERE name = 'kb_vec_virtual'`,
      ).get() as { version: number } | undefined;
      vecSchemaVersion = {
        stored: row?.version ?? 0,
        current: KB_VEC_SCHEMA_VERSION,
      };
    } catch { /* fresh install */ }

    // Encryption (field crypto available for future secrets)
    let encryption: { available: boolean } | null = null;
    try {
      const { isEncryptionAvailable } = await import('@/lib/infra/crypto');
      encryption = { available: isEncryptionAvailable() };
    } catch { /* crypto module not loaded */ }

    // Oldest unfinished indexing
    const staleIndexing = await db.source.findFirst({
      where: { status: 'indexing' },
      orderBy: { updatedAt: 'asc' },
      select: { id: true, name: true, type: true, updatedAt: true },
    });

    // Stats summary
    const chunkVectorDrift = Math.abs(chunkCount - vectorCount);
    const health: 'ok' | 'warning' | 'error' = (() => {
      if (tokenizerVersion?.outdated) return 'warning';
      if (chunkVectorDrift > 10) return 'warning';
      if (staleIndexing) return 'warning';
      return 'ok';
    })();

    return NextResponse.json({
      health,
      sources: {
        byType: Object.fromEntries(sourcesByType.map(s => [s.type, s._count])),
        byStatus: Object.fromEntries(sourcesByStatus.map(s => [s.status, s._count])),
        total: sourcesByType.reduce((sum, s) => sum + s._count, 0),
      },
      chunks: chunkCount,
      vectors: vectorCount,
      chunkVectorDrift,
      staleIndexing,
      tokenizerVersion,
      vecSchemaVersion,
      encryption,
    });
  } catch (e) {
    logger.error('kb', 'GET /api/kb/health failed', {}, e);
    return NextResponse.json({ error: 'failed', health: 'error' }, { status: 500 });
  }
}
