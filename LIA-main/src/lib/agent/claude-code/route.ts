/**
 * Routing: when Claude Code owns project coding (one goal → one executor).
 * Pure heuristics — safe for unit tests (no I/O / no server-only).
 */

import { isCodeCreationGoal, isCodeExplorationGoal, isKbLookupGoal } from '../kb-step-utils';
import { hasAgentWorkIntent } from '../route-intent';

/** Mirror of runner-helpers.isSandboxFsScope — kept local to avoid server-only import. */
function isSandboxFsScope(fsScope: string | null | undefined): boolean {
  if (!fsScope) return false;
  return /agent-workspaces[/\\]/i.test(fsScope);
}

export type ClaudeCodeRouteDecision =
  | { use: true; reason: string }
  | { use: false; reason: string };

/** Current-events / news — never Claude Code. */
function isNewsOrWebGoal(goal: string): boolean {
  const g = goal.toLowerCase();
  return (
    /новост|сегодня|свеж(ие|ая|ий)|лента\b|заголовк/.test(g)
    || /\bсво\b|спецоперац|что\s+(сейчас\s+)?с\s+/.test(g)
    || /ria\.ru|bbc|reuters|коммерсант/.test(g)
  );
}

/** Edit / fix / implement in existing project (not sandbox create-from-scratch). */
function isProjectCodingGoal(goal: string): boolean {
  if (isKbLookupGoal(goal)) return false;
  if (isNewsOrWebGoal(goal)) return false;
  if (isCodeExplorationGoal(goal)) return true;
  if (hasAgentWorkIntent(goal)) return true;
  const g = goal.toLowerCase();
  if (/исправ|почин|замен|отредактир|внедр|рефактор|refactor|fix\b|patch\b|implement/.test(g)) {
    return true;
  }
  if (/\.(ts|tsx|js|jsx|py|rs|go|vue|svelte|css|html?)\b/.test(g) || /src\/|lib\/|@file:/.test(g)) {
    return /исправ|почин|замен|добав|измен|edit|fix|write|нуж(ен|на|но)/.test(g);
  }
  // Create-from-scratch in a real project repo (not sandbox) still coding.
  if (isCodeCreationGoal(goal)) return true;
  return false;
}

/**
 * Whether this task should run via Claude Code (not ReAct).
 * Caller must also verify toggle + binary + Ollama preflight.
 */
export function shouldUseClaudeCodeExecutor(opts: {
  goal: string;
  fsScope: string | null | undefined;
  claudeCodeEnabled: boolean;
}): ClaudeCodeRouteDecision {
  if (!opts.claudeCodeEnabled) {
    return { use: false, reason: 'claude_code_disabled' };
  }
  if (!opts.fsScope) {
    return { use: false, reason: 'no_fs_scope' };
  }
  if (isSandboxFsScope(opts.fsScope)) {
    return { use: false, reason: 'sandbox_create_runtime' };
  }
  if (!isProjectCodingGoal(opts.goal)) {
    return { use: false, reason: 'not_project_coding' };
  }
  return { use: true, reason: 'project_coding' };
}
