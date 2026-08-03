import 'server-only';

// ============================================================================
// Agent runner helpers — extracted from runner.ts to reduce god function size.
// ============================================================================
//
// These functions were inlined in runAgentTask (originally 523 lines, grew to
// ~1100). Each is now a standalone function with explicit inputs/outputs —
// easier to test and reason about. The runner orchestrates them.
//
// Helpers (lifecycle):
//   - setupWatchdog: wall-time safety net that force-fails hung tasks
//   - resumeFromCheckpoint: restores plan + steps from saved checkpoint
//   - synthesizeAndFinish: runs LLM synthesis, persists final state, emits events
//   - checkBudgetExtension: asks user whether to extend wall-time budget
//
// Helpers (LLM phases, extracted 2026-07-08):
//   - generatePlan: PLAN phase — LLM produces structured plan JSON
//   - fallbackPlan: heuristic plan when LLM fails / degenerate output
//   - buildStepMessages: builds system + user messages for one step
//   - executeStep: EXECUTE phase — streamText with tools, fallback to text-only
//   - synthesize: SYNTHESIZE phase — final answer from gathered info
//   - formatToolObservation: normalize tool output for observation field
//
// Constants (exported so runner.ts can keep using them):
//   - PLANNING_TEMPERATURE / EXECUTION_TEMPERATURE / SYNTHESIS_TEMPERATURE
//   - PLANNING_MAX_TOKENS / EXECUTION_MAX_TOKENS / SYNTHESIS_MAX_TOKENS
//   - OBSERVATION_CAP
//   - LLM_TIMEOUT_MS / SYNTHESIS_TIMEOUT_MS (computed from env via safeParseIntMs)
//   - planSchema / planStepSchema

import { streamText, isStepCount, type ModelMessage, type ToolSet } from 'ai';
import { z } from 'zod';
import {
  getAgentModel,
  getAgentModelName,
  getChatModel,
  getHeavyModelName,
  getModelName,
  setOllamaNumCtx,
  setOllamaKeepAlive,
} from '@/lib/ollama';
import { applyOllamaNumCtxForRole } from '@/lib/chat/inference-ctx';
import { decideModelEscalate } from '@/lib/llm/model-escalate';
import { summarizeLlmError as extractErrorSummary } from '@/lib/llm/error-summary';
import { logger } from '@/lib/logger';
import type { TaskComplexity } from '@/lib/task-complexity';
import { classifyTaskComplexity } from '@/lib/task-complexity';
import { updateAgentTask, type AgentTask } from './task';
import { persistAgentResultToChat, emitTaskFailedToChat } from './persist-to-chat';
import { emitAgentEvent, signalCancellation, cancelWaiting } from './events';
import { waitForUserInput, type AgentCheckpoint } from './wait-input';
import { getMessages } from '@/lib/memory/episodes';
import { remember } from '@/lib/memory/vector';
import { displayAgentGoal } from './goal-display';
import {
  buildPlanSystemPrompt,
  buildExecuteSystemPrompt,
  buildSynthesizeSystemPrompt,
  type ExecutePromptMode,
  type SynthesizeSystemKind,
} from './phase-prompts';
import {
  truncateObservationForPrompt,
  truncateObservationForSynthesis,
  isKbLookupGoal,
  isCodeExplorationGoal,
  isCodeCreationGoal,
  isKbAssistedGoal,
  parseGroundedKbJson,
  formatGroundedKbAnswer,
  isKbAgentAction,
  stepsHaveCreationArtifacts,
} from './kb-step-utils';
import { isFixOrDebugArtifactGoal, isReferentialWorkspaceGoal, shouldReuseRecentEpisodeSandbox } from './artifact-followup-client';
import { applyGroundednessFilter } from './kb-groundedness';
import { packKbEvidenceForSynthesis } from './kb-evidence-pack';
import { isProjectRootFsScope } from './workspace-scope';
import { formatAgentStepHistory, formatFileChangesDigest } from './step-history-compact';
import { stepsHaveRuntimeVerify } from './runtime/verify';
import { designNeedsRuntimeVerify, inferProjectDesign } from './runtime/infer-design';
import {
  buildCodingTaskBrief,
  normalizeTargetFiles,
} from './coding-intent';
import { loadCodingBriefPromptBlock, saveCodingTaskBrief } from './coding-brief';
import { listTaskFileChanges } from './file-changes';
import { buildCodebaseSketch } from './explore-probe';
import {
  annotateCreateRunCommandObservation,
  isIncompleteCreatePlan,
  looksLikeServerStartCommand,
} from './create-progress';
import {
  describePresetForPrompt,
  resolveCreatePresetId,
} from './runtime/presets';

/** Map agent plan complexity band → TaskComplexity for escalate policy. */
function agentPlanComplexityToTask(c: 'low' | 'medium' | 'high' | undefined): TaskComplexity {
  if (c === 'high') return 'complex';
  if (c === 'medium') return 'moderate';
  return 'simple';
}

/**
 * Resolve model for an agent LLM phase.
 * Prefer: plan/replan → heavy when escalate; execute → agent (heavy after loops);
 * synthesize → day/chat when heavy configured (Lia face).
 */
async function resolveAgentPhaseModel(params: {
  phase: 'plan' | 'execute' | 'synthesize' | 'replan';
  goal: string;
  planComplexity?: 'low' | 'medium' | 'high';
  loopCount?: number;
  loopDetected?: boolean;
  weakPlan?: boolean;
}): Promise<{ model: Awaited<ReturnType<typeof getAgentModel>>; modelName: string; usedHeavy: boolean; reason: string }> {
  const heavyName = await getHeavyModelName();
  const heavyConfigured = Boolean(heavyName);
  const complexity = params.planComplexity
    ? agentPlanComplexityToTask(params.planComplexity)
    : classifyTaskComplexity(params.goal);

  const decision = decideModelEscalate({
    complexity,
    mode: 'agent',
    phase: params.phase,
    heavyConfigured,
    signals: {
      loopCount: params.loopCount,
      loopDetected: params.loopDetected,
      weakPlan: params.weakPlan,
    },
  });

  // Synthesize: day/chat voice when heavy is configured (Lia face after brain).
  // When heavy unset → keep agent model (pre-M3).
  if (params.phase === 'synthesize') {
    if (heavyConfigured) {
      const model = await getChatModel();
      return {
        model,
        modelName: await getModelName(),
        usedHeavy: false,
        reason: 'synthesize-day-voice',
      };
    }
    const model = await getAgentModel();
    return {
      model,
      modelName: await getAgentModelName(),
      usedHeavy: false,
      reason: 'synthesize-agent',
    };
  }

  if (decision.role === 'heavy' && heavyName) {
    logger.info('agent', 'Escalate to heavy', {
      phase: params.phase,
      heavy: heavyName,
      reason: decision.reason,
    });
    const model = await getChatModel(heavyName);
    return { model, modelName: heavyName, usedHeavy: true, reason: decision.reason };
  }

  const model = await getAgentModel();
  return {
    model,
    modelName: await getAgentModelName(),
    usedHeavy: false,
    reason: decision.reason,
  };
}
/** Create / fix living artifacts that need Process Supervisor before ГОТОВО. */
export function goalRequiresRuntimeVerify(goal: string): boolean {
  if (!isCodeCreationGoal(goal) && !shouldReuseRecentEpisodeSandbox(goal)) return false;
  return designNeedsRuntimeVerify(inferProjectDesign(goal));
}

// ============================================================================
// Constants (extracted from runner.ts — single source of truth)
// ============================================================================
export const PLANNING_TEMPERATURE = 0.3;
export const EXECUTION_TEMPERATURE = 0.5;
export const SYNTHESIS_TEMPERATURE = 0.6;
export const OBSERVATION_CAP = 5000;
/** KB tool outputs (get_source focused chunks) need a larger store cap. */
export const OBSERVATION_CAP_KB = 16_000;
/** run_command — keep enough test/git output for 8–20B + UI. */
export const OBSERVATION_CAP_CMD = 12_000;
export const EXECUTION_MAX_TOKENS = 4000; // legacy floor — prefer resolveAgentPhaseMaxTokens()
export const SYNTHESIS_MAX_TOKENS = 3000; // legacy floor — prefer resolveAgentPhaseMaxTokens()
export const PLANNING_MAX_TOKENS = 1200; // short step strings only — never file bodies

