import 'server-only';

import {
  resolveWorkspaceMode,
  applyModeWhitelist,
  type WorkspaceMode,
  type WorkspaceModeInput,
} from './workspace-modes';

/** Agent step action/observation shape (ReAct loop). */
export type AgentStepSlice = { action: string; observation: string };

const KB_TOOL_RE = /search_sources|read_folder_file|get_source/;

/**
 * Tool whitelist for pure «найти в базе знаний» lookup goals.
 * Applied in the control plane only for isKbLookupGoal (not mere KB mentions).
 */
export const KB_LOOKUP_TOOL_WHITELIST = [
  'search_sources',
  'get_source',
  'read_folder_file',
  'list_sources',
  'ask_user',
] as const;

export type KbLookupToolName = (typeof KB_LOOKUP_TOOL_WHITELIST)[number];

export function isKbAgentAction(action: string): boolean {
  return KB_TOOL_RE.test(action);
}

/** Mentions knowledge base / KB as a location or resource (not necessarily lookup-only). */
export function mentionsKnowledgeBase(goal: string): boolean {
  const g = goal.toLowerCase();
  return (
    /баз\S*\s*знан/.test(g)
    || /knowledge\s*base/.test(g)
    || /\bkb\b/.test(g)
  );
}

/**
 * Code / project exploration or audit — must NOT force KB-only tools.
 * Examples: «изучи проект», «найди проблемы и ошибки», «ревью кодовой базы».
 */
export function isCodeExplorationGoal(goal: string): boolean {
  const g = goal.toLowerCase();
  return (
    /изуч|исслед|анализ|разбер|ревью|review|audit|аудит/.test(g)
    || /проблем|ошибк|баг|bug|defect|уязвим/.test(g)
    || /кодов\S*\s*баз|codebase|исходник|репозитор|репо\b|проект/.test(g)
    || /что\s+не\s+так|основные\s+проблем/.test(g)
  );
}

/**
 * Create / implement from scratch — needs write_file, not research-only loop.
 * Examples: «напиши игру тетрис», «создай сайт», «сделай HTML-страницу».
 */
export function isCodeCreationGoal(goal: string): boolean {
  const g = goal.toLowerCase();
  // Pure exploration / audit of existing code is not creation.
  if (isCodeExplorationGoal(goal) && !/(напиш|создай|сделай|реализу|implement|write\b)/.test(g)) {
    return false;
  }
  const artifact =
    /игр[уыа]|тетрис|tetris|сайт|лендинг|landing|приложен|app\b|скрипт|bot\b|бот\b|страниц|html|css|компонент|модул|api\b|сервис|cli\b|утилит/.test(g)
    || /\.(html?|css|tsx?|jsx?|py|rs|go|vue|svelte)\b/.test(g)
    || /файл\b|project\b|репозитор/.test(g);
  const createVerb =
    /напиш|создай|сделай|реализу|сгенер|набросай|implement|write\b|create\b|build\b|scaffold/.test(g);
  return createVerb && artifact;
}

/** Successful write/edit/artifact tools in ReAct steps (create goals). */
export function stepsHaveCreationArtifacts(
  steps: Array<{ action: string; observation?: string }>,
): boolean {
  return steps.some(s => {
    const action = (s.action || '').toLowerCase();
    if (!/(write_file|edit_file|save_artifact)/.test(action)) return false;
    const obs = (s.observation || '').toLowerCase();
    // Failed tool calls still count as "tried" only if no hard error — require success-ish.
    if (/"error"\s*:/.test(s.observation || '') || /\berror\b.*failed|не удалось|permission denied/.test(obs)) {
      return false;
    }
    return true;
  });
}

/**
 * Pure KB lookup: find/describe a fact in the knowledge base.
 * Not every mention of «база знаний» — exploration / fix / implement stays open.
 */
export function isKbLookupGoal(goal: string): boolean {
  if (isCodeExplorationGoal(goal)) return false;

  const g = goal.toLowerCase();
  // Implementation / edit intent → not lookup-only
  if (/исправ|реализу|напиш|почин|добав|отредактир|refactor|implement|fix\b|write\b/.test(g)) {
    return false;
  }

  const hasKb = mentionsKnowledgeBase(goal)
    || (/найди|найти|опиши|описание|что\s+такое|расскажи|покажи/.test(g)
      && /(баз|документ|знан|kb|протокол)/.test(g));

  if (!hasKb) return false;

  // Require lookup-ish verb or «в базе знаний» as the place to search
  return (
    /найди|найти|опиши|описание|что\s+такое|расскажи|покажи|ищи|поищи|lookup|find\b/.test(g)
    || /в\s+(баз|knowledge|kb)/.test(g)
  );
}

