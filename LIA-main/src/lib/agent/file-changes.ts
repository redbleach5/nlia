import 'server-only';

// ============================================================================
// Agent file-change stack: propose (ask) → Apply/Reject, or auto-apply.
// ============================================================================
// Ask mode: disk unchanged until Apply; pending content overlays read_file.
// Auto mode: write immediately (legacy speed path). HMR-safe via globalThis.

import { unlink } from 'node:fs/promises';
import { safeWriteFile, safePathWithinScope } from './fs-scope';
import { emitAgentEvent } from './events';
import { logger } from '@/lib/logger';
import { verifyAppliedEdit } from './grounded-verify';
import {
  capturePreApplyGitSnapshot,
  optionalCommitAfterApply,
} from './git-history';

const MAX_PREV_CHARS = 200_000;
const MAX_DIFF_CHARS = 8_000;
const MAX_PER_TASK = 40;
const MAX_PROPOSED_CHARS = 500_000;

export type AgentApplyMode = 'ask' | 'auto';

export type FileChangeRecord = {
  id: string;
  taskId: string;
  path: string;
  tool: 'edit_file' | 'write_file';
  status: 'pending' | 'applied' | 'rejected';
  /** Present when undo can restore prior text (after apply). */
  previousContent?: string;
  /** Staged content waiting for Apply (ask mode). */
  proposedContent?: string;
  /** True when write_file would create a new file. */
  created: boolean;
  canUndo: boolean;
  diff?: string;
  createdAt: number;
};

type Store = Map<string, FileChangeRecord[]>;
type ModeStore = Map<string, AgentApplyMode>;
type GitCommitPref = Map<string, boolean>;

const globalKey = '__lia_file_changes__';
const modeKey = '__lia_apply_modes__';
const gitCommitKey = '__lia_git_commit_pref__';

function getStore(): Store {
  const g = globalThis as unknown as { [key: string]: Store | undefined };
  if (!g[globalKey]) g[globalKey] = new Map();
  return g[globalKey]!;
}

function getModeStore(): ModeStore {
  const g = globalThis as unknown as { [key: string]: ModeStore | undefined };
  if (!g[modeKey]) g[modeKey] = new Map();
  return g[modeKey]!;
}

function getGitCommitPref(): GitCommitPref {
  const g = globalThis as unknown as { [key: string]: GitCommitPref | undefined };
  if (!g[gitCommitKey]) g[gitCommitKey] = new Map();
  return g[gitCommitKey]!;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + '\n…[truncated]';
}

export function setTaskApplyMode(taskId: string, mode: AgentApplyMode): void {
  getModeStore().set(taskId, mode);
}

export function getTaskApplyMode(taskId: string): AgentApplyMode {
  return getModeStore().get(taskId) ?? 'ask';
}

export function setTaskGitAutoCommit(taskId: string, enabled: boolean): void {
  getGitCommitPref().set(taskId, enabled);
}

export function getTaskGitAutoCommit(taskId: string): boolean {
  return getGitCommitPref().get(taskId) ?? false;
}

/** Overlay: pending proposed content for read_file. */
export function getPendingFileOverlay(taskId: string, relativePath: string): string | undefined {
  const list = getStore().get(taskId) ?? [];
  const pending = [...list].reverse().find(
    (c) => c.path === relativePath && c.status === 'pending' && c.proposedContent != null,
  );
  return pending?.proposedContent;
}

export function listPendingChanges(taskId: string): FileChangeRecord[] {
  return (getStore().get(taskId) ?? []).filter((c) => c.status === 'pending');
}

/** All file-change records for a task (pending + applied + rejected). */
export function listTaskFileChanges(taskId: string): FileChangeRecord[] {
  return [...(getStore().get(taskId) ?? [])];
}

/**
 * Propose (ask) or apply (auto) a file edit.
 * Does NOT write in ask mode — stores proposedContent.
 */
export async function proposeOrApplyFileChange(params: {
  taskId: string;
  path: string;
  tool: 'edit_file' | 'write_file';
  previousContent: string | null;
  proposedContent: string;
  diff?: string;
  step?: number;
  fsScope: string | null;
}): Promise<FileChangeRecord & { applied: boolean }> {
  const mode = getTaskApplyMode(params.taskId);
  if (params.proposedContent.length > MAX_PROPOSED_CHARS) {
    throw new Error(`proposed content too large (max ${MAX_PROPOSED_CHARS})`);
  }

  if (mode === 'auto') {
    if (!params.fsScope) throw new Error('no fsScope');
    await safeWriteFile(params.path, params.fsScope, params.proposedContent);
    const record = await finalizeAppliedRecord({
      ...params,
      status: 'applied',
      writeDone: true,
    });
    return { ...record, applied: true };
  }

  // ask: stage only
  const record = await finalizeAppliedRecord({
    ...params,
    status: 'pending',
    writeDone: false,
  });
  return { ...record, applied: false };
}

