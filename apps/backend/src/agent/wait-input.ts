/**
 * ask_user wait bridge — in-memory promise that pauses the agent tool call
 * until POST /api/agent/:id/input resolves it (or cancel/timeout rejects).
 */

import { logger } from "../util/logger.js";

const ASK_USER_TIMEOUT_MS = 10 * 60 * 1000;

interface WaitingEntry {
  question: string;
  resolve: (answer: string) => void;
  reject: (err: Error) => void;
  setAt: number;
}

const globalKey = "__lia_waiting_input__";

function getMap(): Map<string, WaitingEntry> {
  const g = globalThis as unknown as { [key: string]: Map<string, WaitingEntry> | undefined };
  if (!g[globalKey]) g[globalKey] = new Map();
  return g[globalKey]!;
}

export function isWaiting(taskId: string): boolean {
  return getMap().has(taskId);
}

export function getPendingQuestion(taskId: string): string | null {
  return getMap().get(taskId)?.question ?? null;
}

export function resolveWaiting(taskId: string, answer: string): boolean {
  const entry = getMap().get(taskId);
  if (!entry) return false;
  getMap().delete(taskId);
  entry.resolve(answer);
  return true;
}

export function cancelWaiting(taskId: string, reason = "cancelled"): boolean {
  const entry = getMap().get(taskId);
  if (!entry) return false;
  getMap().delete(taskId);
  entry.reject(new Error(reason));
  return true;
}

/**
 * Block until the user answers (or timeout / cancel).
 * Caller is responsible for setting task status to waiting_input / executing.
 */
export function waitForUserAnswer(taskId: string, question: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    // Replace any stale waiter
    const prev = getMap().get(taskId);
    if (prev) {
      getMap().delete(taskId);
      prev.reject(new Error("superseded"));
    }

    const timeout = setTimeout(() => {
      const entry = getMap().get(taskId);
      if (!entry) return;
      getMap().delete(taskId);
      entry.reject(
        new Error(`timeout: user did not respond within ${ASK_USER_TIMEOUT_MS / 60_000} minutes`),
      );
    }, ASK_USER_TIMEOUT_MS);
    timeout.unref?.();

    getMap().set(taskId, {
      question,
      setAt: Date.now(),
      resolve: (answer) => {
        clearTimeout(timeout);
        resolve(answer);
      },
      reject: (err) => {
        clearTimeout(timeout);
        reject(err);
      },
    });

    logger.info(
      { taskId, questionPreview: question.slice(0, 100) },
      "agent waiting for user input",
    );
  });
}
