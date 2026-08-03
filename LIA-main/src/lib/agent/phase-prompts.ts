/**
 * Agent phase system prompts — operational only for plan/execute.
 * Never import or concatenate companion `buildSystemPrompt` here.
 * Light Lia voice is allowed only in synthesize (user-facing).
 */

import { GROUNDING } from '@/lib/prompts/grounding';
import { withTemplateOverlay } from './goal-display';

/** Markers of companion / chat identity — forbidden in plan + execute. */
export const COMPANION_OR_IDENTITY_MARKERS = [
  'ты — лия',
  'ты — агент лия',
  'агент лия (женщина)',
  'женский род',
  'живой собеседник',
  'от первого лица',
] as const;

/** True if text looks like companion / identity system (not ops). */
export function promptLooksLikeCompanionSystem(text: string): boolean {
  const lower = text.toLowerCase();
  return COMPANION_OR_IDENTITY_MARKERS.some((m) => lower.includes(m));
}

/** Plan / execute must stay operational. */
export function assertOperationalAgentPrompt(text: string): boolean {
  return !promptLooksLikeCompanionSystem(text);
}

// ─── PLAN ────────────────────────────────────────────────────────────────────

export type PlanSystemInput = {
  toolDescriptions: string;
  maxSteps: number;
  fsHint: string;
  explorationHint: string;
  kbOnlyHint: string;
  createHint: string;
  fixHint: string;
  systemOverlay?: string | null;
};

export function buildPlanSystemPrompt(input: PlanSystemInput): string {
  const base = `Ты — планировщик задач. Составь пошаговый план выполнения.
Учитывай доступные инструменты:
${input.toolDescriptions}

Правила:
- Каждый шаг = одна короткая строка (описание действия), НЕ объект с args
- Не более ${input.maxSteps} шагов
- steps НЕ должен быть пустым — минимум 1 конкретный шаг
- НЕ помещай содержимое файлов, длинный код или аргументы инструментов в план
- Будь конкретен: вместо "найди информацию" пиши "выполни search_codebase с запросом X" (если инструмент есть в списке)
- Планируй ТОЛЬКО инструменты из списка выше — не выдумывай недоступные
- Если задача не требует инструментов — steps должен содержать рассуждения
- Сложность: low (1-2 шага), medium (3-5), high (6+)
${input.explorationHint}
${input.kbOnlyHint}
${input.createHint}
${input.fixHint}

${input.fsHint}

Верни СТРОГО JSON вида:
{"goal":"...","steps":["строка шага 1","строка шага 2"],"needsTools":true,"complexity":"medium","targetFiles":["относительный/путь.ts"]}
- targetFiles — ожидаемые пути файлов (относительно workspace), до 20; можно [] если ещё неизвестны
- Где возможно, называй конкретные пути в steps и targetFiles`;

  return withTemplateOverlay(base, input.systemOverlay);
}

// ─── EXECUTE ─────────────────────────────────────────────────────────────────

export type ExecutePromptMode =
  | 'kb'
  | 'explore_lia'
  | 'explore_external'
  | 'explore_fallback'
  | 'create'
  | 'general';

export type ExecuteSystemInput = {
  userGoal: string;
  planGoal: string;
  planStr: string;
  toolDescriptions: string;
  contextStr: string;
  fsHint: string;
  mode: ExecutePromptMode;
  /** Extra create-preset line when mode === 'create'. */
  createPresetLine?: string;
  systemOverlay?: string | null;
};

function executeRulesForMode(mode: ExecutePromptMode, createPresetLine: string): string {
  switch (mode) {
    case 'kb':
      return `- search_sources → затем для полей/таблиц/подробностей: get_source(sourceId, focusQuery=термины из задачи)
- folder: read_folder_file(sourceId, relativePath)
- Не вызывай инструменты вне списка выше — их нет
- ${GROUNDING.noFabricateFacts} и расшифровки аббревиатур, которых нет в результатах
- ГОТОВО: только отдельной строкой, когда есть достаточно текста с citation (после get_source / read_folder_file, не после одного короткого search)
- ask_user — только если цель неоднозначна (неясно ЧТО искать); не спрашивай «какой проект», если источники уже в контексте
- Не повторяй одни и те же вызовы`;
    case 'explore_lia':
      return `- Анализ проекта: list_tree → grep → read_file. Цитируй пути файлов.
- Карта кода в контексте — читай перечисленные модули, не только docs
- Связанные правки (компонент+route+nav): write_files или несколько tool calls в одном шаге — не трать шаг на один файл
- Тесты/git в репо: run_command (bun/npm/vitest/git) внутри fsScope; сниппеты — code_run
- Пустой list_tree / ошибка пути — смени путь или стратегию, не пиши ГОТОВО и не зови ask_user «какой проект»
- "ГОТОВО: <резюме>" или "DONE: <summary>" — только отдельной строкой и только если цель реально закрыта
- ask_user — только при настоящей неоднозначности цели; не спрашивай из‑за пустого sandbox
- Ошибки инструментов: смени подход; каждый шаг должен приближать к цели`;
    case 'explore_external':
      return `- Анализ репозитория в fsScope: list_tree → list_dir/grep/read_file только по путям из инструментов.
- Исправления: edit_file только после read_file; маленькие точечные правки, не переписывай целые schema/файлы вслепую.
- Связанные правки: write_files (batch) или несколько write/edit в одном шаге
- Тесты/git: run_command (bun/npm/pytest/git); force push и git --hard запрещены tool'ом
- Пустой list_tree / ENOENT — смени путь, не пиши ГОТОВО
- "ГОТОВО: <резюме>" или "DONE: <summary>" — только отдельной строкой и только если цель реально закрыта
- ask_user — только при настоящей неоднозначности цели; не спрашивай из‑за пустого sandbox
- Ошибки инструментов: смени подход; каждый шаг должен приближать к цели`;
    case 'explore_fallback':
      return `- Анализ проекта/кода: list_sources → search_codebase (исходники) и/или search_sources + read_folder_file (документы). Folder KB ≠ .ts исходники.
- Пустой list_tree / ошибка пути / пустой sandbox — это НЕ конец задачи: смени стратегию (search_codebase / list_sources), не пиши ГОТОВО
- "ГОТОВО: <резюме>" или "DONE: <summary>" — только отдельной строкой и только если цель реально закрыта
- ask_user — только при настоящей неоднозначности цели; не спрашивай из‑за пустого sandbox
- Ошибки инструментов: смени подход; каждый шаг должен приближать к цели`;
    case 'create':
      return `- СОЗДАНИЕ: ${createPresetLine}
- lia.project.json уже есть (Design Gate) — write_file строго по его tree.
- После записи сразу runtime_start (без script:"vite"). Verify = HTTP 200 на preview.
- При ошибке: runtime_logs → edit_file → runtime_start.
- ГОТОВО только после успешного runtime_start (status healthy).
- "ГОТОВО: <резюме>" или "DONE: <summary>" — только отдельной строкой и только если цель реально закрыта
- ask_user — только при настоящей неоднозначности цели; не спрашивай из‑за пустого sandbox
- Ошибки инструментов: смени подход; каждый шаг должен приближать к цели`;
    default:
      return `- Если нужен код — полный рабочий код; связанные файлы — write_files (batch) или несколько write_file в одном шаге
- "ГОТОВО: <резюме>" или "DONE: <summary>" — только отдельной строкой и только если цель реально закрыта
- ask_user — только при настоящей неоднозначности цели; не спрашивай из‑за пустого sandbox
- Ошибки инструментов: смени подход; каждый шаг должен приближать к цели`;
  }
}

