/**
 * UI confirmation bridge — pauses agent tools until user confirms/rejects.
 * Used by git commit/push, deploy presets, and ssh_run.
 */

import { logger } from "../util/logger.js";

const TIMEOUT_MS = 10 * 60 * 1000;

export type UiActionKind = "commit" | "push" | "deploy" | "ssh";

export interface PendingUiAction {
  id: string;
  taskId: string;
  kind: UiActionKind;
  /** Human-readable summary for the confirm card */
  summary: string;
  /** git commit */
  message?: string;
  files?: string[];
  branch?: string;
  remote?: string;
  /** deploy */
  preset?: string;
  command?: string;
  /** ssh */
  host?: string;
  sshCommand?: string;
  createdAt: number;
}

export type UiConfirmDecision =
  | { decision: "confirm"; message?: string }
  | { decision: "reject" };

interface WaitingEntry {
  action: PendingUiAction;
  resolve: (d: UiConfirmDecision) => void;
  reject: (err: Error) => void;
}

const globalKey = "__lia_ui_confirm__";

function getMap(): Map<string, WaitingEntry> {
  const g = globalThis as unknown as { [key: string]: Map<string, WaitingEntry> | undefined };
  if (!g[globalKey]) g[globalKey] = new Map();
  return g[globalKey]!;
}

function makeId(): string {
  return `act_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function getPendingUiAction(taskId: string): PendingUiAction | null {
  return getMap().get(taskId)?.action ?? null;
}

export function isUiWaiting(taskId: string): boolean {
  return getMap().has(taskId);
}

export function resolveUiConfirm(taskId: string, decision: UiConfirmDecision): boolean {
  const entry = getMap().get(taskId);
  if (!entry) return false;
  getMap().delete(taskId);
  entry.resolve(decision);
  return true;
}

export function cancelUiConfirm(taskId: string, reason = "cancelled"): boolean {
  const entry = getMap().get(taskId);
  if (!entry) return false;
  getMap().delete(taskId);
  entry.reject(new Error(reason));
  return true;
}

/** @deprecated alias */
export const getPendingGitAction = getPendingUiAction;
/** @deprecated alias */
export const isGitWaiting = isUiWaiting;
/** @deprecated alias */
export const resolveGitConfirm = resolveUiConfirm;
/** @deprecated alias */
export const cancelGitConfirm = cancelUiConfirm;

export function beginUiConfirm(
  taskId: string,
  partial: Omit<PendingUiAction, "id" | "taskId" | "createdAt">,
): { action: PendingUiAction; done: Promise<UiConfirmDecision> } {
  const prev = getMap().get(taskId);
  if (prev) {
    getMap().delete(taskId);
    prev.reject(new Error("superseded"));
  }

  const action: PendingUiAction = {
    ...partial,
    id: makeId(),
    taskId,
    createdAt: Date.now(),
  };

  let resolveFn: (d: UiConfirmDecision) => void;
  let rejectFn: (err: Error) => void;

  const done = new Promise<UiConfirmDecision>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });

  const timeout = setTimeout(() => {
    const entry = getMap().get(taskId);
    if (!entry) return;
    getMap().delete(taskId);
    entry.reject(new Error("timeout: confirmation not received"));
  }, TIMEOUT_MS);
  timeout.unref?.();

  getMap().set(taskId, {
    action,
    resolve: (decision) => {
      clearTimeout(timeout);
      resolveFn!(decision);
    },
    reject: (err) => {
      clearTimeout(timeout);
      rejectFn!(err);
    },
  });

  logger.info(
    { taskId, kind: action.kind, actionId: action.id },
    "agent waiting for UI confirmation",
  );

  return { action, done };
}

/** @deprecated alias */
export const beginGitConfirm = beginUiConfirm;
