import 'server-only';

// ============================================================================
// Create Runtime agent tools — propose_design + runtime_*.
// ============================================================================

import { access } from 'fs/promises';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { tool } from 'ai';
import { z } from 'zod';
import type { AgentTask } from '../task';
import { resolveScopedPath } from '../fs-helpers';
import { persistProjectDesign } from './design-gate';
import {
  DEFAULT_IFRAME_PORT,
  PROJECT_MANIFEST_FILENAME,
  parseProjectDesignJson,
  previewUrlForDesign,
  projectDesignSchema,
  serializeProjectDesign,
} from './project-manifest';
import {
  getRuntimeLogs,
  getRuntimeSnapshot,
  startRuntime,
  startRuntimeFromDesign,
  stopRuntime,
  type StartRuntimeResult,
} from './process-supervisor';
import {
  shouldFallbackToStaticServe,
  staticServeRoot,
  staticServeScript,
} from './script-normalize';
import { PREVIEW_TYPES, type ProjectDesign } from './types';
import { safeWriteFile } from '../fs-scope';
import { logger } from '@/lib/logger';

/** Accept weak-model tree entries: string path | {path,role} | {path,type}. */
const treeEntryInputSchema = z.preprocess((v) => {
  if (typeof v === 'string' && v.trim()) return { path: v.trim(), role: 'file' };
  if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
  const e = v as Record<string, unknown>;
  if (typeof e.role === 'string' && e.role.trim()) return e;
  if (typeof e.type === 'string' && e.type.trim()) return { ...e, role: e.type };
  if (typeof e.path === 'string') return { ...e, role: 'file' };
  return e;
}, z.object({
  path: z.string().min(1),
  role: z.string().min(1),
}));

export function makeProposeDesignTool(task: AgentTask) {
  return tool({
    description:
      'Зафиксировать дизайн артефакта (lia.project.json). '
      + 'Для игр/простых сайтов стек LOCKED: только index.html + style.css + script.js в корне, npx serve :5173. '
      + 'Не предлагай vite/express/src/. После этого — write_file по дереву манифеста → runtime_start.',
    inputSchema: z.object({
      name: z.string().min(1).max(80),
      kind: z.string().min(1).max(40).optional(),
      stack: z.array(z.string().min(1)).min(1).max(12).optional(),
      tree: z.array(treeEntryInputSchema).min(1).max(40).optional(),
      scripts: z
        .object({
          install: z.string().max(300).optional(),
          dev: z.string().max(300).optional(),
          build: z.string().max(300).optional(),
          start: z.string().max(300).optional(),
        })
        .optional(),
      preview: z
        .object({
          type: z.enum(PREVIEW_TYPES).optional(),
          port: z.number().int().min(1024).max(65535).optional(),
          url: z.string().max(300).optional(),
        })
        .optional(),
      entry: z.string().max(200).optional(),
      acceptance: z.string().max(500).optional(),
    }),
    execute: async (input) => {
      // Locked presets ignore kind/stack/tree/scripts from the model.
      const result = await persistProjectDesign(task, {
        name: input.name,
        kind: (input.kind as 'web') ?? 'web',
        stack: input.stack ?? ['html'],
        tree: input.tree ?? [{ path: 'index.html', role: 'file' }],
        scripts: input.scripts ?? {},
        preview: {
          type: input.preview?.type ?? 'iframe',
          port: input.preview?.port ?? DEFAULT_IFRAME_PORT,
          url: input.preview?.url,
        },
        acceptance: input.acceptance ?? 'Preview открывается, основной сценарий работает.',
        createdBy: 'lia',
      });
      if (!result.ok) {
        return {
          success: false,
          error: result.error,
        };
      }
      return {
        success: true,
        manifest: PROJECT_MANIFEST_FILENAME,
        preset: result.design.preset,
        locked: result.design.preset === 'static-game' || result.design.preset === 'static-web',
        design: result.design,
        previewUrl: previewUrlForDesign(result.design),
        next:
          'write_file index.html, style.css, script.js (корень) → runtime_start '
          + '(без script override)',
      };
    },
  });
}

