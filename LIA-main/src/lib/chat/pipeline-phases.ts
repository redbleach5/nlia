import 'server-only';

// ============================================================================
// Chat pipeline phases — extracted from pipeline.ts (2026-07-08).
// ============================================================================
//
// Standalone step functions with explicit inputs/outputs. pipeline.ts
// orchestrates them in order; behavior is unchanged from the god function.

import { NextResponse } from 'next/server';
import { checkLlmPreflight, getOllamaSettings } from '@/lib/ollama';
import { buildSystemPromptFootprint } from '@/lib/system-prompt';
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { saveMessage, autoTitleEpisode, getMessages, formatEpisodeSummaryForPrompt } from '@/lib/memory/episodes';
import { formatGlobalFactsForPrompt, formatEpisodeFactsForPrompt } from '@/lib/memory/facts';
import { formatVectorHitsForPrompt } from '@/lib/memory/vector';
import { formatOpenTasksForPrompt } from '@/lib/agent/task';
import {
  perceive,
  createInitialEmotion,
  decayEmotion,
  dominantEmotion,
  parseEmotionJson,
  resolveDecayBaseline,
} from '@/lib/emotion';
import type { EmotionVector } from '@/lib/personality';
import type { LiaDecision } from '@/lib/identity/decision';
import type { LiaIntent } from '@/lib/identity/inner-monologue';
import { isKbQuestion, needsProactiveWebSearch, type TaskComplexity } from '@/lib/task-complexity';
import type { CognitiveMode } from '@/lib/cognitive-depth';
import type { ExecutionPlan } from '@/lib/cognitive-depth';
import type { Tier } from '@/lib/capability-profile';
import { poolOptsFromProfile } from '@/lib/chat/inference-ctx';
import {
  buildChatContext,
  runProactiveWebSearch,
  runProactiveKbSearch,
  type ChatContext,
} from './pipeline-helpers';
import {
  computeDialogueBudget,
  applyDialogueBudget,
  isDialogueBudgetPressured,
  MAX_MESSAGES_TO_CONSIDER,
  type BudgetMessage,
} from './context-budget';
import type { ModelMessage } from 'ai';
import type { ChatAttachmentMeta, ResolvedChatAttachment } from '@/lib/chat/attachments';
import { linkAttachmentsToMessage } from '@/lib/chat/attachments';
import {
  detectTrivialMessageFlags,
  resolveAcquaintanceContext,
  type TrivialMessageFlags,
} from '@/lib/chat/message-heuristics';
import { deriveDialogueTurnContractFromFlags } from '@/lib/chat/dialogue-turn-contract';
import { resolveSpeakerForTurn } from '@/lib/memory/person-binding';

/** Companion emotionJson window for decay baseline (not full dialogue history). */
const EMOTION_HISTORY_WINDOW = 12;

export type { TrivialMessageFlags } from '@/lib/chat/message-heuristics';
export { detectTrivialMessageFlags } from '@/lib/chat/message-heuristics';

export type RunnerLogger = ReturnType<typeof logger.context>;

export async function runChatPreflight(
  log: RunnerLogger,
): Promise<NextResponse | { ok: true }> {
  const settings = await getOllamaSettings();
  const preflight = await checkLlmPreflight();

  if (!preflight.ok) {
    const { failure } = preflight;
    log.warn('llm', 'Pre-flight failed', { code: failure.code });
    if (failure.code === 'ollama_down') {
      return NextResponse.json({
        error: failure.message + ' Если идёт индексация базы знаний — подождите 1–2 минуты и повторите.',
        details: failure.details ?? 'unknown error',
        ollamaUrl: failure.ollamaUrl ?? settings.baseUrl,
      }, { status: 503 });
    }
    return NextResponse.json({ error: failure.message }, { status: 503 });
  }

  return { ok: true };
}

export type PerceiveEmotionResult = {
  episode: NonNullable<Awaited<ReturnType<typeof db.episode.findUnique>>>;
  recentMessages: Awaited<ReturnType<typeof getMessages>>;
  perceivedEmotion: EmotionVector;
  triggers: string[];
  /** DB message count before the current user turn is saved. */
  storedMessageCount: number;
};

