import 'server-only';

import { mkdir, access, stat } from 'fs/promises';
import { constants as fsConstants } from 'fs';
import { join, resolve, basename } from 'path';
import { PATHS } from '@/lib/paths';
import { logger } from '@/lib/logger';
import { getEpisodeFacts, upsertEpisodeFact } from '@/lib/memory/facts';
import { db } from '@/lib/db';
import {
  WORKSPACE_FACT_KEY,
  type WorkspaceBinding,
  type WorkspaceBindingInput,
  parseWorkspaceBinding,
  serializeWorkspaceBinding,
  normalizeWorkspaceInput,
  pinnedSourceIds,
} from './workspace-types';
import {
  resolveAgentFsScope,
  type ResolvedFsScope,
} from './workspace-scope';
import {
  modeAllowsWriteSandbox,
  type WorkspaceMode,
} from './workspace-modes';

export {
  WORKSPACE_FACT_KEY,
  MAX_PINNED_SOURCES,
  type WorkspaceKind,
  type WorkspaceBinding,
  type WorkspaceBindingInput,
  parseWorkspaceBinding,
  serializeWorkspaceBinding,
  normalizeWorkspaceInput,
  formatWorkspaceForPrompt,
  pinnedSourceIds,
} from './workspace-types';

export type ResolvedWorkspace = ResolvedFsScope & {
  binding: WorkspaceBinding | null;
  sourceIds: string[];
};

