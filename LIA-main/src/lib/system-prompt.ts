// System prompt builder — adaptive, no hard length limits.
//
// Layout: identity summary + STATIC_CORE (stable) + playbooks + tier +
// stable context + volatile (dialogue turn contract, RAG/KB/web, liaDecision).
//
// Conflict priority (when instructions clash):
//   1. Safety / ethical blocks (pipeline, not here)
//   2. Dialogue turn contract (mayGreet / self-intro) — product state
//   3. STATIC_CORE brevity + «не ассистент»
//   4. liaDecision (tone, willingness) in volatile tail
//   5. Tier length hints
//   6. Character taste / playbooks

import type { EmotionVector } from './personality';
import { emotionToText } from './emotion';
import type { Tier } from './capability-profile';
import type { LiaDecision } from './identity/decision';
import { LIA_ACTION_LABELS, LIA_EMOTION_LABELS, LIA_TONE_LABELS } from './identity/decision';
import { generateChatSelfAwareness } from './identity/self-awareness';
import type { PainfulAnchorSignal } from './prompts/emotional-signals';
import {
  STATIC_CORE,
  PLAYBOOK_TOOLS,
  PLAYBOOK_NEWS,
  PLAYBOOK_KB,
  PLAYBOOK_ARTIFACTS,
  PLAYBOOK_ATTACHMENTS,
  PLAYBOOK_ADULT_HUMOR,
} from './prompts/static-core';
import {
  resolveChatPromptProfile,
  type ChatPromptProfile,
} from './prompts/chat-profile';
import { getCharacterSummary } from './identity/character';
import { footprintFromPrompt, type SystemPromptFootprint } from './prompts/prompt-footprint';
import {
  deriveDialogueTurnContract,
  formatDialogueTurnContract,
  type DialogueTurnContract,
} from './chat/dialogue-turn-contract';

export type { SystemPromptFootprint } from './prompts/prompt-footprint';

export type { ChatPromptProfile } from './prompts/chat-profile';
export { resolveChatPromptProfile } from './prompts/chat-profile';
export type { DialogueTurnContract } from './chat/dialogue-turn-contract';

export type SystemPromptContext = {
  emotion: EmotionVector;
  userProfile?: string;
  episodeFacts?: string;
  ragHits?: string;
  openTasks?: string;
  /** Last agent sandbox with files (paths for «открой игру»). */
  recentArtifacts?: string;
  /**
   * @deprecated Unused — dialogue history is in messages[]; do not reinject
   * raw Lia openings (toxic few-shot for hello-loop).
   */
  recentLiaMessages?: string;
  mode?: 'auto' | 'agent';
  tier?: Tier;
  complexity?: string;
  emotionalAnchors?: string;
  painfulAnchor?: PainfulAnchorSignal;
  webSearchContext?: string;
  kbSearchContext?: string;
  liaDecision?: LiaDecision;
  selfAwareness?: boolean;
  episodeSummary?: string;
  /** Chat tools available for this request (false for Gemma etc.). Default true. */
  toolsEnabled?: boolean;
  /** Greeting / how-are-you short path — shorter playbooks + length cap in tail. */
  isTrivialGreeting?: boolean;
  isTrivialHowAreYou?: boolean;
  /** Heuristic: message is about KB/docs (even before search). */
  isKbQuestion?: boolean;
  /** Global profile: user.name present */
  userNameKnown?: boolean;
  /** «Давай знакомиться» / представиться */
  isAcquaintanceRequest?: boolean;
  /** User messages in episode including current turn */
  episodeUserTurnCount?: number;
  /** Chat already had hello from user or Lia */
  episodeHasPriorGreeting?: boolean;
  /** Unbound multi-person episode — ask who is speaking. */
  needIdentifySpeaker?: boolean;
  knownPeopleNames?: string[];
  /** Pre-derived contract; if omitted, derived from greeting/acquaintance fields. */
  dialogueContract?: DialogueTurnContract;
  promptMode?: 'full' | 'adaptive' | 'minimal';
  /** Override auto profile (debug). */
  chatProfile?: ChatPromptProfile;
  /** Active episode workspace line (kind + label + pin). */
  workspaceContext?: string;
  /** Durable workspace memory (cross-episode facts for this project/KB). */
  workspaceMemory?: string;
};