/**
 * Mentions KB as context but needs code tools (e.g. «проект в базе знаний — найди ошибки»).
 * Does not force a whitelist — caller should leave tools open; used for prompts/hints.
 */
export function isKbAssistedGoal(goal: string): boolean {
  return mentionsKnowledgeBase(goal) && isCodeExplorationGoal(goal);
}

/**
 * Resolve effective toolsWhitelist.
 * Explicit caller whitelist always wins (legacy); prefer applyModeWhitelist via routes.
 * Pure KB-lookup goals force KB_LOOKUP_TOOL_WHITELIST.
 * Code exploration / kb-assisted: keep template whitelist or all tools (null).
 *
 * @deprecated Prefer resolveWorkspaceMode + applyModeWhitelist in agent/chat routes.
 */
export function resolveToolsWhitelistForGoal(
  goal: string,
  callerWhitelist: string[] | null | undefined,
  templateWhitelist: string[] | null | undefined = null,
): string[] | null {
  if (callerWhitelist && callerWhitelist.length > 0) {
    return callerWhitelist;
  }
  // Exploration / kb-assisted never get KB-only lock
  if (isCodeExplorationGoal(goal) || isKbAssistedGoal(goal)) {
    return templateWhitelist ?? null;
  }
  if (isKbLookupGoal(goal)) {
    return [...KB_LOOKUP_TOOL_WHITELIST];
  }
  return templateWhitelist ?? null;
}

/**
 * Mode-aware whitelist (Phase 4). Prefer this over resolveToolsWhitelistForGoal.
 */
export function resolveToolsWhitelistForMode(opts: {
  goal: string;
  workspaceModeInput?: WorkspaceModeInput;
  callerWhitelist?: string[] | null;
  templateWhitelist?: string[] | null;
}): { mode: WorkspaceMode; toolsWhitelist: string[] } {
  const mode = resolveWorkspaceMode(opts.goal, opts.workspaceModeInput ?? 'auto');
  return {
    mode,
    toolsWhitelist: applyModeWhitelist(mode, {
      callerWhitelist: opts.callerWhitelist,
      templateWhitelist: opts.templateWhitelist,
    }),
  };
}

/** Structured grounded answer from synthesize (KB path). */
export type GroundedKbFact = {
  text: string;
  citation: string | null;
};

export type GroundedKbAnswer = {
  summary: string;
  facts: GroundedKbFact[];
  missing: string | null;
};

