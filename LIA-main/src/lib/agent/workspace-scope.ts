import 'server-only';

import { mkdir, access, stat } from 'fs/promises';
import { constants as fsConstants } from 'fs';
import { join, resolve, basename, isAbsolute } from 'path';
import { randomUUID } from 'crypto';
import { PATHS } from '@/lib/paths';
import { logger } from '@/lib/logger';
import { isCodeExplorationGoal } from './kb-step-utils';

/**
 * Goals that need a real filesystem tree (read/edit).
 * Does NOT imply mounting Lia itself — only that some workspace is useful.
 */
export function wantsProjectWorkspace(goal: string): boolean {
  if (isCodeExplorationGoal(goal)) return true;
  const g = goal.toLowerCase();
  return (
    /исправ|реализу|напиш|почин|добав|отредактир|refactor|implement|fix\b|edit\b/.test(g)
    || /не\s+работает|не\s+запуска|сломал|разберись|почему\s+не/.test(g)
    || /создай\s+(файл|модул|функц|класс|компонент)/.test(g)
    || /write_file|edit_file|code_run/.test(g)
  );
}

/**
 * Goal clearly about Lia’s own repo — only then auto-mount PATHS.root.
 * Do NOT match «этот/свой проект» — that is how users refer to external
 * KB workspaces (AgentsRise etc.) and would falsely mount Lia itself.
 * KB workspaces (AgentsRise etc.) and would falsely mount Lia itself.
 */
export function goalMentionsLiaSelf(goal: string): boolean {
  const g = goal.toLowerCase();
  return (
    /lia-v2-public|lia-v2\b|lia\s*v2/i.test(g)
    || /(?:код|проект[аеу]?|репозитор(?:ий|ия)?)\s+лии/.test(g)
    || /в\s+лие\b/.test(g)
  );
}

export function isProjectRootFsScope(fsScope: string | null | undefined): boolean {
  if (!fsScope) return false;
  try {
    return resolve(fsScope).toLowerCase() === resolve(PATHS.root).toLowerCase();
  } catch {
    return false;
  }
}

export type ResolvedFsScope = {
  fsScope: string | null;
  kind: 'explicit' | 'env_default' | 'kb' | 'project' | 'sandbox' | 'none';
};

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** True only if path exists and is a directory (fsScope must be a workspace root). */
async function directoryExists(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}

/**
 * If the goal names a ready KB folder/codebase source, use its disk path.
 * Example: goal mentions "AgentsRise" + KB source name "AgentsRise" → Downloads/AgentsRise.
 */
export async function matchKbWorkspaceFromGoal(goal: string): Promise<string | null> {
  try {
    const { db } = await import('@/lib/db');
    const sources = await db.source.findMany({
      where: { status: 'ready', type: { in: ['folder', 'codebase'] } },
      select: { name: true, type: true, config: true },
      take: 50,
    });
    const g = goal.toLowerCase();
    const ranked = sources
      .map((s) => ({ s, name: (s.name || '').trim() }))
      .filter((x) => x.name.length >= 3 && g.includes(x.name.toLowerCase()))
      .sort((a, b) => b.name.length - a.name.length);

    for (const { s } of ranked) {
      try {
        const cfg = JSON.parse(s.config || '{}') as {
          folderPath?: string;
          projectPath?: string;
        };
        const p = (cfg.projectPath || cfg.folderPath || '').trim();
        if (!p) continue;
        if (await pathExists(p)) return resolve(p);
        logger.warn('agent', 'KB workspace path missing on disk', {
          source: s.name,
          path: p.slice(0, 120),
        });
      } catch {
        /* skip bad config */
      }
    }
  } catch (e) {
    logger.warn('agent', 'KB workspace match skipped', {}, e);
  }
  return null;
}