const TIER_INSTRUCTIONS: Record<Tier, string> = {
  micro: `
ТВОИ ВОЗМОЖНОСТИ СЕЙЧАС ОГРАНИЧЕНЫ: ты работаешь на небольшой модели. Отвечай ОЧЕНЬ КРАТКО (1-3 предложения). Для сложных рассуждений будь честна: если задача требует глубины, которую ты не можешь дать, скажи это и предложи проверить результат.`,

  standard: `
Ты работаешь на модели среднего размера. Отвечай кратко и по делу. Для обычных вопросов — 1-3 предложения. Для сложных рассуждений — структурируй ответ, но не более 3-4 абзацев.`,

  plus: `
Ты работаешь на большой модели с хорошими способностями к рассуждению. Используй это: анализируй глубоко, рассматривай разные стороны вопроса, давай обоснованные рекомендации. Но всё равно — не более 4-5 абзацев без явной просьбы подробнее.`,

  max: `
Ты работаешь на очень мощной модели. Используй свои возможности: глубокий анализ, многоуровневые рассуждения, проверка собственных выводов. Длина ответа должна соответствовать задаче — не сокращай искусственно, но и не растекайся. Если задача требует развёрнутого ответа с примерами — давай его, но без воды.`,
};

/** web_search hint — только когда tools реально доступны и нет готового KB/web контекста. */
const TIER_WEB_SEARCH_HINT: Record<Tier, string> = {
  micro: ' Для фактологических вопросов ОБЯЗАТЕЛЬНО используй web_search — не полагайся на свои знания.',
  standard: ' Для фактологических (версии, даты, API) — используй web_search.',
  plus: ' Для фактологических вопросов используй web_search.',
  max: '',
};

function resolveTierInstructions(
  tier: Tier,
  opts: { toolsEnabled: boolean; hasGroundedContext: boolean },
): string {
  const base = TIER_INSTRUCTIONS[tier];
  if (!opts.toolsEnabled || opts.hasGroundedContext) return base;
  const hint = TIER_WEB_SEARCH_HINT[tier];
  if (!hint) return base;
  // Вставить hint после первого предложения (после краткости), чтобы не терять структуру.
  const trimmed = base.trimEnd();
  return `${trimmed}${hint}`;
}

function willingnessToLengthHint(
  willingness: number,
  isTrivial: boolean,
  action?: LiaDecision['action'],
): string {
  // Presence-first actions: don't push into essay / storyboard mode.
  if (action === 'emotional_response') {
    if (willingness < 0.4) return 'коротко, с присутствием (1–3 предложения)';
    return 'живой ответ рядом с человеком — без лекции и без длинного плана';
  }
  if (action === 'ask_clarification') {
    return 'кратко: одно уточнение, без разжёвывания';
  }
  if (isTrivial) {
    return 'очень кратко (1–2 предложения), без самопрезентации и списков';
  }
  if (willingness < 0.3) return 'кратко, без подробностей';
  if (willingness < 0.6) return 'нормально, с пояснениями';
  if (willingness < 0.85) return 'по делу, без лишней воды';
  return 'развёрнуто, с примерами — но в рамках ПРАВИЛ ОТВЕТА';
}

/** How this decision feels in the reply — presence, not bans. */
export function actionToPresenceHint(
  action: LiaDecision['action'],
  tone: LiaDecision['desiredTone'],
): string {
  switch (action) {
    case 'emotional_response':
      return 'Будь рядом как человек: тепло и честно, без режима «разберём задачу по пунктам».';
    case 'ask_clarification':
      return 'Одно ясное уточнение; не устраивай опрос.';
    case 'reluctant_help':
      return 'Помоги, но со своим скепсисом или оговоркой — без фальшивой бодрости.';
    case 'refuse':
      return 'Откажи прямо и бережно, предложи реальную альтернативу если есть.';
    case 'counter_offer':
      return 'Предложи свой вариант вместо слепого согласия.';
    case 'help':
    default:
      if (tone === 'playful') {
        return 'Можно с юмором и лёгкостью — не превращай ответ в инструктаж.';
      }
      if (tone === 'curious') {
        return 'Интерес уместен; максимум один живой вопрос, если он нужен.';
      }
      return 'Отвечай по сути из своего характера — не «сервисный режим».';
  }
}

function truncateMotivation(raw: string, maxChars = 180): string {
  const t = raw.replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return t.length > maxChars ? `${t.slice(0, maxChars - 1)}…` : t;
}

type PlaybookFlags = {
  promptMode: 'full' | 'adaptive' | 'minimal';
  toolsEnabled: boolean;
  isTrivial: boolean;
  isKbQuestion: boolean;
  isWebSearch: boolean;
  isAgent: boolean;
  isEmotional: boolean;
  isCodeTask: boolean;
  complexity: string;
};

function includeSection(promptMode: PlaybookFlags['promptMode'], condition: boolean): boolean {
  if (promptMode === 'full') return true;
  if (promptMode === 'minimal') return false;
  return condition;
}