/**
 * Tier-aware output budget for agent LLM phases.
 *
 * Hard-coded 3–4k caps ignored plus/max model capacity (permanent under-use).
 * Execution/synthesis follow agent-role CognitiveParams.maxTokens; planning stays compact.
 */
export async function resolveAgentPhaseMaxTokens(
  phase: 'planning' | 'execution' | 'synthesis',
): Promise<number> {
  if (phase === 'planning') return PLANNING_MAX_TOKENS;
  const floor = phase === 'synthesis' ? SYNTHESIS_MAX_TOKENS : EXECUTION_MAX_TOKENS;
  try {
    const { getAgentCognitiveParams } = await import('@/lib/capability-profile');
    const { params } = await getAgentCognitiveParams();
    // Trust agent-tier budget; never below legacy floor on standard+ (micro may be lower).
    if (params.maxTokens < floor) return params.maxTokens;
    return params.maxTokens;
  } catch {
    return floor;
  }
}

// LLM call timeouts — конфигурируемые через env.
// На macOS arm64 с qwen3:8b генерация может занимать 60-90с,
// на более мощных машинах с 70B-моделями — до 3-5 минут.
// Если LLM таймаутит, увеличи LIA_LLM_TIMEOUT_MS в .env.
// P2-6 fix (M-AGT): guard against NaN from malformed env vars.
// Previous code used `parseInt(...)` without checking the result — if
// LIA_LLM_TIMEOUT_MS was set to '180s' or 'abc', parseInt returned NaN,
// and `AbortSignal.timeout(NaN)` threw RangeError, crashing the runner.
function safeParseIntMs(envVar: string | undefined, defaultValue: number): number {
  if (!envVar) return defaultValue;
  const parsed = parseInt(envVar, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultValue;
  return parsed;
}

export const LLM_TIMEOUT_MS = safeParseIntMs(process.env.LIA_LLM_TIMEOUT_MS, 180_000);
export const SYNTHESIS_TIMEOUT_MS = safeParseIntMs(process.env.LIA_LLM_SYNTHESIS_TIMEOUT_MS, Math.max(LLM_TIMEOUT_MS, 240_000));

// ============================================================================
// Plan schema (used by generatePlan + tests)
// ============================================================================
// LLM-ы часто возвращают steps как массив объектов { thought, action } вместо
// массива строк. Zod-схема принимает оба формата и нормализует в string[].
const planStepSchema = z.union([
  z.string(),
  z.object({ thought: z.string().optional(), action: z.string().optional(), step: z.string().optional() })
    .transform(obj => obj.action ?? obj.step ?? obj.thought ?? '(без описания)'),
]);

export const planSchema = z.object({
  goal: z.string().min(1).default('Выполнить задачу'),
  steps: z.array(planStepSchema).default([]),
  needsTools: z.boolean().default(true),
  complexity: z.enum(['low', 'medium', 'high']).default('medium').catch('medium'),
  targetFiles: z.array(z.string()).optional().default([]),
});

export type AgentPlan = z.infer<typeof planSchema> & { targetFiles: string[] };

// NOTE: previously runner-helpers.ts had its own `OBSERVATION_CAP = 4000` for
// resumeFromCheckpoint, while runner.ts used `OBSERVATION_CAP = 5000` for
// executeStep. This silent mismatch meant user-answer observations were
// truncated more aggressively than tool observations. Unified to 5000
// (extracted 2026-07-08) — single source of truth above.
const STOP_WORDS = ['стоп', 'stop', 'нет', 'no', 'отмена', 'cancel', 'остановись', 'хватит'];
// P-CORE-14 fix: previously any non-stop-word answer was treated as "continue".
// A confused user typing "что?", "не понял", "подожди", "подумаю" silently
// authorized another half-batch of GPU time. Now we require an explicit
// continue-word; anything else re-asks the question (max 3 re-asks) before
// falling back to cancellation.
const CONTINUE_WORDS = ['продолжить', 'продолжаем', 'продолжай', 'continue', 'yes', 'да', 'ок', 'ok', 'окей', 'давай'];
const MAX_BUDGET_REASKS = 3;

type RunnerLogger = ReturnType<typeof logger.context>;

/**
 * Setup wall-time watchdog. If the task exceeds maxDurationSec, force-fails
 * it via abort + cancellation signal + DB write.
 *
 * Returns the timer (caller stores it and clears it on completion), or null
 * when duration is unbounded (maxDurationSec === 0).
 * Timer is .unref()'d so it doesn't prevent Node shutdown.
 */
export function setupWatchdog(
  taskId: string,
  task: AgentTask,
  log: RunnerLogger,
  abortTask: (taskId: string) => void,
  computeWallTimeMs: (maxDurationSec: number) => number,
): ReturnType<typeof setTimeout> | null {
  const wallTimeMs = computeWallTimeMs(task.maxDurationSec);
  if (!Number.isFinite(wallTimeMs) || wallTimeMs <= 0) {
    log.info('agent', 'Watchdog skipped — unbounded duration', {
      maxDurationSec: task.maxDurationSec,
    });
    return null;
  }
  const watchdogTimer = setTimeout(() => {
    if (isTaskActive(taskId)) {
      log.error('agent', `WATCHDOG: Task exceeded ${wallTimeMs / 60000}min wall time, force-failing`, {
        wallTimeMs,
      });
      signalCancellation(taskId);
      cancelWaiting(taskId);
      abortTask(taskId);
      (async () => {
        try {
          await updateAgentTask(taskId, {
            status: 'failed',
            completedAt: new Date(),
            error: `Задача превысила максимальное время выполнения (${wallTimeMs / 60000} мин). Возможно, LLM завис или инструмент не ответил.`,
          });
        } catch (e) {
          log.error('agent', 'WATCHDOG: failed to write terminal status to DB', { taskId: taskId.slice(0, 8) }, e);
        }
      })();
    }
  }, wallTimeMs);
  watchdogTimer.unref?.();
  return watchdogTimer;
}

// Reference to activeRunners — set at runner init. Avoids circular import.
let activeRunnersRef: Set<string> | null = null;

/** Called once from runner.ts to wire up the activeRunners reference. */
export function _setActiveRunnersRef(ref: Set<string>): void {
  activeRunnersRef = ref;
}

function isTaskActive(taskId: string): boolean {
  return activeRunnersRef?.has(taskId) ?? false;
}

export interface ResumedState {
  plan: AgentCheckpoint['plan'];
  steps: Array<{ thought: string; action: string; input: unknown; observation: string; ts: number; durationMs?: number }>;
}

/**
 * Resume a task from its checkpoint. Restores plan + steps, replays step_end
 * events for UI, and handles any pendingQuestion from before the restart.
 *
 * Returns the resumed state, or null if checkpoint is missing/corrupt (caller
 * should run generatePlan instead).
 */
export async function resumeFromCheckpoint(
  taskId: string,
  task: AgentTask,
  log: RunnerLogger,
): Promise<ResumedState | null> {
  if (!task.checkpointJson) return null;

  try {
    const checkpoint = JSON.parse(task.checkpointJson) as AgentCheckpoint;
    const plan = checkpoint.plan;
    const steps = checkpoint.steps;

    log.info('agent', `RESUMING from checkpoint — ${steps.length} steps already done`, {
      planStepsCount: plan.steps.length,
      savedAt: new Date(checkpoint.savedAt).toISOString(),
    });
    emitAgentEvent({
      type: 'task_plan_ready',
      taskId,
      plan: {
        goal: displayAgentGoal(plan.goal) || displayAgentGoal(task.goal),
        steps: plan.steps,
        complexity: plan.complexity,
        targetFiles: plan.targetFiles ?? [],
      },
      ts: Date.now(),
    });

    // Handle pending question from before restart
    if (checkpoint.pendingQuestion) {
      try {
        const answer = await waitForUserInput(taskId, checkpoint.pendingQuestion);
        steps.push({
          thought: 'Ответ пользователя после восстановления задачи',
          action: 'ask_user',
          input: { question: checkpoint.pendingQuestion },
          observation: answer.slice(0, OBSERVATION_CAP),
          ts: Date.now(),
        });
        await updateAgentTask(taskId, {
          currentStep: steps.length,
          stepsJson: JSON.stringify(steps),
          checkpointJson: JSON.stringify({ ...checkpoint, steps, pendingQuestion: undefined, savedAt: Date.now() }),
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log.warn('agent', 'Resume waiting_input failed', { error: msg });
        if (msg.includes('cancelled') || msg.includes('timeout')) {
          await updateAgentTask(taskId, {
            status: msg.includes('cancelled') ? 'cancelled' : 'failed',
            completedAt: new Date(),
            error: msg,
          });
          if (msg.includes('cancelled')) {
            emitAgentEvent({ type: 'task_cancelled', taskId, ts: Date.now() });
          } else {
            await emitTaskFailedToChat(task, msg);
          }
          throw new Error(`__resume_cancelled__:${msg}`);
        }
      }
    }

    // Replay already-completed steps for UI
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      emitAgentEvent({
        type: 'step_end',
        taskId,
        step: i + 1,
        action: s.action,
        observation: s.observation.slice(0, 500),
        thought: s.thought.slice(0, 300),
        durationMs: s.durationMs ?? 0,
        ts: s.ts,
      });
    }

    return { plan, steps };
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('__resume_cancelled__')) {
      throw e;
    }
    log.warn('agent', 'Checkpoint parse failed — starting fresh', {}, e);
    await updateAgentTask(taskId, { checkpointJson: null, stepsJson: '[]', currentStep: 0 });
    return null;
  }
}

/**
 * Handle wall-time budget extension. When maxDurationSec is exceeded, asks
 * the user whether to extend or stop.
 *
 * Returns the new startTime (epoch ms) — caller uses this to reset the
 * budget clock. If the user chose to stop, returns null and the caller
 * should signal cancellation.
 *
 * Unbounded tasks (maxDurationSec === 0) never call this.
 */
export async function checkBudgetExtension(
  taskId: string,
  task: AgentTask,
  elapsedSec: number,
  log: RunnerLogger,
): Promise<number | null> {
  if (task.maxDurationSec <= 0) {
    return Date.now(); // no-op for unbounded — should not be called
  }
  log.warn('agent', `Budget exceeded — asking user to extend`, {
    elapsedSec: Math.floor(elapsedSec),
    maxDurationSec: task.maxDurationSec,
  });
  const extensionSec = Math.max(60, Math.floor(task.maxDurationSec / 2));

  // P-CORE-14 fix: re-ask up to MAX_BUDGET_REASKS times if the user's answer
  // is neither an explicit continue-word nor a stop-word. Previously any
  // non-stop-word authorized extension — confused users burned GPU silently.
  let userAnswer = '';
  for (let attempt = 0; attempt < MAX_BUDGET_REASKS; attempt++) {
    const prompt = attempt === 0
      ? `Превышен лимит времени (${Math.floor(elapsedSec)} сек из ${task.maxDurationSec}). Продолжить ещё на ${extensionSec} сек или остановиться? Ответь "продолжить" или "стоп".`
      : `Не понял ответ. Нужно продолжить (ответь "продолжить") или остановиться (ответь "стоп")? Попытка ${attempt + 1}/${MAX_BUDGET_REASKS}.`;
    userAnswer = await waitForUserInput(taskId, prompt);
    log.info('agent', `Budget extension answer`, { answer: userAnswer.slice(0, 50), attempt });

    const answerLower = userAnswer.toLowerCase().trim();
    if (STOP_WORDS.some(w => answerLower.includes(w))) {
      signalCancellation(taskId);
      return null;
    }
    if (CONTINUE_WORDS.some(w => answerLower.includes(w))) {
      break;  // explicit continue — proceed to extension
    }
    // Neither stop nor continue — re-ask (unless this was the last attempt).
    if (attempt === MAX_BUDGET_REASKS - 1) {
      log.warn('agent', `Budget extension: no clear answer after ${MAX_BUDGET_REASKS} attempts — cancelling`);
      signalCancellation(taskId);
      return null;
    }
  }

  // Reset startTime so the new budget clock starts from now minus the
  // remaining extension time.
  return Date.now() - (task.maxDurationSec - extensionSec) * 1000;
}

/**
 * Synthesize the final result and persist task as 'done'. Loads recent
 * dialogue history for context, calls synthesize(), saves resultSummary,
 * emits task_done, and remembers the summary in vector memory.
 *
 * Non-throwing — errors are logged but don't propagate (caller has already
 * handled the happy path; this is the final wrap-up).
 */
export async function synthesizeAndFinish(
  taskId: string,
  task: AgentTask,
  plan: AgentCheckpoint['plan'],
  steps: ResumedState['steps'],
  startTime: number,
  log: RunnerLogger,
  synthesize: (task: AgentTask, plan: AgentCheckpoint['plan'], steps: ResumedState['steps'], dialogueHistory: Array<{ role: string; content: string }>, taskSignal: AbortSignal) => Promise<string>,
  taskSignal: AbortSignal,
): Promise<void> {
  log.info('agent', `SYNTHESIZE phase started (after ${steps.length} steps)`);
  await updateAgentTask(taskId, { status: 'synthesizing' });
  emitAgentEvent({ type: 'task_synthesizing', taskId, ts: Date.now() });

  let dialogueHistory: Array<{ role: string; content: string }> = [];
  try {
    const recentMsgs = await getMessages(task.episodeId, 8);
    dialogueHistory = recentMsgs
      .filter(m => m.role === 'user' || m.role === 'companion')
      .slice(-6)
      .map(m => ({ role: m.role, content: m.content.slice(0, 300) }));
    log.debug('agent', `Dialogue history loaded (${dialogueHistory.length} messages)`);
  } catch (e) {
    log.warn('agent', 'Failed to load dialogue history for synthesize', {}, e);
  }

  const synthStart = Date.now();
  const resultSummary = await synthesize(task, plan, steps, dialogueHistory, taskSignal);
  log.info('agent', `Synthesis done (${Date.now() - synthStart}ms)`, {
    resultLength: resultSummary.length,
    resultPreview: resultSummary.slice(0, 200),
  });

  await updateAgentTask(taskId, {
    status: 'done',
    completedAt: new Date(),
    resultSummary,
    stepsJson: JSON.stringify(steps),
    checkpointJson: null,
  });

  log.info('agent', 'Task DONE', {
    totalSteps: steps.length,
    totalMs: Date.now() - startTime,
  });

  // Root tasks: also land the answer in the main chat (durable + visible).
  const chatMessageId = await persistAgentResultToChat(task, resultSummary);

  emitAgentEvent({
    type: 'task_done',
    taskId,
    resultSummary,
    ...(chatMessageId ? { chatMessageId } : {}),
    ts: Date.now(),
  });

  if (resultSummary.trim()) {
    remember({
      episodeId: task.episodeId,
      sourceType: 'summary',
      text: `[agent:${task.goal.slice(0, 120)}] ${resultSummary.slice(0, 1500)}`,
    }).catch(() => null);
  }

  // Durable coding brief for follow-up tasks on the same workspace.
  if (task.fsScope) {
    const files = listTaskFileChanges(taskId)
      .filter((c) => c.status === 'applied' || c.status === 'pending')
      .map((c) => c.path);
    const fromPlan = normalizeTargetFiles(plan?.targetFiles);
    const brief = buildCodingTaskBrief({
      goal: displayAgentGoal(task.goal),
      summary: resultSummary,
      files: [...fromPlan, ...files],
    });
    await saveCodingTaskBrief(task.fsScope, brief);
  }
}

// ============================================================================
// PLAN phase — generate structured plan via LLM, with heuristic fallback
// ============================================================================

/** Auto-created empty write sandbox under download/agent-workspaces — not the project repo. */
export function isSandboxFsScope(fsScope: string | null | undefined): boolean {
  if (!fsScope) return false;
  return /agent-workspaces[/\\]/i.test(fsScope);
}

/** Honest FS description for plan/step prompts. */
export function describeFsScopeForPrompt(
  fsScope: string | null | undefined,
  goal?: string,
): string {
  if (!fsScope) {
    return 'Рабочая директория не задана — write/list_dir по диску недоступны. Для кода: search_codebase / list_codebase_symbols / list_sources.';
  }
  if (isSandboxFsScope(fsScope)) {
    if (goal && isCodeCreationGoal(goal)) {
      const presetId = resolveCreatePresetId(goal);
      return [
        `Рабочая директория — write-sandbox: ${fsScope}.`,
        describePresetForPrompt(presetId),
        'lia.project.json уже мог создать Design Gate — не переизобретай стек.',
        'НЕ пиши ГОТОВО без успешного write_file и runtime_start (HTTP 200 на preview).',
      ].join(' ');
    }
    if (goal && (isFixOrDebugArtifactGoal(goal) || isReferentialWorkspaceGoal(goal))) {
      return [
        `Рабочая директория — sandbox с файлами недавней задачи: ${fsScope}.`,
        'Сначала list_tree и read_file (index.html / script.js / style.css). Не вызывай list_sources/ask_user «какая игра».',
        'Баг фиксируй через edit_file / write_file, затем runtime_start.',
      ].join(' ');
    }
    return [
      `Рабочая директория — sandbox для артефактов (НЕ исходники проекта Lia): ${fsScope}.`,
      'Если здесь уже есть файлы задачи — list_tree / read_file.',
      'Для анализа чужого репозитория: search_codebase / list_sources (если подключены).',
      'Создание с нуля — write_file в этот sandbox.',
    ].join(' ');
  }
  if (isProjectRootFsScope(fsScope)) {
    return [
      `Рабочая директория = корень проекта Lia (workspace): ${fsScope}.`,
      'Исследуй код: list_tree → grep → read_file. search_codebase опционален.',
      'Не спрашивай «какой проект» — это и есть репозиторий. Не заканчивай на пустом list_tree (если пусто — проверь путь).',
    ].join(' ');
  }
  return [
    `Рабочая директория (внешний workspace): ${fsScope}.`,
    'Исследуй: list_tree → list_dir по реальным папкам → grep/read_file. Не предполагай структуру Lia.',
  ].join(' ');
}

/**
 * Completion signal: only start-of-string or start-of-line `ГОТОВО:` / `DONE:`
 * (optional dash). Mid-sentence "готово" / English "finished:" no longer ends the loop.
 */
export const AGENT_COMPLETION_SIGNAL =
  /(?:^|\n)\s*(готово|done)\s*[:\-—]/imu;

/** Tool observations that mean the goal is NOT done — ignore ГОТОВО. */
export function observationBlocksCompletion(observation: string): boolean {
  if (!observation || observation.trim().length === 0) return true;
  const o = observation.toLowerCase();
  return (
    /"error"\s*:/.test(observation)
    || /"tree"\s*:\s*\[\s*\]/.test(observation)
    || /"items"\s*:\s*\[\s*\]/.test(observation)
    || /нет подключ[её]нных кодовых баз/.test(o)
    || /выходит за пределы рабочей директории/.test(o)
    || /path.*outside|not found|источник не найден/.test(o)
  );
}

export function hasAgentCompletionSignal(
  text: string,
  lastObservation?: string,
): boolean {
  if (!AGENT_COMPLETION_SIGNAL.test(text)) return false;
  if (lastObservation !== undefined && observationBlocksCompletion(lastObservation)) {
    return false;
  }
  return true;
}

/**
 * Create/implement goals must not end on prose «ГОТОВО» without file writes.
 * Living artifacts also require a successful runtime_start (verify) before ГОТОВО.
 */
export function shouldAcceptAgentCompletion(opts: {
  goal: string;
  text: string;
  lastObservation?: string;
  stepsIncludingCurrent: Array<{ action: string; observation?: string }>;
  /** When true (create + preview design), require runtime_start success. */
  requireRuntimeVerify?: boolean;
}): boolean {
  if (!hasAgentCompletionSignal(opts.text, opts.lastObservation)) return false;
  if (isCodeCreationGoal(opts.goal) && !stepsHaveCreationArtifacts(opts.stepsIncludingCurrent)) {
    return false;
  }
  if (opts.requireRuntimeVerify && !stepsHaveRuntimeVerify(opts.stepsIncludingCurrent)) {
    return false;
  }
  return true;
}

/**
 * Heuristic fallback plan when LLM planning fails or returns degenerate output.
 * Pure function — no side effects, safe to call from anywhere.
 */
/** News / current-events goals — prefer web tools, not generic «проанализировать». */
export function isCurrentEventsGoal(goal: string): boolean {
  const g = goal.toLowerCase();
  return (
    /новост|сегодня|свеж(ие|ая|ий)|лента\b|заголовк/.test(g)
    || /\bсво\b|спецоперац|что\s+(сейчас\s+)?с\s+/.test(g)
    || /ria\.ru|bbc|reuters|коммерсант/.test(g)
  );
}

type FallbackPlanKind =
  | 'current_events'
  | 'code_create'
  | 'code_sandbox_artifact'
  | 'code_lia_root'
  | 'code_external_fs'
  | 'code_kb'
  | 'kb_lookup'
  | 'default';

const FALLBACK_PLANS: Record<
  FallbackPlanKind,
  { steps: string[]; needsTools: boolean; complexity: AgentPlan['complexity'] }
> = {
  current_events: {
    steps: [
      'web_search по ключевым словам из цели (сегодня / актуальные новости)',
      'fetch_page 1–2 топ-лент из результатов (не только сниппеты)',
      'ГОТОВО: краткая сводка с фактами и источниками (URL)',
    ],
    needsTools: true,
    complexity: 'low',
  },
  code_create: {
    steps: [
      'write_file index.html + style.css + script.js (preset static, корень sandbox)',
      'runtime_start — preview на 5173 (npx serve), дождаться HTTP 200',
      'При ошибке: runtime_logs → edit_file → runtime_start; затем ГОТОВО',
    ],
    needsTools: true,
    complexity: 'medium',
  },
  code_sandbox_artifact: {
    steps: [
      'list_tree — файлы в sandbox этой задачи',
      'read_file основных файлов (index.html / script.js / style.css)',
      'edit_file или write_file — исправить проблему',
      'runtime_start — проверить, что снова запускается; ГОТОВО',
    ],
    needsTools: true,
    complexity: 'medium',
  },
  code_lia_root: {
    steps: [
      'list_tree — обзор структуры репозитория',
      'grep по ключевым символам из цели или file_search',
      'read_file ключевых модулей (из карты кода в контексте)',
      'Сформулировать находки (проблемы, ошибки, риски) с путями к файлам',
    ],
    needsTools: true,
    complexity: 'medium',
  },
  code_external_fs: {
    steps: [
      'list_tree — обзор структуры репозитория в fsScope',
      'list_dir / grep по путям из list_tree (не угадывай layout)',
      'read_file ключевых модулей; при необходимости edit_file для исправлений',
      'Кратко перечислить находки/правки с путями файлов',
    ],
    needsTools: true,
    complexity: 'medium',
  },
  code_kb: {
    steps: [
      'list_sources — какие folder/codebase источники доступны',
      'search_codebase по ключевым словам из задачи (если есть codebase)',
      'search_sources / read_folder_file для релевантных документов',
      'Сформулировать находки (проблемы, ошибки, риски)',
    ],
    needsTools: true,
    complexity: 'medium',
  },
  kb_lookup: {
    steps: [
      'list_sources',
      'search_sources по запросу',
      'get_source или read_folder_file для деталей',
      'Ответ с citation из источников',
    ],
    needsTools: true,
    complexity: 'low',
  },
  default: {
    steps: ['Проанализировать задачу', 'Собрать информацию', 'Сформулировать ответ'],
    needsTools: true,
    complexity: 'medium',
  },
};

function resolveFallbackPlanKind(task: AgentTask): FallbackPlanKind {
  if (isCurrentEventsGoal(task.goal)) return 'current_events';
  if (isCodeCreationGoal(task.goal) && !shouldReuseRecentEpisodeSandbox(task.goal)) {
    return 'code_create';
  }
  if (
    isSandboxFsScope(task.fsScope)
    && shouldReuseRecentEpisodeSandbox(task.goal)
  ) {
    return 'code_sandbox_artifact';
  }
  if (isCodeCreationGoal(task.goal)) return 'code_create';
  if (isCodeExplorationGoal(task.goal) || isKbAssistedGoal(task.goal)) {
    const hasProjectFs = isProjectRootFsScope(task.fsScope)
      || (!!task.fsScope && !isSandboxFsScope(task.fsScope));
    if (!hasProjectFs) {
      return isSandboxFsScope(task.fsScope) ? 'code_sandbox_artifact' : 'code_kb';
    }
    return isProjectRootFsScope(task.fsScope) ? 'code_lia_root' : 'code_external_fs';
  }
  if (isKbLookupGoal(task.goal)) return 'kb_lookup';
  return 'default';
}

export function fallbackPlan(task: AgentTask): AgentPlan {
  const base = FALLBACK_PLANS[resolveFallbackPlanKind(task)];
  return {
    goal: displayAgentGoal(task.goal),
    steps: base.steps,
    needsTools: base.needsTools,
    complexity: base.complexity,
    targetFiles: [],
  };
}

/**
 * Generate a structured plan via LLM.
 *
 * Returns a validated AgentPlan, or `fallbackPlan(task)` if:
 *   - LLM call fails (timeout, network, parse error)
 *   - response contains no valid JSON
 *   - response fails schema validation
 *   - plan is degenerate (≥50% duplicate steps — common with weak models)
 *   - plan exceeds task.maxSteps (truncated, but still returned)
 *
 * The `taskSignal` is combined with a timeout via `AbortSignal.any` so that
 * either cancelling the task OR the LLM_TIMEOUT_MS firing will abort the
 * streamText call. (P-CORE-13 fix — previously cancelling a task did not
 * abort in-flight LLM calls, wasting up to 3 minutes of GPU after Cancel.)
 */
export async function generatePlan(
  task: AgentTask,
  toolDescriptions: string,
  taskSignal: AbortSignal,
): Promise<AgentPlan> {
  try {
    const first = await generatePlanInner(task, toolDescriptions, taskSignal, {
      phase: 'plan',
      weakPlan: false,
    });
    if (!first.usedFallback) return first.plan;

    // Degenerate / parse failure → one replan on heavy when configured and not
    // already on heavy (wires decideModelEscalate weakPlan signal).
    const heavy = await getHeavyModelName();
    if (!heavy || first.usedHeavy) {
      return first.plan;
    }
    logger.info('agent', 'Weak plan — replan on heavy', {
      fallbackReason: first.fallbackReason,
      heavy,
    });
    const second = await generatePlanInner(task, toolDescriptions, taskSignal, {
      phase: 'replan',
      weakPlan: true,
    });
    return second.plan;
  } finally {
    setOllamaNumCtx(undefined);
    setOllamaKeepAlive(undefined);
  }
}

type PlanAttempt = {
  plan: AgentPlan;
  usedFallback: boolean;
  usedHeavy: boolean;
  fallbackReason?: string;
};

async function generatePlanInner(
  task: AgentTask,
  toolDescriptions: string,
  taskSignal: AbortSignal,
  opts: { phase: 'plan' | 'replan'; weakPlan: boolean },
): Promise<PlanAttempt> {
  const phaseModel = await resolveAgentPhaseModel({
    phase: opts.phase,
    goal: task.goal,
    weakPlan: opts.weakPlan,
  });
  // num_ctx from **heavy weights** when escalating — not day/agent size.
  if (phaseModel.usedHeavy) {
    setOllamaKeepAlive('0');
    await applyOllamaNumCtxForRole('agent', 'heavy');
  } else {
    await applyOllamaNumCtxForRole('agent', 'day');
  }
  const model = phaseModel.model;
  const fb = (reason: string): PlanAttempt => ({
    plan: fallbackPlan(task),
    usedFallback: true,
    usedHeavy: phaseModel.usedHeavy,
    fallbackReason: reason,
  });

  const fsHint = describeFsScopeForPrompt(task.fsScope, task.goal);
  const sandboxReuse = isSandboxFsScope(task.fsScope) && shouldReuseRecentEpisodeSandbox(task.goal);
  const explorationHint = isCodeExplorationGoal(task.goal) || isKbAssistedGoal(task.goal) || sandboxReuse
    ? (isProjectRootFsScope(task.fsScope)
      ? `- Для анализа проекта: list_tree → grep → read_file. Карта кода в контексте. Не ограничивайся docs.`
      : (task.fsScope && !isSandboxFsScope(task.fsScope)
        ? `- Внешний репозиторий в fsScope: list_tree → list_dir/grep/read_file только по путям этого workspace.`
        : sandboxReuse
          ? `- В sandbox уже есть файлы предыдущей задачи: list_tree → read_file → edit_file. НЕ планируй list_sources / ask_user «какая игра».`
          : `- Для анализа проекта/кода: list_sources → search_codebase (исходники) и/или search_sources (документы). Folder KB ≠ исходники (.ts). Не планируй list_tree по sandbox как обзор репозитория.`))
    : '';
  const kbOnlyHint = isKbLookupGoal(task.goal)
    ? `- Это lookup в базе знаний: планируй только KB-инструменты (list_sources, search_sources, get_source, read_folder_file).`
    : '';
  const createHint = isCodeCreationGoal(task.goal) && !sandboxReuse
    ? `- Это СОЗДАНИЕ артефакта. ${describePresetForPrompt(resolveCreatePresetId(task.goal))}
  План ОБЯЗАН содержать:
  1) write_file по дереву манифеста (для игр: index.html, style.css, script.js)
  2) runtime_start — verify preview (HTTP 200)
  3) при ошибке: runtime_logs → edit_file → runtime_start; затем ГОТОВО
- Запрещён одношаговый план и свободный выбор vite/express для простых игр.
- steps — короткие СТРОКИ.`
    : '';
  const fixHint = sandboxReuse && (isFixOrDebugArtifactGoal(task.goal) || isReferentialWorkspaceGoal(task.goal))
    ? `- Follow-up по артефакту: сначала list_tree/read_file в текущем sandbox, потом правка, затем runtime_start. Запрещено начинать с list_sources или ask_user.`
    : '';

  const briefBlock = await loadCodingBriefPromptBlock(task.fsScope);
  const briefHint = briefBlock
    ? `\n${briefBlock}\n- Учитывай previous coding brief при планировании follow-up; не повторяй уже сделанное без нужды.`
    : '';

  // Explore-then-plan: bounded sketch for coding/edit goals with a real fsScope.
  let codebaseSketch = '';
  const wantsCodingPlan =
    !!task.fsScope
    && (
      isCodeExplorationGoal(task.goal)
      || isCodeCreationGoal(task.goal)
      || /edit_file|write_file|компонент|route|роуть|навигац|backend|api\b|страниц/i.test(task.goal)
    );
  if (wantsCodingPlan) {
    codebaseSketch = await buildCodebaseSketch(task.fsScope, task.goal);
  }
  const sketchHint = codebaseSketch
    ? `\n${codebaseSketch}\n- В steps и targetFiles указывай конкретные пути из sketch/hits, где возможно.`
    : '';

  const systemPrompt = buildPlanSystemPrompt({
    toolDescriptions,
    maxSteps: task.maxSteps,
    fsHint: fsHint + briefHint + sketchHint,
    explorationHint,
    kbOnlyHint,
    createHint,
    fixHint,
    systemOverlay: task.systemOverlay,
  });

  try {
    logger.debug('agent', 'Plan generation: calling LLM', { maxTokens: PLANNING_MAX_TOKENS });
    // P-CORE-13 fix: combine task abort signal with timeout. Previously
    // `AbortSignal.timeout(LLM_TIMEOUT_MS)` was a fresh signal that didn't
    // listen to taskAbortCtrl — cancelling the task did NOT abort the
    // in-flight LLM call, which kept generating tokens until the timeout
    // fired (up to 3 minutes of wasted GPU/tokens after user clicked Cancel).
    const result = await streamText({
      model,
      system: systemPrompt,
      messages: [{ role: 'user', content: `Задача: "${displayAgentGoal(task.goal)}"` }],
      temperature: PLANNING_TEMPERATURE,
      maxOutputTokens: PLANNING_MAX_TOKENS,
      abortSignal: AbortSignal.any([taskSignal, AbortSignal.timeout(LLM_TIMEOUT_MS)]),
      onError: (error) => {
        // Vercel AI SDK onError callback receives a non-Error object.
        // String(error) → "[object Object]" which is useless for debugging.
        // Normalize: extract message, name, cause, stack.
        const normalized = error instanceof Error
          ? error
          : {
              name: (error as { name?: string })?.name ?? 'UnknownError',
              message: (error as { message?: string })?.message
                ?? (typeof error === 'string' ? error : JSON.stringify(error)),
              stack: (error as { stack?: string })?.stack,
            };
        logger.error('agent', 'Plan streamText onError', { taskGoal: task.goal.slice(0, 80) }, normalized);
      },
    });

    // Таймаут LLM_TIMEOUT_MS — если LLM не отвечает, fallback на дефолтный план.
    const text = await result.text;
    logger.debug('agent', `Plan LLM responded (${text.length} chars)`, {
      preview: text.slice(0, 200),
    });

    // P-CORE-27 fix: previously `text.match(/\{[\s\S]*\}/)` — greedy regex
    // from first `{` to last `}`. If the LLM emitted multiple JSON objects or
    // trailing prose with `}`, `JSON.parse` failed and the plan fell back to
    // the heuristic. Now we use the shared `extractJson` from prompt-safety,
    // which walks the string with brace-balancing + string awareness and
    // returns the first valid JSON object.
    const { extractJson } = await import('@/lib/infra/prompt-safety');
    const parsed = extractJson<unknown>(text);
    if (!parsed) {
      logger.warn('agent', 'Plan: no JSON found in response, using fallback', {
        preview: text.slice(0, 200),
      });
      return fb('no-json');
    }
    const validated = planSchema.safeParse(parsed);
    if (!validated.success) {
      logger.warn('agent', 'Plan: schema validation failed, using fallback', {
        errors: validated.error.issues.map(i => `${i.path.join('.')}: ${i.message}`),
      });
      return fb('schema');
    }

    // ── Sanity check: empty / placeholder plan is degenerate (weak models) ──
    const steps = validated.data.steps;
    const meaningful = steps.filter(s => {
      const t = s.trim().toLowerCase();
      return t.length > 0 && t !== '(без описания)' && t !== 'без описания' && t !== '...';
    });
    if (meaningful.length === 0) {
      logger.warn('agent', 'Plan: empty/placeholder steps, using fallback', {
        goal: task.goal.slice(0, 80),
        rawSteps: steps.slice(0, 3),
      });
      return fb('empty-steps');
    }

    // ── Sanity check: detect degenerate plans ──
    // Слабые модели (Llama-3.1-8b, gemma) иногда генерируют 10 одинаковых шагов
    // вроде `console.log('...')` × 10. Это бесполезно и тратит токены/время.
    // Если ≥50% шагов идентичны (case-insensitive) — отбрасываем в пользу fallback.
    if (meaningful.length >= 3) {
      const lowered = meaningful.map(s => s.trim().toLowerCase());
      const counts = new Map<string, number>();
      for (const s of lowered) counts.set(s, (counts.get(s) ?? 0) + 1);
      const maxDup = Math.max(...counts.values());
      if (maxDup / meaningful.length >= 0.5) {
        logger.warn('agent', 'Plan: degenerate (too many duplicate steps), using fallback', {
          stepsCount: meaningful.length,
          maxDuplicateRatio: maxDup / meaningful.length,
          sample: meaningful.slice(0, 3),
        });
        return fb('degenerate-dupes');
      }
    }

    // Create Runtime: reject 1-step propose_design / plans without write+runtime.
    if (
      isCodeCreationGoal(task.goal)
      && !shouldReuseRecentEpisodeSandbox(task.goal)
      && isIncompleteCreatePlan(meaningful)
    ) {
      logger.warn('agent', 'Plan: incomplete create pipeline, using fallback', {
        goal: task.goal.slice(0, 80),
        sample: meaningful.slice(0, 4),
      });
      return fb('incomplete-create');
    }

    // ── Sanity check: cap steps to maxSteps (on cleaned list, not raw placeholders) ──
    if (meaningful.length > task.maxSteps) {
      validated.data.steps = meaningful.slice(0, task.maxSteps);
      logger.warn('agent', 'Plan: truncated to maxSteps', {
        original: meaningful.length,
        capped: task.maxSteps,
      });
    } else {
      validated.data.steps = meaningful;
    }

    // Never leak template/system text into plan.goal (UI + further prompts).
    validated.data.goal = displayAgentGoal(validated.data.goal) || displayAgentGoal(task.goal);
    validated.data.targetFiles = normalizeTargetFiles(validated.data.targetFiles);
    return {
      plan: validated.data,
      usedFallback: false,
      usedHeavy: phaseModel.usedHeavy,
    };
  } catch (e) {
    logger.warn('agent', 'Plan generation failed — using fallback', { goal: task.goal.slice(0, 80) }, e);
    return fb('llm-error');
  }
}

// ============================================================================
// Build messages for a step — plan + previous steps + new prompt.
// Implements context window management: recent steps get full detail,
// older steps get summarized to prevent context overflow.
// ============================================================================
export function buildStepMessages(
  task: AgentTask,
  plan: { goal: string; steps: string[] },
  previousSteps: Array<{ thought: string; action: string; input: unknown; observation: string }>,
  toolDescriptions: string,
  contextStr: string,
): { system: string; messages: ModelMessage[] } {
  const planStr = plan.steps.map((s, i) => `${i + 1}. ${s}`).join('\n');

  // Context window: last 5 steps full; older → extractive compact (not raw 200-char trunc).
  const stepsStr = formatAgentStepHistory(previousSteps, truncateObservationForPrompt);
  const fileDigest = formatFileChangesDigest(
    listTaskFileChanges(task.id).map((c) => ({ path: c.path, tool: c.tool, status: c.status })),
  );
  const historyBlock = fileDigest ? `${stepsStr}\n\n${fileDigest}` : stepsStr;

  const isKbGoal = isKbLookupGoal(task.goal);
  const isExploration = isCodeExplorationGoal(task.goal) || isKbAssistedGoal(task.goal);
  const isCreation = isCodeCreationGoal(task.goal);
  const hasProjectWorkspace = isProjectRootFsScope(task.fsScope)
    || (!!task.fsScope && !isSandboxFsScope(task.fsScope));
  const isLiaWorkspace = isProjectRootFsScope(task.fsScope);
  const fsHint = describeFsScopeForPrompt(task.fsScope, task.goal);
  const userGoal = displayAgentGoal(task.goal);
  const planGoal = displayAgentGoal(plan.goal) || userGoal;

  let mode: ExecutePromptMode = 'general';
  if (isKbGoal) mode = 'kb';
  else if (isExploration) {
    if (hasProjectWorkspace) mode = isLiaWorkspace ? 'explore_lia' : 'explore_external';
    else mode = 'explore_fallback';
  } else if (isCreation) {
    mode = 'create';
  }

  const systemPrompt = buildExecuteSystemPrompt({
    userGoal,
    planGoal,
    planStr,
    toolDescriptions,
    contextStr,
    fsHint,
    mode,
    createPresetLine: mode === 'create'
      ? describePresetForPrompt(resolveCreatePresetId(task.goal))
      : undefined,
    systemOverlay: task.systemOverlay,
  });

  const userPrompt = `Предыдущие шаги:
${historyBlock}

Что делаем дальше?`;

  return {
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }] as ModelMessage[],
  };
}

