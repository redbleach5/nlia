/**
 * Agent orchestrator — single streamText with tools.
 *
 * Per docs/ARCHITECTURE.md § 8.1.
 *
 * The entire agent loop is ONE streamText call. The model:
 *   - emits tool_calls for actions (list_tree, read_file, search_sources, etc.)
 *   - emits text for reasoning
 *   - calls finalize tool to end the task
 *   - calls ask_user tool to ask for clarification
 *
 * onStepFinish persists events to eventsJson for resume + UI streaming.
 * Loop detector + circuit breaker protect against infinite loops + errors.
 *
 * Capability-adapter: per-tier maxSteps + temperature + guidance.
 */

import { streamText, type ModelMessage } from "ai";
import { getAgentModel, getAgentModelName } from "../llm/ollama.js";
import { detectAgentTier, getAgentProfile, getCoderProfile } from "./capability-adapter.js";
import { getCharacterSummary } from "../identity/character.js";
import { STATIC_CORE, PLAYBOOK_CODING } from "../identity/static-core.js";
import { generateChatSelfAwareness } from "../identity/self-awareness.js";
import { list as listResources } from "../workspace/service.js";
import { buildActiveTools, type ToolContext } from "./tool-registry.js";
import "./tools/index.js"; // Register all tools
import { detectLoop } from "./loop-detector.js";
import {
  getTask,
  updateTaskStatus,
  appendEvent,
  appendDecisionId,
} from "./service.js";
import { createDecision } from "../memory/decisions.js";
import { cancelWaiting } from "./wait-input.js";
import { cancelUiConfirm } from "./ui-confirm.js";
import { buildMentionAndRulesContext } from "./mention-context.js";
import { logger } from "../util/logger.js";
import type { AgentEvent, AgentTask } from "@lia/shared";

const CIRCUIT_BREAKER_THRESHOLD = 3;

/**
 * Run an agent task — single streamText with tools.
 *
 * The caller (route handler) passes a callback to emit events to the SSE stream.
 * Events are also persisted to eventsJson for resume.
 */