export function parseGroundedKbJson(raw: string): GroundedKbAnswer | null {
  const trimmed = raw.trim()
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/[“”«»]/g, '"')
    .replace(/[‘’]/g, "'")
    .trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  let candidate = fence ? fence[1].trim() : trimmed;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  candidate = candidate.slice(start, end + 1);
  // Common qwen glitch: extra } after a fact object before the next one.
  candidate = candidate.replace(/("(?:text|citation)"\s*:\s*"(?:\\.|[^"\\])*")\s*\}\s*\}(\s*,\s*\{)/g, '$1}$2');

  const tryParse = (s: string): GroundedKbAnswer | null => {
    try {
      const parsed = JSON.parse(s) as Partial<GroundedKbAnswer>;
      if (typeof parsed.summary !== 'string') return null;
      const facts = Array.isArray(parsed.facts)
        ? parsed.facts
            .filter((f): f is GroundedKbFact => !!f && typeof f === 'object' && typeof (f as GroundedKbFact).text === 'string')
            .map((f) => ({
              text: f.text.trim(),
              citation: typeof f.citation === 'string' && f.citation.trim() ? f.citation.trim() : null,
            }))
            .filter((f) => f.text.length > 0)
        : [];
      return {
        summary: parsed.summary.trim(),
        facts,
        missing: typeof parsed.missing === 'string' && parsed.missing.trim()
          ? parsed.missing.trim()
          : null,
      };
    } catch {
      return null;
    }
  };

  const direct = tryParse(candidate);
  if (direct) return direct;

  // Fallback: salvage summary + fact texts even if JSON is broken.
  const summaryMatch = candidate.match(/"summary"\s*:\s*"((?:\\.|[^"\\])*)"/);
  const factTexts = [...candidate.matchAll(/"text"\s*:\s*"((?:\\.|[^"\\])*)"/g)]
    .map((m) => m[1].replace(/\\"/g, '"').replace(/\\n/g, '\n').trim())
    .filter(Boolean);
  const citations = [...candidate.matchAll(/"citation"\s*:\s*(null|"((?:\\.|[^"\\])*)")/g)]
    .map((m) => (m[1] === 'null' ? null : (m[2] ?? '').replace(/\\"/g, '"').trim() || null));
  if (!summaryMatch && factTexts.length === 0) return null;
  const summary = (summaryMatch?.[1] ?? '').replace(/\\"/g, '"').replace(/\\n/g, '\n').trim();
  const facts = factTexts.map((text, i) => ({
    text,
    citation: citations[i] ?? null,
  }));
  if (!summary && facts.length === 0) return null;
  return { summary: summary || facts[0]?.text || '', facts, missing: null };
}

/** Render grounded JSON into a short user-facing markdown answer. */
export function formatGroundedKbAnswer(answer: GroundedKbAnswer): string {
  const parts: string[] = [];
  if (answer.summary) parts.push(answer.summary);
  if (answer.facts.length > 0) {
    parts.push(
      answer.facts
        .map((f) => (f.citation ? `- ${f.text} [${f.citation}]` : `- ${f.text}`))
        .join('\n'),
    );
  }
  if (answer.missing) {
    parts.push(`Не найдено в базе знаний: ${answer.missing}`);
  }
  if (parts.length === 0) {
    return 'В базе знаний не нашла достаточно данных по запросу.';
  }
  return parts.join('\n\n');
}

const PROMPT_OBS_DEFAULT = 500;
const PROMPT_OBS_KB = 4500;
const SYNTHESIS_OBS_DEFAULT = 800;
/** Fallback head-cap if packKbEvidenceForSynthesis is not used. */
const SYNTHESIS_OBS_KB = 12_000;

export function truncateObservationForPrompt(action: string, observation: string): string {
  const cap = isKbAgentAction(action) ? PROMPT_OBS_KB : PROMPT_OBS_DEFAULT;
  if (observation.length <= cap) return observation;
  return observation.slice(0, cap) + `\n…[truncated, ${observation.length} chars total]`;
}

export function truncateObservationForSynthesis(action: string, observation: string): string {
  const cap = isKbAgentAction(action) ? SYNTHESIS_OBS_KB : SYNTHESIS_OBS_DEFAULT;
  if (observation.length <= cap) return observation;
  return observation.slice(0, cap) + `\n…[truncated, ${observation.length} chars total]`;
}

/** Успешно подгружен текст из KB (folder read или длинный search). */
export function stepHasKbReadableContent(step: AgentStepSlice): boolean {
  if (!isKbAgentAction(step.action)) return false;
  const obs = step.observation;
  if (/source not found|"error"\s*:\s*"source not found"/i.test(obs)) return false;
  if (step.action.includes('read_folder_file') && obs.includes('"content"')) return obs.length >= 40;
  if (obs.length < 80) return false;
  if (step.action.includes('get_source') && obs.includes('"chunks"')) return true;
  if (step.action.includes('search_sources') && obs.includes('"chunks"') && obs.length > 600) return true;
  return false;
}

export function hasSuccessfulKbMaterial(steps: AgentStepSlice[]): boolean {
  return steps.some(stepHasKbReadableContent);
}

/** Нужны поля/структура — одного усечённого search_sources мало. */
export function isKbDetailLookupGoal(goal: string): boolean {
  if (!isKbLookupGoal(goal)) return false;
  const g = goal.toLowerCase();
  return (
    /подробн|поля|поле\b|структур|таблиц|перечисл|какие\s+поля|разбер/.test(g)
    || /[a-z]{2,}_[a-z0-9_]{3,}/i.test(goal)
    || /=\s*\d{2,}/.test(goal)
  );
}

/** Глубокое чтение: get_source / read_folder_file (не только search snippets). */
export function stepHasDeepKbContent(step: AgentStepSlice): boolean {
  if (!isKbAgentAction(step.action)) return false;
  const obs = step.observation;
  if (/source not found|"error"\s*:\s*"source not found"/i.test(obs)) return false;
  if (step.action.includes('read_folder_file') && obs.includes('"content"') && obs.length >= 40) {
    return true;
  }
  if (step.action.includes('get_source') && obs.includes('"chunks"') && obs.length > 800) {
    return true;
  }
  return false;
}

/** Count distinct successful KB tool actions (for early-finalize gating). */
export function countSuccessfulKbSteps(steps: AgentStepSlice[]): number {
  return steps.filter(stepHasKbReadableContent).length;
}

/**
 * Early-finalize only for pure KB lookup.
 * Detail goals need deep read; plain lookup needs deep content OR ≥2 successful KB steps.
 * Never finalizes code-exploration / kb-assisted goals.
 */
export function shouldFinalizeKbLookupAfterSteps(goal: string, steps: AgentStepSlice[]): boolean {
  if (!isKbLookupGoal(goal)) return false;
  if (isCodeExplorationGoal(goal) || isKbAssistedGoal(goal)) return false;
  if (isKbDetailLookupGoal(goal)) {
    return steps.some(stepHasDeepKbContent);
  }
  // Require deep read or at least two successful KB material steps — one thin search is not enough
  if (steps.some(stepHasDeepKbContent)) return true;
  return countSuccessfulKbSteps(steps) >= 2;
}
