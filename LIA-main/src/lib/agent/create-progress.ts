// ============================================================================
// Create Runtime progress helpers — plan quality, inspect stalls, coach hints.
// Pure functions (no I/O / no server-only) so unit tests stay fast.
// ============================================================================

import { stepsHaveRuntimeVerify } from './runtime/verify';

/** Tools that only inspect the workspace — no progress toward launch. */
const INSPECT_TOOLS = new Set([
  'read_file',
  'list_tree',
  'list_dir',
  'grep',
  'file_search',
  'list_codebase_symbols',
  'search_codebase',
]);

const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'save_artifact']);

/** Consecutive inspect-only steps before we nudge Create Runtime forward. */
export const INSPECT_STALL_LIMIT = 3;

/** Steps left (including current) when we force a runtime_start nudge. */
export const RUNTIME_BUDGET_NUDGE_REMAINING = 4;

function stepsHaveSuccessfulWrites(
  steps: Array<{ action: string; observation?: string }>,
): boolean {
  return steps.some((s) => {
    const action = (s.action || '').toLowerCase();
    if (!/(write_file|edit_file|save_artifact)/.test(action)) return false;
    const obs = (s.observation || '').toLowerCase();
    if (/"error"\s*:/.test(s.observation || '') || /\berror\b.*failed|не удалось|permission denied/.test(obs)) {
      return false;
    }
    return true;
  });
}

