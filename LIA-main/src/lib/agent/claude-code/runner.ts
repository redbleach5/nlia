import 'server-only';

/**
 * Claude Code coding executor — replaces ReAct for project coding when enabled.
 */

import { getOllamaSettings, checkLlmPreflight } from '@/lib/ollama';
import { logger } from '@/lib/logger';
import { displayAgentGoal } from '../goal-display';
import {
  getAgentTask,
  updateAgentTask,
} from '../task';
import {
  emitAgentEvent,
  clearBuffer,
  isCancelled,
  clearCancellation,
  cancelWaiting,
  signalCancellation,
} from '../events';
import { capturePreApplyGitSnapshot } from '../git-history';
import { persistAgentResultToChat, emitTaskFailedToChat } from '../persist-to-chat';
import { buildMentionAndRulesContext } from '../mention-context';
import { getClaudeCodeSettings } from './settings';
import { detectClaudeBinary } from './detect';
import { buildClaudeCodeUserPrompt } from './prompt';
import { parseClaudeCodeStreamChunk } from './parse-stream';
import { spawnClaudeCode, killClaudeCodeProcess, getClaudeCodePid } from './spawn';
import { collectGitDiffsSinceHead, changeIdForPath } from './git-diff';
import { resolveAgentModelName } from '@/lib/llm/resolve-agent-model';

const globalCc = globalThis as unknown as {
  __liaCcPids?: Map<string, number>;
};
const ccPids = globalCc.__liaCcPids ?? new Map<string, number>();
globalCc.__liaCcPids = ccPids;

export function getStoredClaudeCodePid(taskId: string): number | undefined {
  return ccPids.get(taskId) ?? getClaudeCodePid(taskId) ?? undefined;
}

export function killStoredClaudeCode(taskId: string): void {
  killClaudeCodeProcess(taskId);
  const pid = ccPids.get(taskId);
  if (pid) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch { /* ignore */ }
    ccPids.delete(taskId);
  }
}

async function synthesizeLiaVoice(params: {
  goal: string;
  summary: string;
  changedPaths: string[];
  success: boolean;
}): Promise<string> {
  const paths = params.changedPaths.length
    ? params.changedPaths.map((p) => `• ${p}`).join('\n')
    : '• (файлы не изменились или репозиторий без git)';
  const body = params.summary.trim() || (params.success
    ? 'Задача выполнена через Claude Code.'
    : 'Claude Code завершился с ошибкой.');

  // Lightweight local summary — avoid full companion system prompt.
  try {
    const { getAgentModel } = await import('@/lib/ollama');
    const { streamText } = await import('ai');
    const model = await getAgentModel();
    const result = await streamText({
      model,
      system:
        'Ты — Лия. Кратко (женским родом, от первого лица) суммируй результат coding-сессии Claude Code для пользователя. Не выдумывай правки, которых нет в списке файлов. До 120 слов.',
      messages: [{
        role: 'user',
        content:
          `Задача: ${displayAgentGoal(params.goal)}\n\n`
          + `Статус: ${params.success ? 'ok' : 'error'}\n\n`
          + `Изменённые файлы:\n${paths}\n\n`
          + `Сводка инструмента:\n${body.slice(0, 4000)}`,
      }],
      temperature: 0.4,
      maxOutputTokens: 400,
      abortSignal: AbortSignal.timeout(60_000),
    });
    const text = (await result.text).trim();
    if (text) return text;
  } catch (e) {
    logger.warn('agent', 'CC Lia synthesize failed — using fallback', {}, e);
  }

  return params.success
    ? `Сделала правки через Claude Code.\n\n${body.slice(0, 1500)}\n\nФайлы:\n${paths}`
    : `Не удалось полностью выполнить задачу через Claude Code.\n\n${body.slice(0, 1500)}`;
}

/**
 * Run a coding task via Claude Code CLI (Ollama Anthropic API).
 * Caller must already have decided routing + hold activeRunners slot.
 */