export async function perceiveEpisodeEmotion(params: {
  episodeId: string;
  text: string;
  log: RunnerLogger;
}): Promise<NextResponse | PerceiveEmotionResult> {
  const { episodeId, text, log } = params;
  // Fetch enough history for dialogue budget (not just a fixed 10).
  // Emotion decay still uses only the last EMOTION_HISTORY_WINDOW companions.
  const recentMessages = await getMessages(episodeId, MAX_MESSAGES_TO_CONSIDER);
  const emotionSlice = recentMessages.slice(-EMOTION_HISTORY_WINDOW);
  const recentEmotions: EmotionVector[] = [];
  for (const m of emotionSlice) {
    if (m.role !== 'companion' || !m.emotionJson) continue;
    const parsed = parseEmotionJson(m.emotionJson);
    if (parsed) recentEmotions.push(parsed);
  }
  const lastCompanionEmotion = recentEmotions.length > 0
    ? recentEmotions[recentEmotions.length - 1]
    : null;
  let currentEmotion: EmotionVector = lastCompanionEmotion ?? createInitialEmotion();
  const episode = await db.episode.findUnique({
    where: { id: episodeId },
    include: { _count: { select: { messages: true } } },
  });
  if (!episode) {
    return NextResponse.json({ error: 'episode not found' }, { status: 404 });
  }
  const { _count, ...episodeRow } = episode;
  const storedMessageCount = _count.messages;
  const dtMin = Math.min(60, Math.max(0, (Date.now() - episodeRow.updatedAt.getTime()) / 60000));
  // Decay toward experience-softened resting point, not only static personality.
  currentEmotion = decayEmotion(currentEmotion, dtMin, resolveDecayBaseline(recentEmotions));
  const { emotion: perceivedEmotion, triggers } = perceive(text, currentEmotion);
  log.debug('chat', 'Emotion perceived', {
    dominant: dominantEmotion(perceivedEmotion),
    triggers: triggers.length > 0 ? triggers.join(',') : 'none',
    historyLoaded: recentMessages.length,
    historyCap: MAX_MESSAGES_TO_CONSIDER,
    storedMessageCount,
  });
  return {
    episode: episodeRow,
    recentMessages,
    perceivedEmotion,
    triggers,
    storedMessageCount,
  };
}

export type LiaDecisionResult = {
  liaDecision: LiaDecision;
  liaIntent: LiaIntent;
  shouldSkipMonologue: boolean;
};

export async function resolveLiaDecision(params: {
  text: string;
  tier: Tier;
  userMode: CognitiveMode;
  perceivedEmotion: EmotionVector;
  recentMessages: Awaited<ReturnType<typeof getMessages>>;
  trivialFlags: TrivialMessageFlags;
  /** From perceive() — affective cues for standard-tier monologue routing */
  emotionTriggers?: readonly string[];
  /** When true, skip LLM monologue (e.g. deliberate pre-call will run instead). */
  forceSkipMonologue?: boolean;
  log: RunnerLogger;
}): Promise<LiaDecisionResult> {
  const {
    text, tier, userMode, perceivedEmotion, recentMessages, trivialFlags, log,
    emotionTriggers = [],
    forceSkipMonologue = false,
  } = params;
  const { isTrivialGreeting, isTrivialHowAreYou } = trivialFlags;
  void forceSkipMonologue;
  void emotionTriggers;
  void recentMessages;

  const { classifyIntent } = await import('@/lib/identity/inner-monologue');
  const liaIntentEarly = classifyIntent(text);
  // Latency pass: never pay for monologue LLM — fallback decision only.
  const shouldSkipMonologue = true;

  const { createEmotionalStateSnapshot } = await import('@/lib/identity/emotional-state');
  const { createFallbackDecision } = await import('@/lib/identity/decision');
  const liaIntent: LiaIntent = (isTrivialGreeting || isTrivialHowAreYou) ? 'trivial' : liaIntentEarly;
  const emotionalState = createEmotionalStateSnapshot(perceivedEmotion);
  const liaDecision = createFallbackDecision({
    emotionalState: {
      dominantEmotion: emotionalState.dominantEmotion,
      intensityLabel: emotionalState.intensityLabel,
    },
    intent: liaIntent,
    isKbQuestion: isKbQuestion(text),
    isAgent: userMode === 'agent',
    userMessage: text,
  });
  log.debug('chat', 'Lia decision (fallback only — monologue off)', {
    action: liaDecision.action,
    tone: liaDecision.desiredTone,
    intent: liaIntent,
    tier,
  });

  return { liaDecision, liaIntent, shouldSkipMonologue };
}

