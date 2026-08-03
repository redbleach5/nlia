/**
 * Shared workspace contract (client + server).
 *
 * Kind meanings:
 *   project — absolute directory on disk
 *   kb      — bound to KB Source(s); fsPath optional (document-only → null)
 *   sandbox — ephemeral write tree under agent-workspaces/
 *   none    — cleared / no binding
 *
 * Persistence: EpisodeFact key `lia.workspace` (JSON). Survives reload.
 * Max pinned sources: 5. Default pinKb=true when sourceIds non-empty.
 */

export const WORKSPACE_FACT_KEY = 'lia.workspace';
export const MAX_PINNED_SOURCES = 5;

export type WorkspaceKind = 'project' | 'kb' | 'sandbox' | 'none';

export type WorkspaceBinding = {
  kind: WorkspaceKind;
  /** Absolute FS root when available; null for document-only KB pins. */
  fsPath: string | null;
  /** Pinned KB Source.id list (hard filter when pinKb). */
  sourceIds: string[];
  /** Human-readable label for UI. */
  label: string;
  /** ISO timestamp. */
  updatedAt: string;
  /**
   * When true (default) and sourceIds non-empty, chat/agent KB search
   * is limited to these sources. Set false for «искать везде».
   */
  pinKb: boolean;
};

export type WorkspaceBindingInput = {
  kind: Exclude<WorkspaceKind, 'none'>;
  fsPath?: string | null;
  sourceIds?: string[];
  label?: string;
  pinKb?: boolean;
};

export function isWorkspaceKind(v: unknown): v is WorkspaceKind {
  return v === 'project' || v === 'kb' || v === 'sandbox' || v === 'none';
}

/** Parse stored JSON → binding or null. */
export function parseWorkspaceBinding(raw: string | null | undefined): WorkspaceBinding | null {
  if (!raw || !raw.trim()) return null;
  try {
    const data = JSON.parse(raw) as Partial<WorkspaceBinding>;
    if (!isWorkspaceKind(data.kind) || data.kind === 'none') return null;
    const sourceIds = Array.isArray(data.sourceIds)
      ? data.sourceIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
        .slice(0, MAX_PINNED_SOURCES)
      : [];
    const fsPath = typeof data.fsPath === 'string' && data.fsPath.trim()
      ? data.fsPath.trim()
      : null;
    const label = typeof data.label === 'string' && data.label.trim()
      ? data.label.trim().slice(0, 120)
      : defaultLabel(data.kind, fsPath, sourceIds.length);
    return {
      kind: data.kind,
      fsPath,
      sourceIds,
      label,
      updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : new Date().toISOString(),
      pinKb: data.pinKb !== false,
    };
  } catch {
    return null;
  }
}

export function serializeWorkspaceBinding(binding: WorkspaceBinding): string {
  return JSON.stringify({
    kind: binding.kind,
    fsPath: binding.fsPath,
    sourceIds: binding.sourceIds.slice(0, MAX_PINNED_SOURCES),
    label: binding.label.slice(0, 120),
    updatedAt: binding.updatedAt,
    pinKb: binding.pinKb !== false,
  });
}

export function normalizeWorkspaceInput(input: WorkspaceBindingInput): WorkspaceBinding {
  const sourceIds = (input.sourceIds ?? [])
    .filter((id) => typeof id === 'string' && id.length > 0)
    .slice(0, MAX_PINNED_SOURCES);
  const fsPath = typeof input.fsPath === 'string' && input.fsPath.trim()
    ? input.fsPath.trim()
    : null;
  const label = (input.label?.trim() || defaultLabel(input.kind, fsPath, sourceIds.length)).slice(0, 120);
  return {
    kind: input.kind,
    fsPath,
    sourceIds,
    label,
    updatedAt: new Date().toISOString(),
    pinKb: input.pinKb !== false,
  };
}

function defaultLabel(kind: WorkspaceKind, fsPath: string | null, sourceCount: number): string {
  if (kind === 'sandbox') return 'Sandbox (черновик)';
  if (kind === 'kb') {
    return sourceCount > 1 ? `KB · ${sourceCount} источника` : 'База знаний';
  }
  if (fsPath) {
    const base = fsPath.replace(/[/\\]+$/, '').split(/[/\\]/).pop();
    return base || 'Папка';
  }
  return 'Workspace';
}

/** One-line prompt context (escaped by caller if needed). */
export function formatWorkspaceForPrompt(binding: WorkspaceBinding | null | undefined): string {
  if (!binding || binding.kind === 'none') return '';
  const parts: string[] = [`kind=${binding.kind}`, `«${binding.label}»`];
  if (binding.fsPath) {
    const short = binding.fsPath.length > 60
      ? `…${binding.fsPath.slice(-57)}`
      : binding.fsPath;
    parts.push(`path=${short}`);
  }
  if (binding.sourceIds.length > 0) {
    parts.push(
      binding.pinKb
        ? `KB pin: ${binding.sourceIds.length} source(s)`
        : `KB pin off (${binding.sourceIds.length} listed)`,
    );
  }
  return `Активный workspace: ${parts.join(' · ')}`;
}

/** Effective sourceIds for hard KB filter (empty = no pin). */
export function pinnedSourceIds(binding: WorkspaceBinding | null | undefined): string[] {
  if (!binding || binding.pinKb === false) return [];
  return binding.sourceIds.slice(0, MAX_PINNED_SOURCES);
}