export async function runAgentTask(
  taskId: string,
  callbacks: {
    onEvent: (event: AgentEvent) => void;
    onDone: (summary: string | null) => void;
    onError: (error: string) => void;
  },
  abortSignal?: AbortSignal,
): Promise<void> {
  const task = getTask(taskId);
  if (!task) {
    callbacks.onError("task not found");
    return;
  }

  if (task.status === "done" || task.status === "failed" || task.status === "cancelled") {
    callbacks.onError(`task already ${task.status}`);
    return;
  }

  // Update status to executing
  updateTaskStatus(taskId, "executing");
  const startedAt = Date.now();
  let consecutiveErrors = 0;

  // Build tool context
  const ctx: ToolContext = {
    episodeId: task.episodeId,
    taskId,
    fsScope: task.fsScope,
    emit: (event) => {
      appendEvent(taskId, event);
      callbacks.onEvent(event);
    },
  };

  // Load workspace resources
  const resources = listResources(task.episodeId);

  // Build active tools
  const tools = buildActiveTools(resources, {
    fsScope: task.fsScope,
    toolsWhitelist: task.toolsWhitelist,
  }, ctx);

  // Build messages — just the goal as user message
  const messages: ModelMessage[] = [
    { role: "user", content: task.goal },
  ];

  // Emit status event
  ctx.emit({ type: "status", label: "Запуск задачи агента…", ts: Date.now() });

  let fullText = "";
  let finalized = false;
  let finalizeSummary: string | null = null;
  let stepCount = 0;

  try {
    const model = await getAgentModel();
    const modelName = await getAgentModelName();
    const tier = detectAgentTier(modelName);
    const profile =
      task.templateName === "coder" ? getCoderProfile(tier) : getAgentProfile(tier);
    // Task-level maxSteps can raise the ceiling further (never below profile).
    const maxSteps = Math.max(profile.maxSteps, task.maxSteps || 0);

    // Build system prompt with tier-specific guidance + rules/@mentions
    const systemPrompt = await buildAgentSystemPrompt(task, resources, tier);

    const result = streamText({
      model,
      system: systemPrompt,
      messages,
      tools,
      temperature:
        task.templateName === "coder"
          ? profile.temperature
          : task.templateName === "researcher"
            ? 0.5
            : 0.7,
      abortSignal,
      onError: ({ error }) => {
        logger.error({ err: error, taskId }, "agent streamText error");
        consecutiveErrors++;
      },
      onStepFinish: async ({ toolCalls, text }) => {
        stepCount++;

        // Emit text delta
        if (text) {
          fullText += text;
          ctx.emit({ type: "text_delta", text, ts: Date.now() });
        }

        // Track max steps — volume coding needs higher ceiling than micro chat.
        if (maxSteps > 0 && stepCount >= maxSteps) {
          logger.warn({ taskId, tier, stepCount, max: maxSteps }, "per-tier max steps hit, halting");
          ctx.emit({ type: "error", message: `Превышен лимит шагов (${maxSteps}). Остановлено.`, ts: Date.now() });
          throw new Error(`agent_max_steps_exceeded:${maxSteps}`);
        }

        // Process tool calls
        if (toolCalls) {
          for (const call of toolCalls) {
            const toolName = call.toolName;
            // AI SDK v7: args may be on the call object directly or nested
            const input = (call as unknown as { args?: unknown; input?: unknown }).args ?? (call as unknown as { input?: unknown }).input ?? {};

            // Check for finalize (ask_user blocks inside its tool execute)
            if (toolName === "finalize") {
              const args = input as { summary: string };
              finalized = true;
              finalizeSummary = args.summary;
              ctx.emit({ type: "finalize", summary: args.summary, ts: Date.now() });

              // Write decision log
              const decision = createDecision({
                episodeId: task.episodeId,
                taskId,
                situation: `Task: ${task.goal.slice(0, 200)}`,
                options: ["finalize", "continue"],
                chosen: "finalize",
                rationale: args.summary,
                modelRole: "agent",
              });
              appendDecisionId(taskId, decision.id);
            }
          }
        }

        // Loop detector
        const events = getTask(taskId)?.events ?? [];
        const hint = detectLoop(events);
        if (hint) {
          ctx.emit({
            type: "status",
            label: `Подсказка: ${hint.message}`,
            ts: Date.now(),
          });
          // Write decision log for loop detection
          createDecision({
            episodeId: task.episodeId,
            taskId,
            situation: `Обнаружен цикл: ${hint.type}`,
            options: ["hint", "replan", "ask_user", "fail"],
            chosen: "hint",
            rationale: hint.message,
            modelRole: "agent",
          });
        }

        // Circuit breaker
        if (consecutiveErrors >= CIRCUIT_BREAKER_THRESHOLD) {
          throw new Error(`Circuit breaker: ${CIRCUIT_BREAKER_THRESHOLD} последовательных ошибок`);
        }
      },
    });

    // Consume the stream
    for await (const part of result.fullStream) {
      if (abortSignal?.aborted) break;

      switch (part.type) {
        case "error": {
          const err = part.error;
          const msg = err instanceof Error ? err.message : String(err);
          ctx.emit({ type: "error", message: msg, ts: Date.now() });
          consecutiveErrors++;
          break;
        }
        default:
          break;
      }
    }

    // Task complete (unless cancelled / still waiting mid-stream abort)
    const current = getTask(taskId);
    if (current?.status === "cancelled") {
      cancelWaiting(taskId);
      cancelUiConfirm(taskId);
      callbacks.onError("cancelled");
      return;
    }

    const durationMs = Date.now() - startedAt;
    if (finalized) {
      updateTaskStatus(taskId, "done", { resultSummary: finalizeSummary ?? fullText.slice(0, 500) });
    } else {
      // Model ended without calling finalize — use accumulated text as summary
      updateTaskStatus(taskId, "done", { resultSummary: fullText.slice(0, 500) || "Задача выполнена" });
    }
    ctx.emit({ type: "done", ts: Date.now(), durationMs });
    callbacks.onDone(finalizeSummary ?? fullText.slice(0, 500));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const current = getTask(taskId);
    if (current?.status === "cancelled" || msg === "cancelled") {
      cancelWaiting(taskId);
      cancelUiConfirm(taskId);
      callbacks.onError("cancelled");
      return;
    }
    logger.error({ err: e, taskId }, "agent task failed");
    updateTaskStatus(taskId, "failed", { error: msg });
    ctx.emit({ type: "error", message: msg, ts: Date.now() });
    callbacks.onError(msg);
  }
}