export async function runClaudeCodeTask(
  taskId: string,
  opts: {
    abortSignal: AbortSignal;
    registerAbort: (kill: () => void) => void;
  },
): Promise<void> {
  const log = logger.context({ taskId: taskId.slice(0, 8), executor: 'claude_code' });
  const task = await getAgentTask(taskId);
  if (!task) {
    log.error('agent', 'CC task not found');
    return;
  }

  clearCancellation(taskId);
  opts.registerAbort(() => killStoredClaudeCode(taskId));

  const fail = async (error: string) => {
    log.error('agent', 'CC task failed', { error: error.slice(0, 200) });
    await updateAgentTask(taskId, {
      status: 'failed',
      completedAt: new Date(),
      error,
    });
    await emitTaskFailedToChat({ id: taskId, episodeId: task.episodeId }, error);
  };

  try {
    const ccSettings = await getClaudeCodeSettings();
    if (!ccSettings.enabled) {
      await fail('Claude Code выключен в настройках.');
      return;
    }

    const binary = await detectClaudeBinary();
    if (!binary.ok || !binary.path) {
      await fail(
        binary.error
        ?? 'Claude Code CLI не найден в PATH. Установи CLI и перезапусти сервер.',
      );
      return;
    }

    const preflight = await checkLlmPreflight();
    if (!preflight.ok) {
      await fail(preflight.failure.message);
      return;
    }

    if (!task.fsScope) {
      await fail('Нет рабочей директории проекта (fsScope) для Claude Code.');
      return;
    }

    const ollama = await getOllamaSettings();
    const { getOllamaApiKey } = await import('@/lib/ollama-api-key');
    const { resolveClaudeCodeEndpoint } = await import('./env');
    const ollamaApiKey = await getOllamaApiKey();
    const model = ccSettings.model.trim()
      || resolveAgentModelName(ollama.model, ollama.agentModel);
    const endpoint = resolveClaudeCodeEndpoint({
      ollamaBaseUrl: ollama.baseUrl,
      model,
      ollamaApiKey,
    });

    await updateAgentTask(taskId, {
      status: 'planning',
      startedAt: task.startedAt ?? new Date(),
    });
    emitAgentEvent({
      type: 'task_started',
      taskId,
      goal: displayAgentGoal(task.goal),
      executor: 'claude_code',
      ts: Date.now(),
    });
    emitAgentEvent({ type: 'task_planning', taskId, ts: Date.now() });

    // Lia pre-plan (operational JSON) — replaces cosmetic stub.
    const { fingerprintFromFsScope, mergeTargetFiles, buildCodingTaskBrief } =
      await import('../coding-intent');
    const { loadCodingBriefPromptBlock, saveCodingTaskBrief } = await import('../coding-brief');
    const { upsertWorkspaceMemoryFact, listWorkspaceMemory } = await import('../workspace-memory');
    const { generatePlan } = await import('../runner-helpers');

    const ccToolDescriptions = [
      'write_file / write_files — создать или перезаписать файлы',
      'edit_file — точечная правка',
      'read_file / list_tree / grep — исследование',
      'run_command — тесты/git (без force push / --hard)',
    ].join('\n');

    let plan = await generatePlan(task, ccToolDescriptions, opts.abortSignal);
    const briefBlock = await loadCodingBriefPromptBlock(task.fsScope);
    await updateAgentTask(taskId, { planJson: JSON.stringify(plan) });
    emitAgentEvent({
      type: 'task_plan_ready',
      taskId,
      plan: {
        goal: displayAgentGoal(plan.goal) || displayAgentGoal(task.goal),
        steps: plan.steps,
        complexity: plan.complexity,
        targetFiles: plan.targetFiles ?? [],
      },
      executor: 'claude_code',
      ts: Date.now(),
    });

    await capturePreApplyGitSnapshot(taskId, task.fsScope);

    const { block: workspaceContext } = await buildMentionAndRulesContext({
      goal: task.goal,
      fsScope: task.fsScope,
    });

    const planHint = [
      'Lia plan (follow unless better paths found):',
      ...plan.steps.slice(0, 12).map((s, i) => `${i + 1}. ${s}`),
      plan.targetFiles?.length
        ? `Likely files: ${plan.targetFiles.slice(0, 16).join(', ')}`
        : '',
    ].filter(Boolean).join('\n');

    // Best-effort resume of prior CC session in this workspace.
    let resumeSessionId: string | undefined;
    const fp = fingerprintFromFsScope(task.fsScope);
    if (fp) {
      try {
        const facts = await listWorkspaceMemory(fp);
        resumeSessionId = facts.find((f) => f.shortKey === 'coding.ccSessionId')?.value?.trim()
          || undefined;
      } catch { /* ignore */ }
    }

    const prompt = buildClaudeCodeUserPrompt({
      goal: task.goal,
      workspaceContext,
      fsScope: task.fsScope,
      brief: briefBlock || undefined,
      planHint,
    });

    await updateAgentTask(taskId, { status: 'executing', currentStep: 1 });

    let step = 1;
    let assistantBuf = '';
    let resultText = '';
    let resultOk = true;
    let stderrBuf = '';
    let ccSessionId: string | undefined;

    const emitTool = (tool: string, input: unknown) => {
      emitAgentEvent({
        type: 'tool_start',
        taskId,
        step,
        tool,
        input,
        ts: Date.now(),
      });
    };
    const endTool = (tool: string, success: boolean, output: unknown) => {
      emitAgentEvent({
        type: 'tool_end',
        taskId,
        step,
        tool,
        success,
        output,
        ts: Date.now(),
      });
      step += 1;
    };

    const handleChunk = (chunk: string) => {
      for (const ev of parseClaudeCodeStreamChunk(chunk)) {
        if (ev.kind === 'assistant_delta') {
          assistantBuf += ev.text;
          emitAgentEvent({
            type: 'assistant_delta',
            taskId,
            text: ev.text,
            ts: Date.now(),
          });
        } else if (ev.kind === 'tool_start') {
          emitTool(ev.tool, ev.input);
        } else if (ev.kind === 'tool_end') {
          endTool(ev.tool, ev.success, ev.output);
        } else if (ev.kind === 'result') {
          resultText = ev.text || resultText;
          resultOk = ev.success;
          if (ev.sessionId) ccSessionId = ev.sessionId;
        }
      }
    };

    if (isCancelled(taskId) || opts.abortSignal.aborted) {
      await updateAgentTask(taskId, { status: 'cancelled', completedAt: new Date() });
      emitAgentEvent({ type: 'task_cancelled', taskId, ts: Date.now() });
      return;
    }

    const spawnResult = await spawnClaudeCode(taskId, {
      cwd: task.fsScope,
      prompt,
      model,
      envInput: {
        ollamaBaseUrl: endpoint.baseUrl,
        ollamaAuthToken: endpoint.authToken,
      },
      signal: opts.abortSignal,
      onStdout: handleChunk,
      onStderr: (c) => {
        stderrBuf = (stderrBuf + c).slice(-8_000);
      },
      resumeSessionId,
    });

    const pid = spawnResult.pid;
    if (pid) ccPids.set(taskId, pid);

    if (isCancelled(taskId) || opts.abortSignal.aborted) {
      killStoredClaudeCode(taskId);
      await updateAgentTask(taskId, { status: 'cancelled', completedAt: new Date() });
      const { emitTaskCancelledToChat } = await import('../persist-to-chat');
      await emitTaskCancelledToChat({ id: taskId, episodeId: task.episodeId });
      return;
    }

    // After-result watchdog may SIGTERM a hung CLI — that is success if stream had result.
    if (spawnResult.terminatedAfterResult) {
      log.info('agent', 'CC CLI terminated after result (grace)', {
        exitCode: spawnResult.exitCode,
        signal: spawnResult.signal,
      });
    } else if (spawnResult.exitCode !== 0 && spawnResult.exitCode !== null) {
      resultOk = false;
      if (!resultText) {
        resultText = stderrBuf.trim() || `Claude Code exit code ${spawnResult.exitCode}`;
      }
    }
    if (!resultText) resultText = assistantBuf.slice(-6000);

    const diffs = await collectGitDiffsSinceHead(task.fsScope);
    for (const d of diffs) {
      emitAgentEvent({
        type: 'file_changed',
        taskId,
        step,
        changeId: changeIdForPath(taskId, d.path),
        path: d.path,
        tool: d.tool,
        diff: d.diff,
        canUndo: true,
        pending: false,
        ts: Date.now(),
      });
    }

    const mergedFiles = mergeTargetFiles(
      plan.targetFiles ?? [],
      diffs.map((d) => d.path),
    );
    plan = { ...plan, targetFiles: mergedFiles };
    await updateAgentTask(taskId, { planJson: JSON.stringify(plan) });

    if (fp && ccSessionId) {
      await upsertWorkspaceMemoryFact(fp, 'coding.ccSessionId', ccSessionId.slice(0, 120), 0.85)
        .catch(() => null);
    }

    const brief = buildCodingTaskBrief({
      goal: displayAgentGoal(task.goal),
      summary: resultText || (resultOk ? 'Claude Code ok' : 'Claude Code error'),
      files: mergedFiles,
    });
    await saveCodingTaskBrief(task.fsScope, brief);

    await updateAgentTask(taskId, { status: 'synthesizing' });
    emitAgentEvent({ type: 'task_synthesizing', taskId, ts: Date.now() });

    const voice = await synthesizeLiaVoice({
      goal: task.goal,
      summary: resultText,
      changedPaths: diffs.map((d) => d.path),
      success: resultOk,
    });

    if (!resultOk) {
      await updateAgentTask(taskId, {
        status: 'failed',
        completedAt: new Date(),
        error: resultText.slice(0, 2000),
        resultSummary: voice,
      });
      await emitTaskFailedToChat({ id: taskId, episodeId: task.episodeId }, voice);
      return;
    }

    const chatMessageId = await persistAgentResultToChat(task, voice);
    await updateAgentTask(taskId, {
      status: 'done',
      completedAt: new Date(),
      resultSummary: voice,
      currentStep: step,
    });
    emitAgentEvent({
      type: 'task_done',
      taskId,
      resultSummary: voice,
      ...(chatMessageId ? { chatMessageId } : {}),
      ts: Date.now(),
    });
    log.info('agent', 'CC task done', {
      files: diffs.length,
      exitCode: spawnResult.exitCode,
    });
  } catch (e) {
    if (isCancelled(taskId)) {
      killStoredClaudeCode(taskId);
      await updateAgentTask(taskId, { status: 'cancelled', completedAt: new Date() });
      const { emitTaskCancelledToChat } = await import('../persist-to-chat');
      await emitTaskCancelledToChat({ id: taskId, episodeId: task.episodeId });
      return;
    }
    const msg = e instanceof Error ? e.message : String(e);
    await fail(msg);
  } finally {
    cancelWaiting(taskId);
    clearBuffer(taskId);
    ccPids.delete(taskId);
  }
}

export { signalCancellation };