async function directoryExists(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** Load episode workspace binding (EpisodeFact `lia.workspace`). */
export async function getEpisodeWorkspace(episodeId: string): Promise<WorkspaceBinding | null> {
  if (!episodeId) return null;
  try {
    const facts = await getEpisodeFacts(episodeId);
    const row = facts.find((f) => f.key === WORKSPACE_FACT_KEY);
    return parseWorkspaceBinding(row?.value);
  } catch (e) {
    logger.warn('agent', 'getEpisodeWorkspace failed', { episodeId: episodeId.slice(0, 8) }, e);
    return null;
  }
}

/** Persist binding (or clear when null / kind none). */
export async function setEpisodeWorkspace(
  episodeId: string,
  input: WorkspaceBindingInput | null,
): Promise<WorkspaceBinding | null> {
  if (!episodeId) throw new Error('episodeId required');

  if (!input || input.kind === ('none' as WorkspaceBindingInput['kind'])) {
    await upsertEpisodeFact(episodeId, WORKSPACE_FACT_KEY, '');
    logger.info('agent', 'workspace cleared', { episodeId: episodeId.slice(0, 8) });
    return null;
  }

  let binding = normalizeWorkspaceInput(input);

  if (binding.kind === 'sandbox' && !binding.fsPath) {
    const dir = join(PATHS.artifacts, '..', 'agent-workspaces', `episode-${episodeId.slice(0, 12)}`);
    await mkdir(dir, { recursive: true });
    binding = { ...binding, fsPath: resolve(dir), label: binding.label || 'Sandbox (черновик)' };
  }

  if (binding.kind === 'project' && binding.fsPath) {
    const resolved = resolve(binding.fsPath);
    if (!(await directoryExists(resolved))) {
      throw new Error(`Папка не найдена: ${binding.fsPath}`);
    }
    binding = { ...binding, fsPath: resolved };
  }

  if (binding.kind === 'kb' && binding.sourceIds.length === 0) {
    throw new Error('Для workspace kind=kb нужен хотя бы один sourceId');
  }

  // Enrich fsPath from first KB source that has a disk path.
  if (binding.kind === 'kb' && !binding.fsPath && binding.sourceIds.length > 0) {
    const fromKb = await resolveFsPathFromSources(binding.sourceIds);
    if (fromKb) {
      binding = { ...binding, fsPath: fromKb };
    }
  }

  await upsertEpisodeFact(episodeId, WORKSPACE_FACT_KEY, serializeWorkspaceBinding(binding));
  logger.info('agent', 'workspace bound', {
    episodeId: episodeId.slice(0, 8),
    kind: binding.kind,
    label: binding.label,
    sourceIds: binding.sourceIds.length,
    hasPath: !!binding.fsPath,
  });

  // Phase 5: durable memory for this project/KB (cross-episode).
  void import('@/lib/agent/workspace-memory')
    .then(({ bootstrapWorkspaceMemory }) => bootstrapWorkspaceMemory(binding))
    .catch(() => null);

  return binding;
}

/** Resolve disk path from ready folder/codebase sources. */
export async function resolveFsPathFromSources(sourceIds: string[]): Promise<string | null> {
  if (sourceIds.length === 0) return null;
  try {
    const sources = await db.source.findMany({
      where: { id: { in: sourceIds }, status: 'ready', type: { in: ['folder', 'codebase'] } },
      select: { id: true, name: true, config: true },
    });
    for (const id of sourceIds) {
      const s = sources.find((x) => x.id === id);
      if (!s) continue;
      try {
        const cfg = JSON.parse(s.config || '{}') as { folderPath?: string; projectPath?: string };
        const p = (cfg.projectPath || cfg.folderPath || '').trim();
        if (!p) continue;
        if (await pathExists(p)) return resolve(p);
      } catch {
        /* skip */
      }
    }
  } catch (e) {
    logger.warn('agent', 'resolveFsPathFromSources failed', {}, e);
  }
  return null;
}

/**
 * Unified workspace resolve for chat + agent.
 *
 * Priority:
 *   1. Explicit fsScope from request
 *   2. Episode binding (fsPath / sandbox / kb path)
 *   3. Existing resolveAgentFsScope (env → KB name → Lia self → sandbox → none)
 *
 * Read/Explore: never create a write sandbox (allowSandbox=false).
 */
export async function resolveWorkspace(opts: {
  episodeId?: string | null;
  goal: string;
  explicitFsScope?: string | null;
  /** Resolved workspace mode — controls sandbox creation. */
  workspaceMode?: WorkspaceMode;
  /** Preflight: report sandbox without mkdir. */
  dryRun?: boolean;
}): Promise<ResolvedWorkspace> {
  const binding = opts.episodeId ? await getEpisodeWorkspace(opts.episodeId) : null;
  const sourceIds = pinnedSourceIds(binding);
  const allowSandbox = modeAllowsWriteSandbox(opts.workspaceMode ?? 'edit');
  const dryRun = opts.dryRun === true;

  const explicit = typeof opts.explicitFsScope === 'string' && opts.explicitFsScope.trim()
    ? opts.explicitFsScope.trim()
    : null;

  if (explicit) {
    const resolved = await resolveAgentFsScope({
      goal: opts.goal,
      explicitFsScope: explicit,
      allowSandbox,
      dryRun,
    });
    logger.debug('agent', 'resolveWorkspace via explicit', {
      kind: resolved.kind,
      sourceIds: sourceIds.length,
      workspaceMode: opts.workspaceMode ?? null,
    });
    return { ...resolved, binding, sourceIds };
  }

  if (binding?.fsPath) {
    const resolvedPath = resolve(binding.fsPath);
    if (await directoryExists(resolvedPath)) {
      const kind: ResolvedFsScope['kind'] =
        binding.kind === 'sandbox' ? 'sandbox'
          : binding.kind === 'kb' ? 'kb'
            : binding.kind === 'project' ? 'explicit'
              : 'explicit';
      // Binding to an existing sandbox still counts as sandbox for confirm UX
      // only when kind was sandbox — project/kb paths skip confirm.
      logger.info('agent', 'resolveWorkspace via episode binding', {
        kind: binding.kind,
        path: basename(resolvedPath),
        sourceIds: sourceIds.length,
        workspaceMode: opts.workspaceMode ?? null,
      });
      return { fsScope: resolvedPath, kind, binding, sourceIds };
    }
    logger.warn('agent', 'episode workspace path missing — falling through', {
      path: binding.fsPath.slice(0, 120),
      kind: binding.kind,
    });
  }

  // Document-only KB pin: no FS root, but keep sourceIds for search.
  if (binding && binding.kind === 'kb' && !binding.fsPath) {
    logger.info('agent', 'resolveWorkspace kb pin without fsPath', {
      sourceIds: sourceIds.length,
      label: binding.label,
    });
    return { fsScope: null, kind: 'none', binding, sourceIds };
  }

  const tryRecent = async (reason: string): Promise<ResolvedWorkspace | null> => {
    if (!opts.episodeId) return null;
    const {
      findRecentEpisodeFsScope,
      shouldReuseRecentEpisodeSandbox,
    } = await import('./artifact-followup');
    if (!shouldReuseRecentEpisodeSandbox(opts.goal)) return null;
    const recent = await findRecentEpisodeFsScope(opts.episodeId);
    if (!recent) return null;
    logger.info('agent', 'resolveWorkspace via recent episode artifact', {
      taskId: recent.taskId.slice(0, 8),
      files: recent.files.slice(0, 5),
      path: recent.fsScope.slice(-80),
      reason,
    });
    return {
      fsScope: recent.fsScope,
      kind: 'sandbox',
      binding,
      sourceIds,
    };
  };

  if (binding?.kind === 'sandbox' && allowSandbox) {
    // Prefer last artifact sandbox over recreating an empty episode tree.
    const fromRecent = await tryRecent('sandbox-binding-reuse');
    if (fromRecent) return fromRecent;
    if (dryRun) {
      return { fsScope: null, kind: 'sandbox', binding, sourceIds };
    }
    // Recreate stable sandbox if path was lost.
    const recreated = await setEpisodeWorkspace(opts.episodeId!, {
      kind: 'sandbox',
      label: binding.label || 'Sandbox (черновик)',
      sourceIds: binding.sourceIds,
      pinKb: binding.pinKb,
    });
    if (recreated?.fsPath) {
      return {
        fsScope: recreated.fsPath,
        kind: 'sandbox',
        binding: recreated,
        sourceIds: pinnedSourceIds(recreated),
      };
    }
  }

  // Fix / open / improve follow-ups: attach to files already on disk.
  {
    const fromRecent = await tryRecent('reuse');
    if (fromRecent) return fromRecent;
  }

  const resolved = await resolveAgentFsScope({
    goal: opts.goal,
    explicitFsScope: null,
    allowSandbox,
    dryRun,
  });

  // Don't strand on none, and don't mint a NEW empty sandbox when prior
  // artifacts exist for a reuse-eligible goal (edit «улучши» footgun).
  const wouldBlindSandbox =
    resolved.kind === 'sandbox'
    && (!resolved.fsScope || dryRun);
  if (
    opts.episodeId
    && ((!resolved.fsScope || resolved.kind === 'none') || wouldBlindSandbox)
  ) {
    const fromRecent = await tryRecent(
      resolved.kind === 'none' || !resolved.fsScope ? 'fallback-none' : 'fallback-empty-sandbox',
    );
    if (fromRecent) return fromRecent;
  }

  logger.debug('agent', 'resolveWorkspace fallback', {
    kind: resolved.kind,
    hasBinding: !!binding,
    sourceIds: sourceIds.length,
    workspaceMode: opts.workspaceMode ?? null,
    allowSandbox,
    dryRun,
  });
  return { ...resolved, binding, sourceIds };
}
