/**
 * Narrow user prompt for Claude Code — never Lia companion / ReAct system.
 */

import { displayAgentGoal } from '../goal-display';
import { promptLooksLikeCompanionSystem } from '../phase-prompts';

export type ClaudeCodePromptInput = {
  goal: string;
  /** Repo rules + @mentions block (already formatted), or empty. */
  workspaceContext?: string;
  fsScope: string;
  /** Prior coding brief (operational). */
  brief?: string;
  /** Planned steps / target files from Lia pre-plan. */
  planHint?: string;
};

/**
 * Build the single user prompt passed to `claude -p`.
 * Must not include companion identity or ReAct agent system text.
 */
export function buildClaudeCodeUserPrompt(input: ClaudeCodePromptInput): string {
  const goal = displayAgentGoal(input.goal).trim();
  const parts: string[] = [];
  if (goal) parts.push(goal);

  const brief = (input.brief ?? '').trim();
  if (brief) parts.push(brief);

  const planHint = (input.planHint ?? '').trim();
  if (planHint) parts.push(planHint);

  const ctx = (input.workspaceContext ?? '').trim();
  if (ctx) {
    // Strip accidental companion wrappers if a caller passed the wrong block.
    const cleaned = ctx
      .replace(/^#\s*Workspace context[^\n]*\n/i, '')
      .trim();
    if (cleaned) parts.push(cleaned);
  }

  parts.push(
    [
      'Constraints:',
      `- Work only inside this workspace (cwd): ${input.fsScope}`,
      '- Do not force-push or git reset --hard.',
      '- Prefer minimal targeted edits.',
      '- First understand structure (list/read), then edit; list files you will change.',
      '- When finished, print a short summary of files changed.',
    ].join('\n'),
  );

  return parts.join('\n\n');
}

/** Test helper: prompt must not look like Lia companion system. */
export function promptLooksLikeLiaSystem(text: string): boolean {
  return promptLooksLikeCompanionSystem(text);
}