// ============================================================================
// Format tool observation — normalize output for the observation field
// ============================================================================

/** Prefer readable terminal dump over raw JSON for run_command (coding loop). */
export function formatRunCommandObservation(output: unknown, cap = OBSERVATION_CAP_CMD): string {
  if (output == null) return '(no output)';
  if (typeof output === 'string') return formatToolObservation(output, cap);
  if (typeof output !== 'object') return formatToolObservation(output, cap);

  const o = output as Record<string, unknown>;
  if (typeof o.error === 'string' && o.success === false && o.command == null) {
    return `run_command error: ${o.error}`;
  }

  const cmd = typeof o.command === 'string' ? o.command : '?';
  const args = Array.isArray(o.args) ? o.args.map(String) : [];
  const cwd = typeof o.cwd === 'string' ? o.cwd : '.';
  const exitCode = typeof o.exitCode === 'number' ? o.exitCode : null;
  const durationMs = typeof o.durationMs === 'number' ? o.durationMs : null;
  const stdout = typeof o.stdout === 'string' ? o.stdout : '';
  const stderr = typeof o.stderr === 'string' ? o.stderr : '';
  const timedOut = o.timedOut === true;
  const truncated = o.truncated === true;

  const head = [
    `$ ${[cmd, ...args].join(' ')}`,
    `cwd=${cwd}`
      + (exitCode != null ? ` exit=${exitCode}` : '')
      + (durationMs != null ? ` ${durationMs}ms` : '')
      + (timedOut ? ' TIMED_OUT' : '')
      + (truncated ? ' TRUNCATED' : ''),
  ].join('\n');

  const parts = [head];
  if (stdout.trim()) parts.push('--- stdout ---\n' + stdout.trimEnd());
  if (stderr.trim()) parts.push('--- stderr ---\n' + stderr.trimEnd());
  if (!stdout.trim() && !stderr.trim() && typeof o.error === 'string') {
    parts.push(String(o.error));
  }

  return formatToolObservation(parts.join('\n\n'), cap);
}