async function createWriteSandbox(): Promise<ResolvedFsScope> {
  try {
    const workspaceDir = join(PATHS.artifacts, '..', 'agent-workspaces');
    const taskWorkspace = join(workspaceDir, `task-${Date.now()}-${randomUUID().slice(0, 8)}`);
    await mkdir(taskWorkspace, { recursive: true });
    return { fsScope: taskWorkspace, kind: 'sandbox' };
  } catch (e) {
    logger.warn('agent', 'failed to create write sandbox', {}, e);
    return { fsScope: null, kind: 'none' };
  }
}

/**
 * Resolve agent filesystem scope.
 *
 * Priority:
 *   1. Explicit fsScope from client
 *   2. LIA_AGENT_DEFAULT_WORKSPACE env (absolute path)
 *   3. Ready KB folder/codebase whose name appears in the goal
 *   4. Lia PATHS.root — ONLY if goal mentions Lia, or LIA_AGENT_MOUNT_SELF=true
 *   5. Write sandbox for coding goals (safe empty tree) — skipped if allowSandbox=false
 *   6. none
 *
 * Never silently mount Lia’s own repo for goals about other projects.
 */
export async function resolveAgentFsScope(opts: {
  goal: string;
  explicitFsScope?: string | null;
  /** When false (Read/Explore), never create a write sandbox. Default true. */
  allowSandbox?: boolean;
  /**
   * When true, report kind='sandbox' without mkdir (for confirm preflight).
   * fsScope stays null until a non-dry resolve.
   */
  dryRun?: boolean;
}): Promise<ResolvedFsScope> {
  const allowSandbox = opts.allowSandbox !== false;
  const dryRun = opts.dryRun === true;
  const explicit = typeof opts.explicitFsScope === 'string' && opts.explicitFsScope.trim()
    ? opts.explicitFsScope.trim()
    : null;
  if (explicit) {
    // Same bar as env_default / KB match: absolute resolved path that exists
    // as a directory. Relative paths resolve against process.cwd().
    const resolvedExplicit = resolve(explicit);
    if (await directoryExists(resolvedExplicit)) {
      return { fsScope: resolvedExplicit, kind: 'explicit' };
    }
    logger.warn('agent', 'explicit fsScope missing or not a directory — ignoring', {
      path: explicit.slice(0, 120),
      resolved: resolvedExplicit.slice(0, 120),
      wasAbsolute: isAbsolute(explicit),
    });
    // Fall through to env / KB / self / sandbox — do not store a broken scope.
  }

  const envDefault = (process.env.LIA_AGENT_DEFAULT_WORKSPACE || '').trim();
  if (envDefault) {
    if (await pathExists(envDefault)) {
      return { fsScope: resolve(envDefault), kind: 'env_default' };
    }
    logger.warn('agent', 'LIA_AGENT_DEFAULT_WORKSPACE missing on disk', {
      path: envDefault.slice(0, 120),
    });
  }

  const fromKb = await matchKbWorkspaceFromGoal(opts.goal);
  if (fromKb) {
    logger.info('agent', 'fsScope from KB source match', {
      path: fromKb.slice(-80),
      base: basename(fromKb),
    });
    return { fsScope: fromKb, kind: 'kb' };
  }

  const mountSelf =
    process.env.LIA_AGENT_MOUNT_SELF === 'true'
    || process.env.LIA_AGENT_MOUNT_SELF === '1'
    || goalMentionsLiaSelf(opts.goal);

  if (mountSelf) {
    return { fsScope: PATHS.root, kind: 'project' };
  }

  // Coding / exploration without a named external project → empty sandbox,
  // not Lia’s tree (avoids accidental self-edits). Skip for Read/Explore.
  if (allowSandbox && wantsProjectWorkspace(opts.goal)) {
    if (dryRun) return { fsScope: null, kind: 'sandbox' };
    return createWriteSandbox();
  }

  const sandboxOnly =
    process.env.LIA_AGENT_SANDBOX_ONLY === 'true'
    || process.env.LIA_AGENT_SANDBOX_ONLY === '1';
  if (allowSandbox && sandboxOnly) {
    if (dryRun) return { fsScope: null, kind: 'sandbox' };
    return createWriteSandbox();
  }

  return { fsScope: null, kind: 'none' };
}
