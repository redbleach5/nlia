/**
 * File-change stack: propose (ask) → Apply/Reject/Undo, or auto-apply.
 *
 * Ask mode (default): disk unchanged until Apply; pending overlays read_file.
 * Auto mode: LIA_AUTO_APPLY_FILES=1 — write immediately.
 */

import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { existsSync } from "node:fs";
import { logger } from "../util/logger.js";

const MAX_PREV_CHARS = 200_000;
const MAX_PROPOSED_CHARS = 800_000;
const MAX_DIFF_CHARS = 8_000;
const MAX_PER_TASK = 120;

export type FileChangeTool = "write_file" | "apply_patch" | "write_files";
export type FileChangeStatus = "pending" | "applied" | "rejected" | "undone";

export interface FileChangeRecord {
  id: string;
  taskId: string;
  path: string;
  tool: FileChangeTool;
  status: FileChangeStatus;
  previousContent?: string;
  proposedContent?: string;
  created: boolean;
  canUndo: boolean;
  diff?: string;
  createdAt: number;
}

type Store = Map<string, FileChangeRecord[]>;

const storeKey = "__lia_file_changes_v3__";

function getStore(): Store {
  const g = globalThis as unknown as { [key: string]: Store | undefined };
  if (!g[storeKey]) g[storeKey] = new Map();
  return g[storeKey]!;
}

