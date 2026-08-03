/**
 * Agent intent gate — mode «Агент» is a capability preference, not a forced ReAct loop.
 *
 * Pure heuristics (no LLM). Safe for client + server.
 */

import { detectAcquaintanceRequest } from '@/lib/chat/message-heuristics';
import {
  classifyTaskComplexity,
  isAgentTask,
  isConversationalMessage,
} from '@/lib/task-complexity';

export type AgentRoute = 'chat' | 'agent' | 'ask';

/** Explicit work verbs / project-file intent (beyond isAgentTask regex). */
const WORK_INTENT_STEMS = [
  'почини', 'исправ', 'отрефактор', 'отредактир', 'перепиши',
  'добавь в', 'удали из', 'создай файл', 'напиши код',
  'в проекте', 'в файле', 'в репозитор', 'в папке',
  'debug', 'fix the', 'fix bug', 'refactor',
  'implement', 'write_file', 'edit_file',
  'проанализируй код', 'изучи проект', 'ревью',
];

/** Short vague asks — confirm before burning an agent budget. */
const ASK_PATTERNS = [
  /^(помоги|help|хелп)(?![\p{L}\p{N}])/iu,
  /^(что дальше|что делать|нужна помощь|подскажи)(?![\p{L}\p{N}])/iu,
  /^(сделай|давай|попробуй)(?![\p{L}\p{N}])\s*$/iu,
];

/** Create-from-scratch signals (mirrors isCodeCreationGoal, client-safe). */
function looksLikeCodeCreation(message: string): boolean {
  const g = message.toLowerCase();
  const artifact =
    /игр[уыа]|тетрис|tetris|сайт|лендинг|landing|приложен|app\b|скрипт|bot\b|бот\b|страниц|html|css|компонент|модул|api\b|сервис|cli\b|утилит/.test(g)
    || /\.(html?|css|tsx?|jsx?|py|rs|go|vue|svelte)\b/.test(g)
    || /файл\b|project\b|репозитор/.test(g);
  const createVerb =
    /напиш|создай|сделай|реализу|сгенер|набросай|implement|write\b|create\b|build\b|scaffold/.test(g);
  return createVerb && artifact;
}

export function hasAgentWorkIntent(message: string): boolean {
  const text = message.trim();
  if (!text) return false;
  if (isAgentTask(text)) return true;
  if (looksLikeCodeCreation(text)) return true;
  const lower = text.toLowerCase();
  if (WORK_INTENT_STEMS.some(stem => lower.includes(stem))) return true;
  // Path-like or extension mention with an action-ish verb nearby
  if (
    /[/\\][\w.-]+\.\w{1,8}\b/.test(text)
    && /(почин|исправ|открой|прочитай|измени|edit|fix|read|open)/i.test(text)
  ) {
    return true;
  }
  return false;
}

function isVagueAsk(message: string): boolean {
  const text = message.trim();
  // Identity / acquaintance is never an agent confirm — answer in chat.
  if (detectAcquaintanceRequest(text)) return false;
  if (ASK_PATTERNS.some(p => p.test(text))) return true;
  // Very short non-greeting without punctuation → ambiguous work crumb
  if (text.length <= 24 && !/[.?!]/.test(text) && !/\s{2,}/.test(text)) {
    const complexity = classifyTaskComplexity(text);
    if (complexity === 'simple' || complexity === 'trivial') {
      if (!isConversationalMessage(text, complexity)) return true;
    }
  }
  return false;
}

/**
 * Decide how to handle a message while UI mode is Agent.
 *
 * - chat — smalltalk / questions / trivial; answer via chat pipeline, keep Agent mode sticky
 * - agent — clear multi-step / code / file work
 * - ask — short ambiguous work crumbs («помоги»); confirm with user
 */
export function classifyAgentRoute(message: string): AgentRoute {
  const text = message.trim();
  if (!text) return 'chat';

  // «Кто ты?» / знакомиться — always dialogue, never Agent-or-Dialog nag.
  if (detectAcquaintanceRequest(text)) return 'chat';

  if (hasAgentWorkIntent(text)) return 'agent';

  if (isVagueAsk(text)) return 'ask';

  const complexity = classifyTaskComplexity(text);
  if (complexity === 'trivial' || isConversationalMessage(text, complexity)) {
    return 'chat';
  }

  // Short simple asks without work markers → chat (not confirm dialog).
  // Confirm («Агент или диалог?») only for explicit vague crumbs via isVagueAsk.
  if (text.length < 80 && complexity === 'simple' && !text.includes('\n')) {
    return 'chat';
  }

  // Explicit Agent mode + non-trivial content → trust the user
  return 'agent';
}