async function finalizeAppliedRecord(params: {
  taskId: string;
  path: string;
  tool: 'edit_file' | 'write_file';
  previousContent: string | null;
  proposedContent: string;
  diff?: string;
  step?: number;
  status: 'pending' | 'applied';
  writeDone: boolean;
  fsScope: string | null;
}): Promise<FileChangeRecord> {
  const id = crypto.randomUUID();
  const created = params.previousContent === null;

  let canUndo = params.status === 'applied';
  let previousContent: string | undefined;
  if (created) {
    previousContent = undefined;
  } else if (params.previousContent!.length > MAX_PREV_CHARS) {
    canUndo = false;
    logger.debug('agent', 'file change previousContent too large — undo disabled', {
      path: params.path,
      taskId: params.taskId.slice(0, 8),
    });
  } else {
    previousContent = params.previousContent!;
  }

  const record: FileChangeRecord = {
    id,
    taskId: params.taskId,
    path: params.path,
    tool: params.tool,
    status: params.status,
    previousContent,
    proposedContent: params.status === 'pending' ? params.proposedContent : undefined,
    created,
    canUndo: params.status === 'applied' ? canUndo : false,
    diff: params.diff ? truncate(params.diff, MAX_DIFF_CHARS) : undefined,
    createdAt: Date.now(),
  };

  const store = getStore();
  const list = store.get(params.taskId) ?? [];
  list.push(record);
  while (list.length > MAX_PER_TASK) list.shift();
  store.set(params.taskId, list);

  const pending = params.status === 'pending';
  emitAgentEvent({
    type: 'file_changed',
    taskId: params.taskId,
    step: params.step ?? 0,
    changeId: id,
    path: params.path,
    tool: params.tool,
    diff: record.diff,
    canUndo: record.canUndo,
    pending,
    ts: record.createdAt,
  });

  if (params.writeDone && params.fsScope) {
    await afterSuccessfulWrite(params.taskId, params.path, params.fsScope, params.proposedContent);
  }

  return record;
}

async function afterSuccessfulWrite(
  taskId: string,
  relativePath: string,
  fsScope: string,
  expectedContent: string,
): Promise<void> {
  await capturePreApplyGitSnapshot(taskId, fsScope);
  const grounded = await verifyAppliedEdit({
    fsScope,
    relativePath,
    expectedContent,
  });
  if (!grounded.ok) {
    logger.warn('agent', 'grounded check failed after write', {
      path: relativePath,
      errors: grounded.errors,
    });
  }
  if (getTaskGitAutoCommit(taskId)) {
    await optionalCommitAfterApply({
      fsScope,
      message: `lia: apply ${relativePath}`,
      enabled: true,
    });
  }
}

/**
 * Apply a pending change to disk.
 */