function makeId(): string {
  return `fc_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function isAutoApplyFiles(): boolean {
  return (
    process.env.LIA_AUTO_APPLY_FILES === "1" ||
    process.env.LIA_AUTO_APPLY_FILES === "true"
  );
}

function resolveScoped(fsScope: string, inputPath: string): { abs: string; rel: string } {
  const abs = isAbsolute(inputPath) ? resolve(inputPath) : resolve(fsScope, inputPath);
  const rel = relative(fsScope, abs);
  if (rel.startsWith("..") || rel === "") {
    throw new Error(`Path escapes fsScope: ${inputPath}`);
  }
  return { abs, rel };
}

function simpleDiff(before: string | null, after: string): string {
  if (before == null) {
    const lines = after.split("\n");
    const preview = lines.slice(0, 40).map((l) => `+${l}`).join("\n");
    const more = lines.length > 40 ? `\n…(+${lines.length - 40} lines)` : "";
    return `--- /dev/null\n+++ new file\n${preview}${more}`.slice(0, MAX_DIFF_CHARS);
  }
  const a = before.split("\n");
  const b = after.split("\n");
  const out: string[] = [];
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max && out.length < 80; i++) {
    if (a[i] === b[i]) continue;
    if (a[i] != null) out.push(`-${a[i]}`);
    if (b[i] != null) out.push(`+${b[i]}`);
  }
  if (out.length === 0) return "(no line-level diff)";
  return out.join("\n").slice(0, MAX_DIFF_CHARS);
}

export function getPendingFileOverlay(taskId: string, relativePath: string): string | undefined {
  const list = getStore().get(taskId) ?? [];
  const pending = [...list]
    .reverse()
    .find((c) => c.path === relativePath && c.status === "pending" && c.proposedContent != null);
  return pending?.proposedContent;
}

export function listPendingChanges(taskId: string): FileChangeRecord[] {
  return (getStore().get(taskId) ?? []).filter((c) => c.status === "pending");
}

export function listUndoableChanges(taskId: string): FileChangeRecord[] {
  return (getStore().get(taskId) ?? []).filter((c) => c.status === "applied" && c.canUndo);
}

export function listTaskFileChanges(taskId: string): FileChangeRecord[] {
  return [...(getStore().get(taskId) ?? [])];
}

export function getFileChange(taskId: string, changeId: string): FileChangeRecord | null {
  return (getStore().get(taskId) ?? []).find((c) => c.id === changeId) ?? null;
}

async function readExisting(abs: string): Promise<string | null> {
  try {
    return await readFile(abs, "utf-8");
  } catch {
    return null;
  }
}

async function writeScoped(fsScope: string, relPath: string, content: string): Promise<void> {
  const { abs } = resolveScoped(fsScope, relPath);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content, "utf-8");
}

function pushRecord(taskId: string, record: FileChangeRecord): void {
  const list = getStore().get(taskId) ?? [];
  while (list.length >= MAX_PER_TASK) list.shift();
  list.push(record);
  getStore().set(taskId, list);
}

function markApplied(record: FileChangeRecord): void {
  record.status = "applied";
  // New files can be undone by deleting; edits by restoring previousContent
  if (record.created) {
    record.canUndo = true;
  } else {
    record.canUndo =
      record.previousContent != null && record.previousContent.length <= MAX_PREV_CHARS;
  }
  // Keep proposedContent cleared but leave previousContent for undo
  record.proposedContent = undefined;
}

/**
 * Propose (ask) or apply (auto) a file edit.
 */
export async function proposeOrApplyFileChange(params: {
  taskId: string;
  fsScope: string;
  path: string;
  tool: FileChangeTool;
  proposedContent: string;
}): Promise<FileChangeRecord & { applied: boolean }> {
  if (params.proposedContent.length > MAX_PROPOSED_CHARS) {
    throw new Error(`proposed content too large (max ${MAX_PROPOSED_CHARS})`);
  }

  const { abs, rel } = resolveScoped(params.fsScope, params.path);
  const previousContent = await readExisting(abs);
  const created = previousContent == null;
  const diff = simpleDiff(previousContent, params.proposedContent);

  if (isAutoApplyFiles()) {
    await writeScoped(params.fsScope, rel, params.proposedContent);
    const record: FileChangeRecord = {
      id: makeId(),
      taskId: params.taskId,
      path: rel,
      tool: params.tool,
      status: "applied",
      previousContent:
        previousContent != null && previousContent.length <= MAX_PREV_CHARS
          ? previousContent
          : undefined,
      created,
      canUndo: created || (previousContent != null && previousContent.length <= MAX_PREV_CHARS),
      diff,
      createdAt: Date.now(),
    };
    pushRecord(params.taskId, record);
    logger.info({ taskId: params.taskId, path: rel, tool: params.tool }, "file change auto-applied");
    return { ...record, applied: true };
  }

  // Replace older pending for same path (latest proposal wins)
  const list = getStore().get(params.taskId) ?? [];
  for (const existing of list) {
    if (existing.path === rel && existing.status === "pending") {
      existing.status = "rejected";
      existing.proposedContent = undefined;
      existing.canUndo = false;
    }
  }
  getStore().set(params.taskId, list);

  const record: FileChangeRecord = {
    id: makeId(),
    taskId: params.taskId,
    path: rel,
    tool: params.tool,
    status: "pending",
    previousContent:
      previousContent != null && previousContent.length <= MAX_PREV_CHARS
        ? previousContent
        : undefined,
    proposedContent: params.proposedContent,
    created,
    canUndo: false,
    diff,
    createdAt: Date.now(),
  };
  pushRecord(params.taskId, record);
  logger.info({ taskId: params.taskId, path: rel, changeId: record.id }, "file change proposed");
  return { ...record, applied: false };
}

export async function applyFileChange(
  taskId: string,
  changeId: string,
  fsScope: string,
): Promise<{ ok: true; record: FileChangeRecord } | { ok: false; error: string }> {
  const record = getFileChange(taskId, changeId);
  if (!record) return { ok: false, error: "change_not_found" };
  if (record.status !== "pending") return { ok: false, error: `already_${record.status}` };
  if (record.proposedContent == null) return { ok: false, error: "no_proposed_content" };

  await writeScoped(fsScope, record.path, record.proposedContent);
  markApplied(record);

  logger.info({ taskId, changeId, path: record.path }, "file change applied");
  return { ok: true, record };
}

export async function rejectFileChange(
  taskId: string,
  changeId: string,
): Promise<{ ok: true; record: FileChangeRecord } | { ok: false; error: string }> {
  const record = getFileChange(taskId, changeId);
  if (!record) return { ok: false, error: "change_not_found" };
  if (record.status !== "pending") return { ok: false, error: `already_${record.status}` };

  record.status = "rejected";
  record.proposedContent = undefined;
  record.canUndo = false;

  logger.info({ taskId, changeId, path: record.path }, "file change rejected");
  return { ok: true, record };
}

export async function undoFileChange(
  taskId: string,
  changeId: string,
  fsScope: string,
): Promise<{ ok: true; record: FileChangeRecord } | { ok: false; error: string }> {
  const record = getFileChange(taskId, changeId);
  if (!record) return { ok: false, error: "change_not_found" };
  if (record.status !== "applied") return { ok: false, error: "not_applied" };
  if (!record.canUndo) return { ok: false, error: "undo_unavailable" };

  const { abs } = resolveScoped(fsScope, record.path);
  if (record.created) {
    if (existsSync(abs)) await unlink(abs);
  } else if (record.previousContent != null) {
    await writeScoped(fsScope, record.path, record.previousContent);
  } else {
    return { ok: false, error: "no_previous_content" };
  }

  record.status = "undone";
  record.canUndo = false;
  logger.info({ taskId, changeId, path: record.path }, "file change undone");
  return { ok: true, record };
}

export async function applyAllPending(
  taskId: string,
  fsScope: string,
): Promise<{ applied: FileChangeRecord[]; errors: Array<{ id: string; error: string }> }> {
  const pending = listPendingChanges(taskId);
  const applied: FileChangeRecord[] = [];
  const errors: Array<{ id: string; error: string }> = [];
  for (const p of pending) {
    const result = await applyFileChange(taskId, p.id, fsScope);
    if (result.ok) applied.push(result.record);
    else errors.push({ id: p.id, error: result.error });
  }
  return { applied, errors };
}

export async function rejectAllPending(
  taskId: string,
): Promise<{ rejected: FileChangeRecord[] }> {
  const pending = listPendingChanges(taskId);
  const rejected: FileChangeRecord[] = [];
  for (const p of pending) {
    const result = await rejectFileChange(taskId, p.id);
    if (result.ok) rejected.push(result.record);
  }
  return { rejected };
}

export async function undoAllApplied(
  taskId: string,
  fsScope: string,
): Promise<{ undone: FileChangeRecord[]; errors: Array<{ id: string; error: string }> }> {
  // Undo newest first so later overlays don't fight earlier restores
  const undoable = [...listUndoableChanges(taskId)].reverse();
  const undone: FileChangeRecord[] = [];
  const errors: Array<{ id: string; error: string }> = [];
  for (const u of undoable) {
    const result = await undoFileChange(taskId, u.id, fsScope);
    if (result.ok) undone.push(result.record);
    else errors.push({ id: u.id, error: result.error });
  }
  return { undone, errors };
}

/** Resolve relative path for overlay lookup (normalize to fsScope-relative). */
export function toRelativePath(fsScope: string, inputPath: string): string {
  return resolveScoped(fsScope, inputPath).rel;
}

/** Test helper — clear all in-memory changes. */
export function _clearFileChangesForTests(): void {
  getStore().clear();
}