export function splitActionTools(action: string): string[] {
  return action
    .split(/\s*\+\s*/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** True when every tool in the step is inspect-only (compound actions supported). */
export function isInspectOnlyAction(action: string): boolean {
  const parts = splitActionTools(action);
  if (parts.length === 0) return false;
  if (parts.some((p) => p === 'strategy_hint' || p === 'user_guidance' || p === 'reason')) {
    return false;
  }
  return parts.every((p) => INSPECT_TOOLS.has(p));
}

export function trailingInspectOnlyCount(
  steps: Array<{ action: string }>,
): number {
  let count = 0;
  for (let i = steps.length - 1; i >= 0; i--) {
    const a = steps[i].action;
    if (a === 'strategy_hint' || a === 'user_guidance') continue;
    if (isInspectOnlyAction(a)) count++;
    else break;
  }
  return count;
}

/**
 * LLM create plans that only say «propose_design» (or omit write/runtime)
 * burn the whole step budget — replace with fallback.
 */
export function isIncompleteCreatePlan(steps: string[]): boolean {
  const meaningful = steps
    .map((s) => s.trim())
    .filter((s) => {
      const t = s.toLowerCase();
      return t.length > 0 && t !== '(без описания)' && t !== 'без описания' && t !== '...';
    });
  if (meaningful.length === 0) return true;

  const joined = meaningful.join('\n').toLowerCase();
  const hasWrite =
    /write_file|edit_file|save_artifact/.test(joined)
    || /напис|запис.*(файл|код)|создай файл|scaffold|реализ/.test(joined);
  const hasRuntime =
    /runtime_start/.test(joined)
    || /запуск.*(preview|сервер|runtime)|preview|health|verify/.test(joined);

  // Classic weak-model plan: single propose_design step.
  if (meaningful.length <= 2 && /propose_design/.test(joined) && !hasWrite) {
    return true;
  }
  if (!hasWrite || !hasRuntime) return true;
  return false;
}

export function looksLikeServerStartCommand(input: unknown): boolean {
  const cmds: Array<{ command?: string; args?: unknown }> = [];
  if (input && typeof input === 'object') {
    if (Array.isArray(input)) {
      for (const item of input) {
        if (item && typeof item === 'object' && 'input' in item) {
          cmds.push((item as { input: { command?: string; args?: unknown } }).input ?? {});
        } else if (item && typeof item === 'object') {
          cmds.push(item as { command?: string; args?: unknown });
        }
      }
    } else {
      cmds.push(input as { command?: string; args?: unknown });
    }
  }

  return cmds.some((c) => {
    const command = String(c.command ?? '').toLowerCase();
    const args = Array.isArray(c.args) ? c.args.map(String).join(' ').toLowerCase() : '';
    const line = `${command} ${args}`;
    if (!command) return false;
    if (/^(node|npm|npx|bun|yarn|pnpm|python|python3)$/.test(command)) {
      return /server|app\.js|index\.js|vite|serve|express|http\.createServer|--port|-p\s*\d+|listen/.test(line)
        || /\b(dev|start)\b/.test(args);
    }
    return false;
  });
}

/** Append system coach text after a misplaced run_command server start. */
export function annotateCreateRunCommandObservation(observation: string): string {
  const hint =
    '\n\n[СИСТЕМА: долгоживущий preview/сервер поднимай через runtime_start по lia.project.json '
    + '(не run_command node/npm). Порт 3000 занят Lia — в манифесте используй 5173+. '
    + 'При отсутствии зависимостей сначала scripts.install в манифесте или статический npx serve.]';
  if (observation.includes('[СИСТЕМА: долгоживущий preview')) return observation;
  return observation + hint;
}

export type CreateCoachOpts = {
  goal: string;
  steps: Array<{ action: string; observation?: string; input?: unknown }>;
  maxSteps: number;
  /** Index of the next step about to run (0-based). */
  nextStepIndex: number;
  requireRuntimeVerify: boolean;
  /** How many create-runtime coach hints already injected this run. */
  coachHintCount: number;
};

/**
 * Returns a strategy observation when Create Runtime is stalling / burning budget.
 * Caps at 2 hints per task so we don't spam the model.
 */
export function createRuntimeCoachObservation(opts: CreateCoachOpts): string | null {
  if (!opts.requireRuntimeVerify) return null;
  if (opts.coachHintCount >= 2) return null;
  if (!stepsHaveSuccessfulWrites(opts.steps)) return null;
  if (stepsHaveRuntimeVerify(opts.steps)) return null;

  const last = opts.steps[opts.steps.length - 1];
  // Let the model act on the previous coach before injecting another.
  if (last?.action === 'strategy_hint') return null;

  const remaining = opts.maxSteps - opts.nextStepIndex;
  const inspectStall = trailingInspectOnlyCount(opts.steps) >= INSPECT_STALL_LIMIT;
  const budgetTight = remaining <= RUNTIME_BUDGET_NUDGE_REMAINING;
  const lastWasServerCmd =
    !!last
    && /run_command/.test(last.action)
    && looksLikeServerStartCommand(last.input);

  const lastWasFailedRuntime =
    !!last
    && /runtime_start/.test(last.action)
    && /"success"\s*:\s*false|not allowed|не отвечает|unhealthy|лимит перезапуск/i.test(
      last.observation ?? '',
    );

  const wrote = opts.steps.some((s) =>
    splitActionTools(s.action).some((t) => WRITE_TOOLS.has(t)),
  );
  const midRunNoRuntime = wrote && opts.nextStepIndex >= Math.ceil(opts.maxSteps / 2);

  if (!inspectStall && !budgetTight && !lastWasServerCmd && !midRunNoRuntime && !lastWasFailedRuntime) {
    return null;
  }

  if (lastWasFailedRuntime) {
    return (
      'Стоп: runtime_start/preview не healthy. Для static preset пиши в КОРЕНЬ: '
      + 'index.html, style.css, script.js (не src/). Затем runtime_start без script override. '
      + 'Не vite. Не читай файлы по кругу.'
    );
  }

  if (inspectStall || lastWasServerCmd) {
    return (
      'Стоп: хватит читать / запускать сервер через run_command. На ЭТОМ шаге вызови runtime_start '
      + '(по lia.project.json или script="npx --yes serve -l 5173"). Не propose_design повторно. '
      + 'При ошибке — runtime_logs → правь scripts на npx serve → runtime_start.'
    );
  }

  return (
    'Стоп: файлы уже записаны, а runtime_start ещё не подтвердил preview. '
    + `Осталось ~${Math.max(remaining, 1)} шаг(ов). Сейчас вызови runtime_start. `
    + 'Статика: npx --yes serve -l 5173 (или src). Не vite без package.json.'
  );
}