export function formatToolObservation(output: unknown, cap = OBSERVATION_CAP): string {
  if (output == null) return '(no output)';
  if (typeof output === 'string') {
    if (output.length > cap) {
      return output.slice(0, cap) + `\n…[truncated, ${output.length} chars total]`;
    }
    return output;
  }
  const json = JSON.stringify(output);
  if (json.length > cap) {
    return json.slice(0, cap) + `\n…[truncated, ${json.length} chars total]`;
  }
  return json;
}

function observationForToolCall(
  name: string,
  output: unknown,
  input?: unknown,
  opts?: { createRuntime?: boolean },
): string {
  if (name === 'run_command') {
    let obs = formatRunCommandObservation(output);
    if (opts?.createRuntime && looksLikeServerStartCommand(input)) {
      obs = annotateCreateRunCommandObservation(obs);
    }
    return obs;
  }
  const cap = isKbAgentAction(name) ? OBSERVATION_CAP_KB : OBSERVATION_CAP;
  return formatToolObservation(output, cap);
}

// ============================================================================
// EXECUTE phase — streamText with tools, fallback to text-only
// ============================================================================
export type StepResult = {
  thought: string;
  action: string;
  input: unknown;
  observation: string;
  finished: boolean;
};

/**
 * Execute a single step of the ReAct loop.
 *
 * Two attempts:
 *   1. With tools (native tool calling) — preferred path
 *   2. Without tools (text-only fallback) — if attempt 1 produced no output
 *
 * Some small models (gemma3:4b, phi3, tinyllama) have broken tool-calling
 * and skip directly to text-only mode (see `knownBadToolModels`).
 *
 * Returns a StepResult with `thought` (raw LLM text), `action` (tool name or
 * 'reason'), `input` (tool args), `observation` (tool output or LLM text),
 * and `finished` (true if LLM emitted "ГОТОВО:" / "DONE:" / etc.).
 */