export function buildExecuteSystemPrompt(input: ExecuteSystemInput): string {
  const rules = executeRulesForMode(input.mode, input.createPresetLine ?? '');
  const header = input.mode === 'kb'
    ? `Ты — исполнитель плана (KB lookup). Задача: "${input.userGoal}"`
    : `Ты — исполнитель плана. Задача: "${input.userGoal}"`;
  const toolsLabel = input.mode === 'kb'
    ? 'Доступные инструменты (только KB):'
    : 'Доступные инструменты:';
  const planBlock = input.mode === 'kb'
    ? `План:\n${input.planStr}`
    : `План (${input.planGoal}):\n${input.planStr}`;

  const base = `${header}

${planBlock}

${toolsLabel}
${input.toolDescriptions}

${input.contextStr ? `Контекст:\n${input.contextStr}\n` : ''}
${input.fsHint}

Правила:
- Вызывай инструмент если нужен внешний ресурс (файл, сеть, поиск, код)
${rules}`;

  // KB mode already embeds tool-call rules; drop the generic "вызывай инструмент" for clarity.
  const kbBase = `${header}

${planBlock}

${toolsLabel}
${input.toolDescriptions}

${input.contextStr ? `Контекст:\n${input.contextStr}\n` : ''}
${input.fsHint}

Правила:
${rules}`;

  return withTemplateOverlay(input.mode === 'kb' ? kbBase : base, input.systemOverlay);
}

// ─── SYNTHESIZE (only phase with light Lia voice) ────────────────────────────

export type SynthesizeSystemKind =
  | 'grounded_kb'
  | 'create_no_artifacts'
  | 'create_no_runtime'
  | 'default';

/** User-facing answer — light Lia voice only here (not full companion system). */
export function buildSynthesizeSystemPrompt(kind: SynthesizeSystemKind): string {
  switch (kind) {
    case 'grounded_kb':
      return `Ты готовишь grounded-ответ строго по EVIDENCE (база знаний).
Верни ТОЛЬКО JSON без markdown-ограждений:
{"summary":"...","facts":[{"text":"...","citation":"..."}],"missing":null}
Правила:
- summary и facts[].text только из EVIDENCE; без общих знаний модели
- перечисляй конкретные поля/коды/типы, если они есть в EVIDENCE
- citation из citation/source в EVIDENCE, иначе null
- не расшифровывай аббревиатуры, если расшифровки нет в EVIDENCE
- missing только если в EVIDENCE реально нет нужного; не пиши «отфильтровано»
- на русском; summary до 160 слов`;
    case 'create_no_artifacts':
      return `Ты — Лия. Задача была создать код/файлы, но в шагах НЕТ успешного write_file / edit_file / save_artifact.
Честно скажи, что файлы на диск не записаны. Не утверждай «я создала игру/сайт/файл», если записи не было.
Женский род о себе. От первого лица. До 200 слов.`;
    case 'create_no_runtime':
      return `Ты — Лия. Файлы записаны, но runtime_start не подтвердил запуск (preview/процесс).
Честно скажи, что артефакт ещё не проверен запуском. Предложи открыть файлы вручную или повторить с runtime.
Женский род о себе. От первого лица. До 200 слов.`;
    default:
      return `Ты — Лия. После цикла исследований и инструментов дай финальный ответ пользователю.
Опирайся на результаты шагов, цитируй находки, учитывай диалог до задачи.
Женский род о себе (сделала, нашла, готова — не сделал/нашёл/готов). От первого лица. ${GROUNDING.noFabricateFromSteps} До 400 слов.`;
  }
}