async function loadDesignFromCwd(cwd: string) {
  try {
    const text = await readFile(join(cwd, PROJECT_MANIFEST_FILENAME), 'utf8');
    return parseProjectDesignJson(text);
  } catch {
    return { ok: false as const, error: `${PROJECT_MANIFEST_FILENAME} not found` };
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** Pick serve root from actual sandbox files (prefer src/ if index lives there). */
async function detectServeRoot(cwd: string, treePaths: string[]): Promise<string> {
  if (await pathExists(join(cwd, 'src', 'index.html'))) return 'src';
  if (await pathExists(join(cwd, 'index.html'))) return '.';
  return staticServeRoot(treePaths);
}

async function persistServeScripts(
  task: AgentTask,
  design: ProjectDesign,
  serveScript: string,
): Promise<void> {
  if (!task.fsScope) return;
  const next: ProjectDesign = {
    ...design,
    scripts: { ...design.scripts, dev: serveScript, start: serveScript },
    stack: design.stack.some((s) => /vite/i.test(s))
      ? ['html', 'css', 'javascript']
      : design.stack,
  };
  try {
    await safeWriteFile(PROJECT_MANIFEST_FILENAME, task.fsScope, serializeProjectDesign(next));
  } catch (e) {
    logger.warn('agent', 'failed to persist serve scripts after runtime heal', {}, e);
  }
}

function withHealHint(result: StartRuntimeResult, serveScript: string): StartRuntimeResult & {
  heal?: string;
} {
  if (result.success) return result;
  return {
    ...result,
    heal:
      `Статика без package.json: вызови runtime_start с script="${serveScript}" `
      + `(или поправь lia.project.json scripts.dev). Не передавай script:"vite".`,
  };
}

export function makeRuntimeStartTool(task: AgentTask) {
  return tool({
    description:
      'Запустить preview артефакта по lia.project.json. ОБЯЗАТЕЛЕН после write_file. '
      + 'Для html/css/js игр — не передавай script:"vite" (нет package.json). '
      + 'Если не уверен — вызови без script, система поднимет npx serve.',
    inputSchema: z.object({
      scriptKey: z.enum(['dev', 'start']).default('dev'),
      /** Override script (allowlisted). Prefer omitting — use lia.project.json. */
      script: z.string().max(300).optional(),
      cwd: z.string().default('.'),
      port: z.number().int().min(1024).max(65535).optional(),
    }),
    execute: async ({ scriptKey, script, cwd, port }) => {
      const scoped = await resolveScopedPath(task, cwd || '.', 'Нет рабочей директории для runtime');
      if (!scoped.ok) return { success: false, error: scoped.error };

      const loaded = await loadDesignFromCwd(scoped.fullPath);
      const designPort =
        port
        ?? (loaded.ok ? loaded.design.preview.port : undefined)
        ?? DEFAULT_IFRAME_PORT;
      const treePaths = loaded.ok ? loaded.design.tree.map((t) => t.path) : [];
      const lockedStatic =
        loaded.ok
        && (loaded.design.preset === 'static-game' || loaded.design.preset === 'static-web');
      const serveRoot = lockedStatic
        ? '.'
        : await detectServeRoot(scoped.fullPath, treePaths);
      const serveScript = staticServeScript(designPort, serveRoot);
      const previewUrl = loaded.ok
        ? (previewUrlForDesign({
            ...loaded.design,
            preview: {
              ...loaded.design.preview,
              port: designPort,
            },
          }) ?? `http://127.0.0.1:${designPort}/index.html`)
        : `http://127.0.0.1:${designPort}/index.html`;

      const hasPackageJson = await pathExists(join(scoped.fullPath, 'package.json'));
      const looksStatic = !hasPackageJson && (
        (await pathExists(join(scoped.fullPath, 'index.html')))
        || (await pathExists(join(scoped.fullPath, 'src', 'index.html')))
      );

      // Model override "vite" / broken toolchain → start with serve for static sandboxes.
      const override = script?.trim();
      const overrideLooksBroken =
        !!override
        && (/^vite\b/i.test(override) || (/vite/i.test(override) && !hasPackageJson));

      let result: StartRuntimeResult;

      if (looksStatic && (!override || overrideLooksBroken)) {
        result = await startRuntime({
          taskId: task.id,
          cwd: scoped.fullPath,
          script: serveScript,
          scriptKey,
          port: designPort,
          previewUrl,
        });
        if (result.success && loaded.ok) {
          await persistServeScripts(task, loaded.design, serveScript);
        }
        return result.success
          ? { ...result, healedToServe: true, script: serveScript }
          : withHealHint(result, serveScript);
      }

      if (override) {
        result = await startRuntime({
          taskId: task.id,
          cwd: scoped.fullPath,
          script: override,
          scriptKey,
          port: designPort,
          previewUrl,
        });
      } else if (loaded.ok) {
        result = await startRuntimeFromDesign(
          task.id,
          scoped.fullPath,
          loaded.design,
          scriptKey,
        );
      } else {
        return {
          success: false,
          error: loaded.error + ' — вызови propose_design или передай script явно',
          heal: `Для статики: runtime_start({ script: "${serveScript}" })`,
        };
      }

      // Auto-heal: vite/unhealthy → npx serve once.
      if (
        !result.success
        && looksStatic
        && shouldFallbackToStaticServe(result.error)
      ) {
        logger.info('agent', 'runtime heal → npx serve', {
          taskId: task.id.slice(0, 8),
          from: override ?? (loaded.ok ? loaded.design.scripts.dev : '?'),
          to: serveScript,
        });
        await stopRuntime(task.id);
        const healed = await startRuntime({
          taskId: task.id,
          cwd: scoped.fullPath,
          script: serveScript,
          scriptKey,
          port: designPort,
          previewUrl,
        });
        if (healed.success && loaded.ok) {
          await persistServeScripts(task, loaded.design, serveScript);
        }
        return {
          ...healed,
          healedToServe: true,
          script: serveScript,
          previousError: result.error,
        };
      }

      return withHealHint(result, serveScript);
    },
  });
}

export function makeRuntimeLogsTool(task: AgentTask) {
  return tool({
    description: 'Прочитать последние логи Process Supervisor (stdout/stderr) для диагностики.',
    inputSchema: z.object({
      limit: z.number().int().min(1).max(200).default(60),
    }),
    execute: async ({ limit }) => {
      const logs = getRuntimeLogs(task.id, limit);
      const snap = getRuntimeSnapshot(task.id);
      return {
        success: true,
        status: snap?.status ?? 'idle',
        port: snap?.port ?? null,
        previewUrl: snap?.previewUrl ?? null,
        lastError: snap?.lastError ?? null,
        logs,
      };
    },
  });
}

export function makeRuntimeStopTool(task: AgentTask) {
  return tool({
    description: 'Остановить процесс артефакта (dev-сервер / скрипт).',
    inputSchema: z.object({}),
    execute: async () => {
      const result = await stopRuntime(task.id);
      return { success: result.success, status: result.status };
    },
  });
}

/** Re-export schema fragment for tests. */
export { projectDesignSchema };