export async function applyFileChange(
  taskId: string,
  changeId: string,
  fsScope: string | null,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const record = getFileChange(taskId, changeId);
  if (!record) return { ok: false, error: 'change not found' };
  if (record.status !== 'pending') return { ok: false, error: 'change is not pending' };
  if (record.proposedContent == null) return { ok: false, error: 'no proposed content' };
  if (!fsScope) return { ok: false, error: 'no fsScope on task' };

  try {
    await safeWriteFile(record.path, fsScope, record.proposedContent);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  record.status = 'applied';
  record.canUndo = record.previousContent !== undefined || record.created;
  const content = record.proposedContent;
  record.proposedContent = undefined;

  emitAgentEvent({
    type: 'edit_applied',
    taskId,
    changeId,
    path: record.path,
    tool: record.tool,
    diff: record.diff,
    canUndo: record.canUndo,
    ts: Date.now(),
  });

  await afterSuccessfulWrite(taskId, record.path, fsScope, content);
  return { ok: true, path: record.path };
}

export async function rejectFileChange(
  taskId: string,
  changeId: string,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const record = getFileChange(taskId, changeId);
  if (!record) return { ok: false, error: 'change not found' };
  if (record.status !== 'pending') return { ok: false, error: 'change is not pending' };

  record.status = 'rejected';
  record.proposedContent = undefined;
  record.canUndo = false;

  emitAgentEvent({
    type: 'edit_rejected',
    taskId,
    changeId,
    path: record.path,
    ts: Date.now(),
  });

  return { ok: true, path: record.path };
}

export async function applyAllPendingChanges(
  taskId: string,
  fsScope: string | null,
): Promise<{ ok: true; applied: string[]; failed: Array<{ path: string; error: string }> }> {
  const pending = listPendingChanges(taskId);
  const applied: string[] = [];
  const failed: Array<{ path: string; error: string }> = [];
  for (const p of pending) {
    const r = await applyFileChange(taskId, p.id, fsScope);
    if (r.ok) applied.push(r.path);
    else failed.push({ path: p.path, error: r.error });
  }
  return { ok: true, applied, failed };
}

/** @deprecated Prefer proposeOrApplyFileChange — kept for callers that already wrote. */
export function recordFileChange(params: {
  taskId: string;
  path: string;
  tool: 'edit_file' | 'write_file';
  previousContent: string | null;
  diff?: string;
  step?: number;
}): FileChangeRecord {
  const id = crypto.randomUUID();
  const created = params.previousContent === null;
  let canUndo = true;
  let previousContent: string | undefined;
  if (created) {
    previousContent = undefined;
  } else if (params.previousContent!.length > MAX_PREV_CHARS) {
    canUndo = false;
  } else {
    previousContent = params.previousContent!;
  }

  const record: FileChangeRecord = {
    id,
    taskId: params.taskId,
    path: params.path,
    tool: params.tool,
    status: 'applied',
    previousContent,
    created,
    canUndo,
    diff: params.diff ? truncate(params.diff, MAX_DIFF_CHARS) : undefined,
    createdAt: Date.now(),
  };

  const store = getStore();
  const list = store.get(params.taskId) ?? [];
  list.push(record);
  while (list.length > MAX_PER_TASK) list.shift();
  store.set(params.taskId, list);

  emitAgentEvent({
    type: 'file_changed',
    taskId: params.taskId,
    step: params.step ?? 0,
    changeId: id,
    path: params.path,
    tool: params.tool,
    diff: record.diff,
    canUndo,
    pending: false,
    ts: record.createdAt,
  });

  return record;
}

export function getFileChange(taskId: string, changeId: string): FileChangeRecord | null {
  const list = getStore().get(taskId) ?? [];
  return list.find((c) => c.id === changeId) ?? null;
}

export function removeFileChange(taskId: string, changeId: string): void {
  const store = getStore();
  const list = store.get(taskId);
  if (!list) return;
  const next = list.filter((c) => c.id !== changeId);
  if (next.length === 0) store.delete(taskId);
  else store.set(taskId, next);
}

export function clearFileChanges(taskId: string): void {
  getStore().delete(taskId);
  getModeStore().delete(taskId);
  getGitCommitPref().delete(taskId);
}

/** Restore previous content or delete if the file was created. */
export async function undoFileChange(
  taskId: string,
  changeId: string,
  fsScope: string | null,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const record = getFileChange(taskId, changeId);
  if (!record) return { ok: false, error: 'change not found (expired or already undone)' };
  if (record.status === 'pending') {
    return rejectFileChange(taskId, changeId);
  }
  if (!record.canUndo) return { ok: false, error: 'undo not available for this change' };
  if (!fsScope) return { ok: false, error: 'no fsScope on task' };

  const fullPath = await safePathWithinScope(record.path, fsScope);
  if (!fullPath) return { ok: false, error: 'path outside fsScope' };

  try {
    if (record.created) {
      await unlink(fullPath);
    } else if (record.previousContent !== undefined) {
      await safeWriteFile(record.path, fsScope, record.previousContent);
    } else {
      return { ok: false, error: 'undo not available for this change' };
    }
    removeFileChange(taskId, changeId);
    logger.info('agent', 'file change undone', {
      taskId: taskId.slice(0, 8),
      path: record.path,
      changeId: changeId.slice(0, 8),
    });
    return { ok: true, path: record.path };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function undoAllFileChanges(
  taskId: string,
  fsScope: string | null,
): Promise<{ ok: true; undone: string[]; skipped: Array<{ path: string; error: string }> }> {
  const list = [...(getStore().get(taskId) ?? [])];
  const undone: string[] = [];
  const skipped: Array<{ path: string; error: string }> = [];

  for (let i = list.length - 1; i >= 0; i--) {
    const rec = list[i];
    if (rec.status === 'pending') {
      await rejectFileChange(taskId, rec.id);
      undone.push(rec.path);
      continue;
    }
    if (!rec.canUndo) {
      skipped.push({ path: rec.path, error: 'undo not available' });
      continue;
    }
    if (!getFileChange(taskId, rec.id)) continue;
    const result = await undoFileChange(taskId, rec.id, fsScope);
    if (result.ok) undone.push(result.path);
    else skipped.push({ path: rec.path, error: result.error });
  }

  return { ok: true, undone, skipped };
}