export async function executeStep(
  task: AgentTask,
  stepData: { system: string; messages: ModelMessage[] },
  tools: ToolSet,
  taskId: string,
  stepNum: number,
  taskSignal: AbortSignal,
  opts?: { loopCount?: number; planComplexity?: 'low' | 'medium' | 'high' },
): Promise<StepResult> {
  try {
    return await executeStepInner(task, stepData, tools, taskId, stepNum, taskSignal, opts);
  } finally {
    setOllamaNumCtx(undefined);
    setOllamaKeepAlive(undefined);
  }
}

async function executeStepInner(
  task: AgentTask,
  stepData: { system: string; messages: ModelMessage[] },
  tools: ToolSet,
  taskId: string,
  stepNum: number,
  taskSignal: AbortSignal,
  opts?: { loopCount?: number; planComplexity?: 'low' | 'medium' | 'high' },
): Promise<StepResult> {
  const log = logger.context({ taskId: taskId.slice(0, 8), step: stepNum });
  const phaseModel = await resolveAgentPhaseModel({
    phase: 'execute',
    goal: task.goal,
    planComplexity: opts?.planComplexity,
    loopCount: opts?.loopCount ?? 0,
  });
  if (phaseModel.usedHeavy) {
    setOllamaKeepAlive('0');
    await applyOllamaNumCtxForRole('agent', 'heavy');
  } else {
    await applyOllamaNumCtxForRole('agent', 'day');
  }
  const model = phaseModel.model;
  const { system, messages } = stepData;

  let fullText = '';
  const toolCalls: Array<{ name: string; input: unknown; output: unknown; success: boolean }> = [];

  const modelName = phaseModel.modelName;
  const { resolveModelToolsSupport } = await import('@/lib/llm/tool-support');
  const tryWithTools = await resolveModelToolsSupport(modelName);
  const executionMaxTokens = await resolveAgentPhaseMaxTokens('execution');

  log.debug('agent', `executeStep — model=${modelName}, tryWithTools=${tryWithTools}`, {
    maxTokens: executionMaxTokens,
  });

  // ── Attempt 1: with tools (native tool calling) ──
  // streamError хранит последнюю ошибку из onError callback. Если result.text
  // throws AI_NoOutputGeneratedError — это бесполезное "No output generated".
  // Реальная причина (rate limit / 4xx от LLM) приходит в onError, и мы её
  // логируем отдельно, а также пробрасываем в warn для отладки.
  // Храним raw error (unknown) — извлекаем короткое сообщение через extractErrorSummary.
  let streamError: unknown = null;
  if (tryWithTools) {
    const result = streamText({
      model,
      system,
      messages,
      tools,
      stopWhen: isStepCount(3),
      temperature: EXECUTION_TEMPERATURE,
      maxOutputTokens: executionMaxTokens,
      abortSignal: AbortSignal.any([taskSignal, AbortSignal.timeout(LLM_TIMEOUT_MS)]),
      onError: (error) => {
        // Vercel AI SDK onError callback receives a non-Error object.
        // Сохраняем raw object для последующего извлечения statusCode/responseBody.
        streamError = error;
        const summary = extractErrorSummary(error);
        log.error('agent', `Step ${stepNum} streamText (with tools) onError`, { modelName, ...summary }, error instanceof Error ? error : undefined);
      },
      onStepFinish: ({ toolCalls: tcs, toolResults: trs }) => {
        if (tcs) {
          // H3 fix: index toolResults by toolCallId, not positionally.
          const resultsById = new Map<string, { output: unknown; error?: string }>();
          if (trs) {
            for (const tr of trs) {
              const trWithId = tr as { toolCallId?: string; output: unknown; error?: string };
              if (trWithId.toolCallId) {
                resultsById.set(trWithId.toolCallId, { output: trWithId.output, error: trWithId.error });
              }
            }
          }
          for (const tc of tcs) {
            const tcWithId = tc as { toolName: string; input: unknown; toolCallId?: string };
            const tr = tcWithId.toolCallId ? resultsById.get(tcWithId.toolCallId) : undefined;
            log.info('tools', `Tool call: ${tcWithId.toolName}`, {
              success: !tr?.error,
              inputPreview: JSON.stringify(tcWithId.input).slice(0, 150),
              outputPreview: tr?.output != null
                ? (typeof tr.output === 'string' ? tr.output : JSON.stringify(tr.output)).slice(0, 150)
                : 'null',
            });
            emitAgentEvent({
              type: 'tool_start', taskId, step: stepNum, tool: tcWithId.toolName, input: tcWithId.input, ts: Date.now(),
            });
            emitAgentEvent({
              type: 'tool_end', taskId, step: stepNum, tool: tcWithId.toolName, success: !tr?.error, output: tr?.output, ts: Date.now(),
            });
            toolCalls.push({ name: tcWithId.toolName, input: tcWithId.input, output: tr?.output, success: !tr?.error });
          }
        }
      },
    });

    try {
      // abortSignal в streamText: при таймауте streamText получает abort,
      // LLM-вызов завершается cleanly (без утечки таймера и без зависшего fetch).
      const startMs = Date.now();
      fullText = await result.text;
      log.debug('agent', `Step ${stepNum} streamText (with tools) done (${Date.now() - startMs}ms)`, {
        textLength: fullText.length,
        toolCallsCount: toolCalls.length,
      });
    } catch (e) {
      // Если есть streamError из onError — это реальная причина (rate limit, 4xx).
      // `e` обычно AI_NoOutputGeneratedError с бесполезным "No output generated".
      const realError = streamError ?? e;
      const msg = realError instanceof Error ? realError.message : String(realError);
      log.warn('agent', `Step ${stepNum} streamText (with tools) failed — retrying without tools`, {
        error: msg,
        errorName: realError instanceof Error ? realError.name : 'Unknown',
        throwMessage: e instanceof Error ? e.message : String(e),
      }, realError instanceof Error ? realError : undefined);
      fullText = '';
    }
  }

  // ── Attempt 2: without tools (text-only fallback) ──
  if (!fullText && toolCalls.length === 0) {
    log.info('agent', `Step ${stepNum} fallback to text-only mode`);
    let fallbackStreamError: unknown = null;
    const result = streamText({
      model,
      system: system + '\n\nВАЖНО: У тебя нет прямого доступа к инструментам. Вместо вызова инструмента, опиши в тексте какое действие нужно выполнить и почему.',
      messages,
      temperature: EXECUTION_TEMPERATURE,
      maxOutputTokens: executionMaxTokens,
      abortSignal: AbortSignal.any([taskSignal, AbortSignal.timeout(LLM_TIMEOUT_MS)]),
      onError: (error) => {
        fallbackStreamError = error;
        const summary = extractErrorSummary(error);
        log.error('agent', `Step ${stepNum} streamText (fallback) onError`, { modelName, ...summary }, error instanceof Error ? error : undefined);
      },
    });

    try {
      const startMs = Date.now();
      fullText = await result.text;
      log.debug('agent', `Step ${stepNum} fallback streamText done (${Date.now() - startMs}ms)`, {
        textLength: fullText.length,
      });
    } catch (e) {
      const realError = fallbackStreamError ?? e;
      const summary = extractErrorSummary(realError);
      const errMsg = summary.message
        ? (summary.statusCode ? `[${summary.statusCode}] ` : '') + summary.message
        : 'Unknown error';
      fullText = `Ошибка: ${errMsg.slice(0, 200)}`;
      log.error('agent', `Step ${stepNum} fallback streamText failed`, {
        errorName: summary.name,
        throwMessage: e instanceof Error ? e.message : String(e),
      }, realError instanceof Error ? realError : e instanceof Error ? e : undefined);
    }
  }

  // Determine action
  let action = 'reason';
  let input: unknown = {};
  let observation = '';
  const createRuntime = isCodeCreationGoal(task.goal) || goalRequiresRuntimeVerify(task.goal);
  const obsOpts = { createRuntime };

  if (toolCalls.length > 0) {
    if (toolCalls.length === 1) {
      const last = toolCalls[0];
      action = last.name;
      input = last.input;
      observation = observationForToolCall(last.name, last.output, last.input, obsOpts);
    } else {
      action = toolCalls.map(t => t.name).join(' + ');
      input = toolCalls.map(t => ({ tool: t.name, input: t.input }));
      const anyCmd = toolCalls.some(t => t.name === 'run_command');
      const anyKb = toolCalls.some(t => isKbAgentAction(t.name));
      const cap = anyCmd ? OBSERVATION_CAP_CMD : anyKb ? OBSERVATION_CAP_KB : OBSERVATION_CAP;
      observation = toolCalls
        .map(t => `[${t.name}]\n${observationForToolCall(t.name, t.output, t.input, obsOpts)}`)
        .join('\n\n')
        .slice(0, cap);
    }
  } else {
    observation = fullText.slice(0, OBSERVATION_CAP);
  }

  // Check for completion — ONLY on explicit line-start "ГОТОВО:" / "DONE:".
  // Previously: any text without tool call ended the task prematurely.
  // Mid-thought "готово" / English "finished:" must NOT end the loop.
  // Also ignore ГОТОВО if the last tool observation is an error / empty tree.
  const finished = hasAgentCompletionSignal(fullText, observation);

  return {
    thought: fullText.slice(0, 500),
    action,
    input,
    observation,
    finished,
  };
}