export async function persistUserMessageAndSideEffects(params: {
  episodeId: string;
  text: string;
  perceivedEmotion: EmotionVector;
  liaDecision: LiaDecision;
  liaIntent: LiaIntent;
  shouldSkipMonologue: boolean;
  log: RunnerLogger;
  attachments?: ResolvedChatAttachment[];
  attachmentIds?: string[];
}): Promise<{ id: string }> {
  const {
    episodeId, text, perceivedEmotion, liaDecision, liaIntent, shouldSkipMonologue, log,
    attachments = [], attachmentIds = [],
  } = params;

  const attachmentMeta: ChatAttachmentMeta[] = attachments.map(a => ({
    id: a.id,
    name: a.name,
    mimeType: a.mimeType,
    kind: a.kind,
    sizeBytes: a.sizeBytes,
  }));

  const userMsg = await saveMessage(episodeId, {
    role: 'user',
    content: text,
    emotionJson: JSON.stringify(perceivedEmotion),
    attachmentsJson: attachmentMeta.length > 0 ? JSON.stringify(attachmentMeta) : null,
  });

  if (attachmentIds.length > 0) {
    await linkAttachmentsToMessage(userMsg.id, attachmentIds);
  }

  autoTitleEpisode(episodeId, text).catch((e) => {
    log.warn('chat', 'autoTitleEpisode failed (non-fatal)', { episodeId: episodeId.slice(0, 8) }, e);
  });

  (async () => {
    try {
      const { shouldSummarizeEpisode, summarizeEpisode } = await import('@/lib/memory/summarization');
      if (await shouldSummarizeEpisode(episodeId)) {
        log.info('chat', 'Triggering episode summarization (background)', { episodeId: episodeId.slice(0, 8) });
        summarizeEpisode(episodeId).catch((e) => {
          log.warn('chat', 'summarizeEpisode top-level failed (non-fatal)', { episodeId: episodeId.slice(0, 8) }, e);
        });
      }
    } catch (e) {
      log.warn('chat', 'Summarization check failed (non-fatal)', {}, e);
    }
  })();

  return userMsg;
}

export type ChatPromptBundle = {
  chatContext: ChatContext;
  systemPrompt: string;
  coreMessages: ModelMessage[];
  webSearchContext: string | undefined;
  kbAnswerLocked: boolean;
  /** Episode workspace KB pins for tools + proactive search. */
  pinnedSourceIds: string[];
};