async function buildAgentSystemPrompt(
  task: AgentTask,
  resources: { kind: string; name: string; status: string }[],
  tier: import("./capability-adapter.js").AgentTier,
): Promise<string> {
  const sections: string[] = [
    STATIC_CORE,
    "",
    "=== КТО ТЫ ===",
    getCharacterSummary(),
    "",
    generateChatSelfAwareness(),
    "",
    "=== АГЕНТСКИЙ РЕЖИМ ===",
    "Ты в агентском режиме. У тебя есть инструменты для работы с файлами, базой знаний и веб-поиском.",
    "Ты сама решаешь последовательность действий через tool-use.",
    "",
    "ПРАВИЛА:",
    "— Вызови finalize когда задача выполнена, с кратким summary что сделала.",
    "— Вызови ask_user только если не можешь продолжить без уточнения — после этого дождись ответа пользователя.",
    "— Объёмная работа: make_plan → write_files пачками → run_verify → git_commit.",
    "— write_file — один файл; apply_patch — только мелкий фикс поверх уже сделанного.",
    "— Не дроби фичу на микро-патчи: лучше создать/переписать нужные файлы целиком в стиле проекта.",
    "— Запись на диск ждёт Apply; git/deploy/ssh ждут Confirm. run_verify — без Confirm.",
    "— Deploy только из .lia/deploy.json; SSH только на allowlist. Не выдумывай команды деплоя.",
    "— Если видишь упрощение — предложи 1–3 пункта, не делай большой рефакторинг без просьбы.",
    "— Учитывай Project rules и @file/@folder mentions из контекста ниже.",
    "— Не повторяй один и тот же tool с одинаковыми параметрами — это loop.",
    "— После каждого tool call — 1 предложение что сделала, не пересказывай весь вывод.",
    "— Если tool вернул ошибку — попробуй другой подход, не повторяй.",
  ];

  // Template overlay
  if (task.templateName === "coder") {
    sections.push("", PLAYBOOK_CODING);
  } else if (task.templateName === "researcher") {
    sections.push("", "=== ШАБЛОН: RESEARCHER ===", "Фокус на исследование. Используй web_search, search_sources, fetch_page. Температура 0.5.");
  }

  // Tier-specific guidance (coder uses higher step budget via getCoderProfile)
  if (task.templateName === "coder") {
    const coderProfile = getCoderProfile(tier);
    sections.push("", "=== БЮДЖЕТ ОБЪЁМА ===");
    sections.push(`— До ${coderProfile.maxSteps} шагов. Используй их на карту репо + план + пачки write_files, не на микро-правки.`);
    sections.push("— Цель: законченный результат (модуль/фича), который пользователь применит Apply all.");
  } else if (tier === "micro" || tier === "standard") {
    const profile = getAgentProfile(tier);
    sections.push("", "=== РЕЖИМ МАЛОЙ МОДЕЛИ ===");
    sections.push(`— Максимум ${profile.maxSteps} шагов. Если не получается — скажи прямо и заверши через finalize.`);
    sections.push("— Если задача большая — всё равно делай пачками write_files, не точечными патчами.");
  } else if (tier === "plus" || tier === "max") {
    sections.push("", "=== РАСШИРЕННЫЙ РЕЖИМ ===");
    sections.push("— Сложные задачи: сначала ясная спецификация / make_plan, потом объёмные шаги с проверкой.");
    sections.push("— При риске цикла — остановись и предложи другой путь (PreFlightAskUser).");
  }

  // Workspace info
  if (resources.length > 0) {
    sections.push("", "=== ДОСТУПНЫЕ РЕСУРСЫ ===");
    for (const r of resources) {
      sections.push(`— ${r.kind}: ${r.name} (${r.status})`);
    }
  }

  if (task.fsScope) {
    sections.push("", `=== ФАЙЛОВАЯ ОБЛАСТЬ ===`, `fsScope: ${task.fsScope}`);
  }

  const mentionCtx = await buildMentionAndRulesContext({
    goal: task.goal,
    fsScope: task.fsScope,
  });
  if (mentionCtx.block) {
    sections.push(mentionCtx.block);
  }

  // Decision log context
  sections.push("", "=== ЖУРНАЛ РЕШЕНИЙ ===");
  sections.push("Если ты в loop или ask_user — перечитай свои прошлые решения (через search_sources по decision log).");

  return sections.join("\n");
}