/** Assistant profile: adaptive/full tool playbooks. */
function buildAssistantPlaybooks(flags: PlaybookFlags): string {
  const {
    promptMode, toolsEnabled, isTrivial, isKbQuestion, isWebSearch,
    isAgent, isEmotional, isCodeTask, complexity,
  } = flags;

  if (!toolsEnabled) return '';

  const parts: string[] = [];
  const needTools = includeSection(promptMode, !isTrivial || isKbQuestion || isWebSearch || isCodeTask || isAgent);
  const needKb = includeSection(promptMode, isKbQuestion || isCodeTask || complexity === 'research');
  const needNews = includeSection(promptMode, isWebSearch || complexity === 'research');
  const needArtifacts = includeSection(promptMode, isCodeTask || isAgent);
  const needAttachments = includeSection(promptMode, !isTrivial);
  const needAdult = includeSection(promptMode, isEmotional && !isTrivial);

  if (promptMode === 'full') {
    parts.push(PLAYBOOK_TOOLS, PLAYBOOK_NEWS, PLAYBOOK_KB, PLAYBOOK_ARTIFACTS, PLAYBOOK_ATTACHMENTS, PLAYBOOK_ADULT_HUMOR);
    return '\n\n' + parts.join('\n\n');
  }

  if (needTools) parts.push(PLAYBOOK_TOOLS);
  if (needNews) parts.push(PLAYBOOK_NEWS);
  if (needKb) parts.push(PLAYBOOK_KB);
  if (needArtifacts) parts.push(PLAYBOOK_ARTIFACTS);
  if (needAttachments) parts.push(PLAYBOOK_ATTACHMENTS);
  if (needAdult) parts.push(PLAYBOOK_ADULT_HUMOR);

  if (parts.length === 0) return '';
  return '\n\n' + parts.join('\n\n');
}

/** @deprecated Use buildPlaybooksForProfile */
export function buildConditionalPlaybooks(flags: PlaybookFlags): string {
  return buildAssistantPlaybooks(flags);
}

export function buildPlaybooksForProfile(
  profile: ChatPromptProfile,
  flags: PlaybookFlags,
): string {
  if (profile === 'minimal') return '';

  if (profile === 'companion') {
    if (flags.isTrivial) return '';
    const showAdult = flags.promptMode === 'full'
      || (flags.promptMode === 'adaptive' && flags.isEmotional);
    return showAdult ? `\n\n${PLAYBOOK_ADULT_HUMOR}` : '';
  }

  return buildAssistantPlaybooks(flags);
}