// ============================================================================
// SYNTHESIZE phase — final answer from all gathered info
// ============================================================================
export async function synthesize(
  task: AgentTask,
  plan: { goal: string; steps: string[] },
  steps: Array<{ thought: string; action: string; observation: string }>,
  dialogueHistory: Array<{ role: string; content: string }> = [],
  taskSignal: AbortSignal,
): Promise<string> {
  try {
    return await synthesizeInner(task, plan, steps, dialogueHistory, taskSignal);
  } finally {
    setOllamaNumCtx(undefined);
  }
}

async function synthesizeInner(
  task: AgentTask,
  plan: { goal: string; steps: string[] },
  steps: Array<{ thought: string; action: string; observation: string }>,
  dialogueHistory: Array<{ role: string; content: string }> = [],
  taskSignal: AbortSignal,
): Promise<string> {
  // Lia face: day/chat when heavy is in the pool; else agent (pre-M3 behavior).
  const phaseModel = await resolveAgentPhaseModel({
    phase: 'synthesize',
    goal: task.goal,
  });
  await applyOllamaNumCtxForRole('chat', 'day');
  const model = phaseModel.model;
  // Grounded KB JSON only for pure lookup — not when exploration happened to touch KB.
  const useGroundedKb = isKbLookupGoal(task.goal);

  const stepsBlock = useGroundedKb
    ? packKbEvidenceForSynthesis(task.goal, steps)
    : steps.length > 0
      ? steps.map((s, i) =>
          `### Шаг ${i + 1}: ${s.action}\n**Мысль:** ${s.thought}\n**Результат:** ${truncateObservationForSynthesis(s.action, s.observation)}`
        ).join('\n\n')
      : 'Исследование не дало результатов.';

  const dialogueBlock = dialogueHistory.length > 0
    ? dialogueHistory.map(m =>
        `${m.role === 'user' ? 'Пользователь' : 'Лия'}: ${m.content}`
      ).join('\n')
    : '(контекст диалога отсутствует)';

  let synthKind: SynthesizeSystemKind = 'default';
  if (useGroundedKb) synthKind = 'grounded_kb';
  else if (isCodeCreationGoal(task.goal) && !stepsHaveCreationArtifacts(steps)) {
    synthKind = 'create_no_artifacts';
  } else if (
    isCodeCreationGoal(task.goal)
    && goalRequiresRuntimeVerify(task.goal)
    && !stepsHaveRuntimeVerify(steps)
  ) {
    synthKind = 'create_no_runtime';
  }
  const systemPrompt = buildSynthesizeSystemPrompt(synthKind);

  const userPrompt = useGroundedKb
    ? `Задача: "${displayAgentGoal(task.goal)}"

EVIDENCE:
${stepsBlock}`
    : `Задача: "${displayAgentGoal(task.goal)}"

План: ${displayAgentGoal(plan.goal) || displayAgentGoal(task.goal)}

Контекст диалога (что обсуждалось раньше):
${dialogueBlock}

Результаты исследования:
${stepsBlock}`;

  try {
    const synthesisMaxTokens = await resolveAgentPhaseMaxTokens('synthesis');
    logger.debug('agent', `Synthesize: calling LLM (${synthesisMaxTokens} tokens max)`, {
      stepsCount: steps.length,
      dialogueLength: dialogueHistory.length,
      groundedKb: useGroundedKb,
    });
    const result = await streamText({
      model,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
      temperature: useGroundedKb ? 0.2 : SYNTHESIS_TEMPERATURE,
      maxOutputTokens: synthesisMaxTokens,
      abortSignal: AbortSignal.any([taskSignal, AbortSignal.timeout(SYNTHESIS_TIMEOUT_MS)]),
      onError: (error) => {
        logger.error('agent', 'Synthesize streamText onError', { taskGoal: task.goal.slice(0, 80) }, error);
      },
    });

    const text = (await result.text).trim();
    logger.debug('agent', `Synthesize LLM responded (${text.length} chars)`, { groundedKb: useGroundedKb });

    if (useGroundedKb) {
      const grounded = parseGroundedKbJson(text);
      if (grounded) {
        const verified = await applyGroundednessFilter(grounded, steps, {
          model,
          signal: taskSignal,
          goal: task.goal,
        });
        if (verified.droppedCount > 0 || verified.usedLlm) {
          logger.info('agent', 'KB groundedness filter applied', {
            dropped: verified.droppedCount,
            uncertainResolved: verified.uncertainResolved,
            usedLlm: verified.usedLlm,
            factsKept: verified.answer.facts.length,
          });
        }
        return formatGroundedKbAnswer(verified.answer);
      }
      logger.warn('agent', 'Grounded KB JSON parse failed — returning raw synthesis', {
        preview: text.slice(0, 120),
      });
    }
    return text;
  } catch (e) {
    logger.error('agent', 'Synthesize failed', { taskGoal: task.goal.slice(0, 80) }, e);
    return `Не удалось сформулировать итоговый ответ: ${e instanceof Error ? e.message : String(e)}`;
  }
}