export async function buildChatPromptBundle(params: {
  episodeId: string;
  text: string;
  userMode: CognitiveMode;
  tier: Tier;
  complexity: TaskComplexity;
  plan: ExecutionPlan;
  profile: Awaited<ReturnType<typeof import('@/lib/capability-profile').getCognitiveParams>>['profile'];
  episode: NonNullable<Awaited<ReturnType<typeof db.episode.findUnique>>>;
  recentMessages: Awaited<ReturnType<typeof getMessages>>;
  perceivedEmotion: EmotionVector;
  liaDecision: LiaDecision;
  trivialFlags: TrivialMessageFlags;
  /** Message count before current user turn (from perceive). */
  storedMessageCount: number;
  log: RunnerLogger;
  abortSignal?: AbortSignal;
  finalUserMessage: ModelMessage;
}): Promise<ChatPromptBundle> {
  const {
    episodeId, text, userMode, tier, complexity, plan, profile, episode,
    recentMessages, perceivedEmotion, liaDecision, trivialFlags, storedMessageCount,
    log, abortSignal,
    finalUserMessage,
  } = params;

  // Skip vector embed on light turns (trivial/simple/pure-social/acquaintance).
  // Embed swap alone can cost 2–5s before first token.
  const skipRecall = complexity === 'trivial'
    || complexity === 'simple'
    || trivialFlags.isTrivialGreeting
    || trivialFlags.isTrivialHowAreYou
    || trivialFlags.isAcquaintanceRequest;
  const chatContext = await buildChatContext({
    episodeId, text, skipRecall, perceivedEmotion,
  });
  const { globalFacts, episodeFacts, vectorHits, agentTasks } = chatContext;

  const { getEpisodeWorkspace, pinnedSourceIds: resolvePins, formatWorkspaceForPrompt } =
    await import('@/lib/agent/workspace-binding');
  const workspaceBinding = await getEpisodeWorkspace(episodeId);
  const pinnedSourceIds = resolvePins(workspaceBinding);
  const { escapeForPrompt } = await import('@/lib/infra/prompt-safety');
  const workspaceContextRaw = formatWorkspaceForPrompt(workspaceBinding);
  const workspaceContext = workspaceContextRaw
    ? escapeForPrompt(workspaceContextRaw, { label: 'workspace' })
    : undefined;
  const { getWorkspaceMemoryForPrompt } = await import('@/lib/agent/workspace-memory');
  const workspaceMemory = (await getWorkspaceMemoryForPrompt(workspaceBinding)) || undefined;

  // Pre-search independent of streamText tool schemas (tools off on light turns).
  const shouldPreSearch = needsProactiveWebSearch(text, complexity);
  const [webSearchContext, kbResult] = await Promise.all([
    runProactiveWebSearch({ text, shouldPreSearch, log, abortSignal }),
    runProactiveKbSearch({
      text,
      episodeId,
      tier,
      plan,
      complexity,
      recentMessages,
      isKbQuestion,
      log,
      abortSignal,
      pinnedSourceIds,
    }),
  ]);
  const { kbSearchContext, kbAnswerLocked } = kbResult;

  const { getModelName } = await import('@/lib/ollama');
  const { resolveModelToolsSupport } = await import('@/lib/llm/tool-support');
  const modelName = await getModelName();
  const modelSupportsTools = await resolveModelToolsSupport(modelName);
  // Align with decideChatTools: no tool playbooks / web_search hints when
  // tools won't actually be attached to streamText.
  const { decideChatTools } = await import('@/lib/chat/chat-tools');
  const toolsEnabledForPrompt = decideChatTools({
    planToolsEnabled: plan.toolsEnabled,
    toolsSupported: modelSupportsTools,
    kbAnswerLocked,
    webSearchContext,
    complexity,
  });

  const speaker = await resolveSpeakerForTurn({ episodeId, userText: text });
  const nonUserGlobal = globalFacts.filter((f) => !f.key.startsWith('user.'));
  const liaGlobalBlock = formatGlobalFactsForPrompt(nonUserGlobal);
  const userProfile = [speaker.userProfile, liaGlobalBlock]
    .filter((s) => s && s.trim().length > 0)
    .join('\n\n') || undefined;

  const { episodeUserTurnCount, episodeHasPriorGreeting: priorGreeting } =
    resolveAcquaintanceContext({
      recentMessages,
      storedMessageCountBeforeTurn: storedMessageCount,
    });

  const dialogueContract = deriveDialogueTurnContractFromFlags(trivialFlags, {
    userNameKnown: speaker.userNameKnown,
    episodeUserTurnCount,
    episodeHasPriorGreeting: priorGreeting,
    needIdentifySpeaker: speaker.needIdentifySpeaker,
    knownPeopleNames: speaker.knownPeopleNames,
  });

  const promptFootprint = buildSystemPromptFootprint({
    emotion: perceivedEmotion,
    userProfile,
    workspaceContext,
    workspaceMemory,
    episodeFacts: formatEpisodeFactsForPrompt(episodeFacts) || undefined,
    ragHits: formatVectorHitsForPrompt(vectorHits) || undefined,
    openTasks: formatOpenTasksForPrompt(agentTasks) || undefined,
    recentArtifacts: await (async () => {
      try {
        const { findRecentEpisodeFsScope } = await import('@/lib/agent/artifact-followup');
        const recent = await findRecentEpisodeFsScope(episodeId);
        if (!recent) return undefined;
        return [
          `Задача: ${recent.goal}`,
          `Папка: ${recent.fsScope}`,
          `Файлы: ${recent.files.join(', ')}`,
        ].join('\n');
      } catch {
        return undefined;
      }
    })(),
    mode: userMode,
    tier,
    complexity,
    emotionalAnchors: undefined,
    painfulAnchor: undefined,
    webSearchContext,
    kbSearchContext,
    episodeSummary: formatEpisodeSummaryForPrompt(episode.summary) || undefined,
    liaDecision,
    toolsEnabled: toolsEnabledForPrompt,
    isTrivialGreeting: trivialFlags.isTrivialGreeting,
    isTrivialHowAreYou: trivialFlags.isTrivialHowAreYou,
    isKbQuestion: isKbQuestion(text),
    userNameKnown: speaker.userNameKnown,
    isAcquaintanceRequest: trivialFlags.isAcquaintanceRequest,
    episodeUserTurnCount,
    episodeHasPriorGreeting: priorGreeting,
    dialogueContract,
  });
  const systemPrompt = promptFootprint.prompt;
  log.debug('chat', 'System prompt footprint', {
    profile: promptFootprint.profile,
    promptMode: promptFootprint.promptMode,
    chars: promptFootprint.chars,
    estTokens: promptFootprint.estTokens,
    hasToolPlaybook: promptFootprint.hasToolPlaybook,
    tier,
    complexity,
    toolsEnabled: toolsEnabledForPrompt,
    dialoguePhase: dialogueContract.phase,
    mayGreet: dialogueContract.mayGreet,
    turnKind: dialogueContract.turnKind,
    personId: speaker.personId?.slice(0, 8),
    needIdentifySpeaker: speaker.needIdentifySpeaker,
  });

  const allDialogueMessages: BudgetMessage[] = recentMessages
    .filter(m => m.role === 'user' || m.role === 'companion')
    .map(m => ({
      role: (m.role === 'companion' ? 'companion' : 'user') as 'user' | 'companion',
      content: m.content,
    }));

  const dialogueBudget = computeDialogueBudget(
    {
      contextWindow: profile?.contextWindow ?? 0,
      tier,
      systemPrompt,
      maxOutputTokens: plan.maxTokens,
      toolsEnabled: plan.toolsEnabled,
      pool: poolOptsFromProfile(profile),
    },
    allDialogueMessages,
  );
  const dialogueHistory = applyDialogueBudget(allDialogueMessages, dialogueBudget);
  log.debug('chat', 'Dialogue history budget', {
    contextWindow: dialogueBudget.effectiveContextWindow,
    budget: dialogueBudget.budgetTokens,
    kept: dialogueBudget.messageCount,
    total: allDialogueMessages.length,
    loaded: recentMessages.length,
    historyCap: MAX_MESSAGES_TO_CONSIDER,
    episodeStoredBeforeTurn: storedMessageCount,
    estTokens: dialogueBudget.estimatedTokens,
    stopReason: dialogueBudget.stopReason,
  });

  // When budget drops older turns, refresh episode summary more aggressively
  // than the default every-20 cadence (heavy context fill pressure).
  if (isDialogueBudgetPressured(dialogueBudget, allDialogueMessages.length)) {
    (async () => {
      try {
        const { shouldSummarizeEpisode, summarizeEpisode } = await import('@/lib/memory/summarization');
        if (await shouldSummarizeEpisode(episodeId, { budgetPressured: true })) {
          log.info('chat', 'Triggering episode summarization (budget pressure)', {
            episodeId: episodeId.slice(0, 8),
            kept: dialogueBudget.messageCount,
            total: allDialogueMessages.length,
            stopReason: dialogueBudget.stopReason,
          });
          await summarizeEpisode(episodeId);
        }
      } catch (e) {
        log.warn('chat', 'Budget-pressure summarization failed (non-fatal)', {}, e);
      }
    })();
  }

  const coreMessages: ModelMessage[] = [
    ...dialogueHistory.map(m => ({
      role: (m.role === 'companion' ? 'assistant' : 'user') as 'user' | 'assistant',
      content: m.content,
    })),
    finalUserMessage,
  ];

  return {
    chatContext,
    systemPrompt,
    coreMessages,
    webSearchContext,
    kbAnswerLocked,
    pinnedSourceIds,
  };
}