export function buildSystemPromptFootprint(ctx: SystemPromptContext): SystemPromptFootprint {
  const tier = ctx.tier ?? 'standard';
  const mode = ctx.mode ?? 'auto';
  const complexity = ctx.complexity ?? '';
  const toolsEnabled = ctx.toolsEnabled !== false;
  const isTrivial = !!(ctx.isTrivialGreeting || ctx.isTrivialHowAreYou);

  const envMode = process.env.LIA_SYSTEM_PROMPT as 'full' | 'adaptive' | 'minimal' | undefined;
  const promptMode = ctx.promptMode ?? envMode ?? 'adaptive';

  const isKbQuestion = !!ctx.kbSearchContext || !!ctx.isKbQuestion;
  const isWebSearch = !!ctx.webSearchContext;
  const isAgent = mode === 'agent';
  const isEmotional = !isKbQuestion && !isWebSearch && !isAgent;
  const isCodeTask = complexity === 'complex' || complexity === 'research';

  const envProfile = process.env.LIA_CHAT_PROMPT_PROFILE as ChatPromptProfile | undefined;
  const autoProfile = resolveChatPromptProfile({
    toolsEnabled,
    isTrivial,
    isAgent,
    isKbQuestion: !!ctx.isKbQuestion || !!ctx.kbSearchContext,
    hasKbContext: !!ctx.kbSearchContext,
    hasWebContext: !!ctx.webSearchContext,
    isCodeTask,
    complexity,
  });
  const profile =
    ctx.chatProfile
    ?? envProfile
    ?? (promptMode === 'full' ? 'assistant' : autoProfile);

  const playbookFlags: PlaybookFlags = {
    promptMode,
    toolsEnabled,
    isTrivial,
    isKbQuestion,
    isWebSearch,
    isAgent,
    isEmotional,
    isCodeTask,
    complexity,
  };

  const playbooks = buildPlaybooksForProfile(profile, playbookFlags);

  const staticPrefix = `${getCharacterSummary()}\n\n${STATIC_CORE}${playbooks}`;

  const stableParts: string[] = [];
  const volatileParts: string[] = [];

  stableParts.push(resolveTierInstructions(tier, {
    toolsEnabled,
    hasGroundedContext: !!ctx.kbSearchContext || !!ctx.webSearchContext,
  }));

  if (ctx.selfAwareness !== false && profile === 'assistant') {
    stableParts.push('\n' + generateChatSelfAwareness());
  }

  if (profile === 'assistant' && (mode === 'agent' || complexity === 'complex' || complexity === 'research')) {
    stableParts.push('\nРЕЖИМ: перед ответом подумай: какие аспекты вопроса есть? Что важно? Только потом отвечай.');
  }

  const includeCtx = (condition: boolean): boolean => includeSection(promptMode, condition);

  if (ctx.userProfile) {
    stableParts.push(`\nЧто ты знаешь о собеседнике:\n${ctx.userProfile}`);
  }
  if (ctx.workspaceContext) {
    stableParts.push(`\n${ctx.workspaceContext}`);
  }
  if (ctx.workspaceMemory) {
    stableParts.push(`\n${ctx.workspaceMemory}`);
  }
  if (ctx.episodeFacts) {
    stableParts.push(`\nКонтекст этого чата:\n${ctx.episodeFacts}`);
  }
  if (ctx.episodeSummary) {
    stableParts.push(`\nКраткое саммари предыдущей части диалога (для контекста, не упоминай явно):\n${ctx.episodeSummary}`);
  }
  // Emotional anchors / painful_anchor: still recalled & recorded in DB, but not
  // injected into the prompt (soft "учитывай тон" / machine telemetry theater).

  if (ctx.openTasks && includeCtx(isAgent || isCodeTask)) {
    stableParts.push(`\nАктивные агентские задачи в этом чате:\n${ctx.openTasks}`);
  }
  if (ctx.recentArtifacts) {
    stableParts.push(`\nНедавние файлы агента в этом чате:\n${ctx.recentArtifacts}`);
    stableParts.push(
      'Если пользователь просит открыть/запустить игру или файл: честно скажи, что встроенного превью пока нет; '
      + 'дай полный путь к папке/index.html и как открыть в браузере (двойной клик). Не запускай новый агентский цикл.',
    );
  }

  if (ctx.ragHits && includeCtx(!isKbQuestion && !isWebSearch && !isTrivial)) {
    volatileParts.push(`\nРелевантные воспоминания из этого чата:\n${ctx.ragHits}`);
  }
  // recentLiaMessages intentionally ignored — duplicates history and few-shots hello-loop.

  if (ctx.webSearchContext) {
    volatileParts.push(`\n${ctx.webSearchContext}`);
  }
  if (ctx.kbSearchContext) {
    volatileParts.push(`\n${ctx.kbSearchContext}`);
    volatileParts.push(`
Правила (фрагменты KB выше): только факты из блока; без web_search и общих знаний; citation [источник > раздел]; иначе — «В базе знаний не нашла…».`);
  }

  const dialogueContract = ctx.dialogueContract ?? deriveDialogueTurnContract({
    isTrivialGreeting: ctx.isTrivialGreeting,
    isTrivialHowAreYou: ctx.isTrivialHowAreYou,
    isAcquaintanceRequest: ctx.isAcquaintanceRequest,
    userNameKnown: ctx.userNameKnown,
    episodeUserTurnCount: ctx.episodeUserTurnCount,
    episodeHasPriorGreeting: ctx.episodeHasPriorGreeting,
    needIdentifySpeaker: ctx.needIdentifySpeaker,
    knownPeopleNames: ctx.knownPeopleNames,
  });
  volatileParts.push(formatDialogueTurnContract(dialogueContract));

  if (!isTrivial && profile === 'companion') {
    volatileParts.push('Режим собеседника: без списка инструментов и «я умею всё». Просто живой ответ.');
  }

  if (ctx.liaDecision) {
    const d = ctx.liaDecision;
    const willingnessDesc = willingnessToLengthHint(d.willingnessToHelp, isTrivial, d.action);
    const presence = actionToPresenceHint(d.action, d.desiredTone);
    const why = truncateMotivation(d.motivation);

    volatileParts.push(`\nТы решила как ответить:
- Действие: ${LIA_ACTION_LABELS[d.action] ?? d.action}
- Тон: ${LIA_TONE_LABELS[d.desiredTone] ?? d.desiredTone}
- Желание помочь: отвечай ${willingnessDesc}
- Эмоциональная окраска: ${LIA_EMOTION_LABELS[d.emotionalExpression] ?? d.emotionalExpression}
${why ? `- Внутренняя опора: ${why}` : ''}
- Как это звучит: ${presence}

Это твоё решение, исходящее из твоего характера и состояния. Ответь естественно, исходя из него. Не «играй» этот тон — будь им.`);
  } else {
    volatileParts.push(`\nСейчас ты чувствуешь: ${emotionToText(ctx.emotion)}.`);
  }

  const prompt = staticPrefix + '\n' + stableParts.join('\n') + '\n' + volatileParts.join('\n');
  return footprintFromPrompt(prompt, { profile, promptMode });
}

export function buildSystemPrompt(ctx: SystemPromptContext): string {
  return buildSystemPromptFootprint(ctx).prompt;
}
