import 'server-only';

// Server startup logging — запускается один раз при первом импорте.
//
// Логирует версию, окружение, ключевые пути — чтобы при отладке «зависшего» лога
// сразу было видно: какая версия, какие настройки, какие модели доступны.
//
// Защита от повторного вызова: globalThis flag переживает HMR в dev-режиме.
// Защита от клиентского вызова: проверка typeof window.

import { logger } from './logger';

// Глобальный flag — переживает HMR в dev-режиме.
const globalKey = '__lia_startup_logged__';
const g = globalThis as unknown as { [key: string]: unknown };

export async function logServerStartup(): Promise<void> {
  // На клиенте — ничего не делаем.
  if (typeof window !== 'undefined') return;
  if (g[globalKey]) return;
  g[globalKey] = true;

  // Динамический импорт серверных модулей — чтобы не тащить их в клиентский бандл.
  const [{ PROJECT_ROOT }, { checkOllamaHealth }] = await Promise.all([
    import('./paths'),
    import('./ollama'),
  ]);

  logger.info('system', '═══════════════════════════════════════════════════════════');
  logger.info('system', 'Лия v2 — server starting', {
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    pid: process.pid,
    env: process.env.NODE_ENV ?? 'development',
    projectRoot: PROJECT_ROOT,
    logLevel: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
    llmTimeoutMs: process.env.LIA_LLM_TIMEOUT_MS ?? '180000 (default)',
    synthesisTimeoutMs: process.env.LIA_LLM_SYNTHESIS_TIMEOUT_MS ?? '240000 (default)',
  });

  // Additive SQLite patches BEFORE any Prisma writes that need new columns
  // (e.g. Message.attachmentsJson after pull without db:force-push).
  try {
    const { applySchemaPatchesOnStartup } = await import('./infra/schema-patches');
    await applySchemaPatchesOnStartup();
  } catch (e) {
    logger.warn('system', 'Schema patches import/run failed on startup (non-fatal)', {}, e);
  }

  try {
    const { ensureOllamaEnvDbReconciled, getOllamaSettings } = await import('./ollama');
    await ensureOllamaEnvDbReconciled();
    const settings = await getOllamaSettings();
    logger.info('system', 'Ollama configuration', {
      baseUrl: settings.baseUrl,
      model: settings.model,
      embedModel: settings.embedModel || 'auto',
    });
  } catch (e) {
    logger.warn('system', 'Failed to read Ollama settings on startup', {}, e);
  }

  try {
    const health = await checkOllamaHealth();
    if (health.ok) {
      logger.info('system', `Ollama is UP`, { modelsCount: health.models.length, models: health.models.slice(0, 5) });
    } else {
      logger.warn('system', `Ollama is DOWN`, { error: health.error });
    }
  } catch (e) {
    logger.warn('system', 'Ollama health check failed on startup', {}, e);
  }

  // Sweep stale agent tasks на старте сервера (раньше был lazy в /api/agent GET,
  // что приводило к зависшим executing-задачам, если пользователь сразу шёл в чат).
  // sweepStaleTasks помечает resumable (executing+checkpoint) → pending, остальные
  // transient статусы → failed с понятным сообщением.
  try {
    const { sweepStaleTasks } = await import('./agent/runner');
    const swept = await sweepStaleTasks();
    if (swept > 0) {
      logger.info('system', `Swept ${swept} stale agent task(s) on startup`);
    }
  } catch (e) {
    logger.warn('system', 'sweepStaleTasks failed on startup (non-fatal)', {}, e);
  }

  try {
    const { sweepOrphanRuntimes } = await import('./agent/runtime/orphan-pids');
    const orphans = await sweepOrphanRuntimes();
    if (orphans > 0) {
      logger.info('system', `Swept ${orphans} orphan runtime pid file(s) on startup`);
    }
  } catch (e) {
    logger.warn('system', 'sweepOrphanRuntimes failed on startup (non-fatal)', {}, e);
  }

  try {
    const { sweepStaleKbSources } = await import('./kb/indexer');
    const kbSwept = await sweepStaleKbSources();
    if (kbSwept > 0) {
      logger.info('system', `Swept ${kbSwept} stale KB indexing source(s) on startup`);
    }
  } catch (e) {
    logger.warn('system', 'sweepStaleKbSources failed on startup (non-fatal)', {}, e);
  }

  try {
    const { runSetupWizard } = await import('./infra/setup-wizard');
    await runSetupWizard();
  } catch (e) {
    logger.warn('system', 'Setup wizard failed to run (non-fatal)', {}, e);
  }

  // Start KB file watcher — отложенно, чтобы первый запрос UI не ждал chokidar.
  try {
    const { startFileWatcher } = await import('./kb/file-watcher');
    setTimeout(() => {
      startFileWatcher().catch((e) => {
        logger.warn('system', 'KB file watcher failed to start (non-fatal)', {}, e);
      });
    }, 30_000);
  } catch (e) {
    logger.warn('system', 'KB file watcher failed to start (non-fatal)', {}, e);
  }

  // ── Auto-reindex KB sources при смене версии токенизатора ──
  // Если в коде изменился стеммер / stopword list / split regex — старые
  // postings в kb_inverted_index остаются с не-стеммированными токенами,
  // а новые запросы идут через стеммер → silent recall degradation.
  // Авто-reindex: очистить inverted index, переиндексировать все sources
  // с новым токенизатором, обновить stored version.
  try {
    const { isTokenizerVersionOutdated, clearInvertedIndex, setStoredTokenizerVersion, KB_TOKENIZER_VERSION } =
      await import('./kb/inverted-index');
    if (isTokenizerVersionOutdated()) {
      logger.info('system', 'KB tokenizer version changed — auto-reindexing all sources in background');
      // Очищаем inverted index (postings + cached stats)
      clearInvertedIndex();

      // Переиндексируем все sources в фоне. Не блокируем startup.
      setTimeout(async () => {
        try {
          const { db } = await import('./db');
          const sources = await db.source.findMany({
            where: { status: { in: ['ready', 'error', 'idle'] } },
            select: { id: true, type: true, name: true },
          });

          logger.info('system', `Auto-reindex: ${sources.length} source(s) to reindex`, {
            version: KB_TOKENIZER_VERSION,
          });

          let success = 0;
          let failed = 0;
          for (const source of sources) {
            try {
              if (source.type === 'document') {
                const { indexDocumentSource } = await import('./kb/indexer');
                await indexDocumentSource(source.id);
              } else if (source.type === 'folder') {
                const { indexFolderSource } = await import('./kb/folder-indexer');
                await indexFolderSource(source.id);
              } else if (source.type === 'codebase') {
                const { indexCodebaseSource } = await import('./kb/code-indexer');
                await indexCodebaseSource(source.id);
              } else if (source.type === 'url') {
                const { indexUrlSource } = await import('./kb/indexer');
                await indexUrlSource(source.id);
              }
              success++;
            } catch (e) {
              failed++;
              logger.warn('system', `Auto-reindex failed for source ${source.name}`, {
                sourceId: source.id.slice(0, 8),
                type: source.type,
              }, e);
            }
          }

          // P1-1 fix (C-KB-3): only bump stored tokenizer version if at least
          // one source was successfully re-indexed with the new tokenizer.
          // Previously this ran unconditionally — if Ollama was down during
          // startup, ALL sources failed but the version was still bumped,
          // so the old (pre-v3) postings remained forever with no retry,
          // causing silent recall degradation.
          if (success > 0) {
            setStoredTokenizerVersion(KB_TOKENIZER_VERSION);
            logger.info('system', 'Auto-reindex complete — tokenizer version bumped', { success, failed, total: sources.length });
          } else if (sources.length > 0) {
            // All sources failed — do NOT bump version, so next startup retries.
            logger.warn('system', 'Auto-reindex: all sources failed — keeping old tokenizer version for retry on next startup', { failed, total: sources.length });
          } else {
            // No sources to reindex — safe to bump (nothing to reindex anyway).
            setStoredTokenizerVersion(KB_TOKENIZER_VERSION);
          }
        } catch (e) {
          logger.error('system', 'Auto-reindex pipeline failed', {}, e);
        }
      }, 60_000);  // 60 sec delay — даём Ollama/file watcher подняться
    }
  } catch (e) {
    logger.warn('system', 'KB tokenizer version check failed (non-fatal)', {}, e);
  }

  // Start KB reconciliation — периодическая сверка консистентности между
  // Prisma Chunk и raw-SQL индексами (kb_vec_virtual, kb_inverted_index).
  // Удаляет ghost entries, репортит orphaned chunks. Safety net для
  // неатомарного dual-write между Prisma и better-sqlite3.
  try {
    const { startKbReconciliation } = await import('./kb/reconcile');
    startKbReconciliation();
  } catch (e) {
    logger.warn('system', 'KB reconciliation failed to start (non-fatal)', {}, e);
  }

  // Reflection Engine — opt-in LLM consolidation of emotional anchors.
  // Default OFF (set LIA_REFLECTION_ENGINE=true to enable). Anchors still
  // record/recall; without this, no periodic LLM burn.
  try {
    const { startReflectionEngine } = await import('./memory/reflection-engine');
    startReflectionEngine();
  } catch (e) {
    logger.warn('system', 'Reflection engine failed to start (non-fatal)', {}, e);
  }

  // Start Ollama warmup — preload + heartbeat каждые 4 минуты.
  // Предотвращает 5-15s cold start после OLLAMA_KEEP_ALIVE простоя.
  // Fire-and-forget: не блокирует startup, не падает при ошибке.
  // Controlled by LIA_WARMUP_ENABLED env var (default: true).
  try {
    const { startOllamaWarmup } = await import('./ollama-warmup');
    startOllamaWarmup();
  } catch (e) {
    logger.warn('system', 'Ollama warmup failed to start (non-fatal)', {}, e);
  }

  // Cleanup polling timer на process exit — иначе Node.js не завершится.
  // Используем globalThis флаг (через существующий `g` map) чтобы не
  // регистрировать handler повторно при HMR.
  const exitHandlerKey = '__lia_process_exit_handler__';
  if (!g[exitHandlerKey]) {
    g[exitHandlerKey] = true;
    process.on('beforeExit', async () => {
      try {
        const { stopFileWatcher } = await import('./kb/file-watcher');
        await stopFileWatcher();
      } catch { /* ignore — best effort cleanup */ }
      try {
        const { stopKbReconciliation } = await import('./kb/reconcile');
        stopKbReconciliation();
      } catch { /* ignore — best effort cleanup */ }
      try {
        const { stopReflectionEngine } = await import('./memory/reflection-engine');
        stopReflectionEngine();
      } catch { /* ignore — best effort cleanup */ }
      try {
        const { stopOllamaWarmup } = await import('./ollama-warmup');
        stopOllamaWarmup();
      } catch { /* ignore — best effort cleanup */ }
    });
  }

  logger.info('system', '═══════════════════════════════════════════════════════════');
}
