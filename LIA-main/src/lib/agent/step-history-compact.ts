import 'server-only';

/**
 * Compact older agent ReAct steps for the prompt.
 *
 * Recent steps stay full; older ones become a short action log so long
 * tasks (15–25 steps) don't blow the context with 5KB observations each.
 * Extractive (no LLM) — cheap and deterministic for local models.
 */

export const AGENT_RECENT_STEPS = 5;
const OLD_LINE_CAP = 140;

export type CompactableStep = {
  thought: string;
  action: string;
  observation: string;
};

function firstUsefulLine(text: string, cap: number): string {
  const cleaned = text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith('…['))
    ?? '';
  if (cleaned.length <= cap) return cleaned;
  return cleaned.slice(0, cap - 1) + '…';
}

/** One-line digest for a single older step. */
export function compactStepLine(step: CompactableStep, stepNum: number): string {
  const fromThought = firstUsefulLine(step.thought, 80);
  const fromObs = firstUsefulLine(step.observation, OLD_LINE_CAP);
  const detail = fromThought || fromObs || '(пусто)';
  return `${stepNum}. [${step.action}] ${detail}`;
}

/**
 * Format full previous-step history for the agent prompt.
 * Older than last AGENT_RECENT_STEPS → compact block; recent → full detail.
 */
export function formatAgentStepHistory(
  previousSteps: CompactableStep[],
  truncateObservation: (action: string, observation: string) => string,
): string {
  if (previousSteps.length === 0) return '(пока нет предыдущих шагов)';

  const recentStart = Math.max(0, previousSteps.length - AGENT_RECENT_STEPS);
  const older = previousSteps.slice(0, recentStart);
  const recent = previousSteps.slice(recentStart);
  const parts: string[] = [];

  if (older.length > 0) {
    const tools = [...new Set(older.map((s) => s.action).filter(Boolean))];
    parts.push(
      `Сжатый контекст ранних шагов (1–${older.length}):\n`
      + (tools.length ? `Инструменты: ${tools.join(', ')}\n` : '')
      + older.map((s, i) => compactStepLine(s, i + 1)).join('\n'),
    );
  }

  if (recent.length > 0) {
    const header = older.length > 0 ? 'Недавние шаги (подробно):\n' : '';
    const body = recent.map((s, i) => {
      const stepNum = recentStart + i + 1;
      const obs = truncateObservation(s.action, s.observation);
      return `Шаг ${stepNum}: [${s.action}] ${s.thought}\nРезультат: ${obs}`;
    }).join('\n\n');
    parts.push(header + body);
  }

  return parts.join('\n\n');
}

const FILE_CHANGES_DIGEST_CAP = 1000;

/** Compact list of files touched this task (for execute context). */
export function formatFileChangesDigest(
  changes: Array<{ path: string; tool: string; status: string }>,
  cap = FILE_CHANGES_DIGEST_CAP,
): string {
  if (!changes.length) return '';
  const lines = changes.slice(0, 40).map((c) => {
    const op = c.tool === 'edit_file' ? 'edit' : 'write';
    return `- ${op} ${c.path} (${c.status})`;
  });
  let block = `Файлы этой задачи (уже записаны/предложены):\n${lines.join('\n')}`;
  if (block.length > cap) block = `${block.slice(0, cap - 1)}…`;
  return block;
}
