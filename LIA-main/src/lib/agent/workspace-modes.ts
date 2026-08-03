/**
 * Agent workspace modes — Read / Explore / Edit.
 *
 * Shared (no server-only): usable from UI heuristics + server control plane.
 * Orthogonal to ChatMode (Диалог | Агент).
 */

export type WorkspaceMode = 'read' | 'explore' | 'edit';
export type WorkspaceModeInput = 'auto' | WorkspaceMode;

export const WORKSPACE_MODE_INPUTS = ['auto', 'read', 'explore', 'edit'] as const;

/** Read: KB only — no FS write, no run_command. */
export const READ_TOOLS = [
  'search_sources',
  'get_source',
  'read_folder_file',
  'list_sources',
  'ask_user',
  'web_search',
  'fetch_page',
] as const;

/** Explore: Read + FS read / codebase search — no write/run. */
export const EXPLORE_TOOLS = [
  ...READ_TOOLS,
  'grep',
  'read_file',
  'list_dir',
  'list_tree',
  'file_search',
  'search_codebase',
  'list_codebase_symbols',
] as const;

/** Edit: Explore + write / edit / run. */
export const EDIT_TOOLS = [
  ...EXPLORE_TOOLS,
  'write_file',
  'write_files',
  'edit_file',
  'run_command',
  'code_run',
  'save_artifact',
  // http_request removed from whitelist — alias of fetch_page still registered
  // for legacy tool calls, but models should use fetch_page.
  'propose_design',
  'runtime_start',
  'runtime_logs',
  'runtime_stop',
] as const;

export const WORKSPACE_MODE_TOOLS: Record<WorkspaceMode, readonly string[]> = {
  read: READ_TOOLS,
  explore: EXPLORE_TOOLS,
  edit: EDIT_TOOLS,
};

/** Edit-intent verbs (align with wantsProjectWorkspace / isKbLookupGoal negation). */
export function isEditIntentGoal(goal: string): boolean {
  const g = goal.toLowerCase();
  return (
    /исправ|реализу|напиш|почин|добав|отредактир|refactor|implement|fix\b|edit\b/.test(g)
    || /не\s+работает|не\s+запуска|сломал|разберись|почему\s+не/.test(g)
    || /создай\s+(файл|модул|функц|класс|компонент|игр|сайт|приложен|страниц)/.test(g)
    || /сделай\s+(игр|сайт|приложен|страниц|лендинг)/.test(g)
    || /write_file|edit_file|code_run/.test(g)
  );
}

/**
 * Auto mode from goal text.
 * Priority: edit → explore (code) → read (KB lookup) → explore (safe default).
 */
export function inferWorkspaceMode(goal: string): WorkspaceMode {
  if (isEditIntentGoal(goal)) return 'edit';

  const g = goal.toLowerCase();
  const codeExplore =
    /изуч|исслед|анализ|разбер|ревью|review|audit|аудит/.test(g)
    || /проблем|ошибк|баг|bug|defect|уязвим/.test(g)
    || /кодов\S*\s*баз|codebase|исходник|репозитор|репо\b|проект/.test(g)
    || /что\s+не\s+так|основные\s+проблем/.test(g);

  if (codeExplore) return 'explore';

  const mentionsKb =
    /баз\S*\s*знан/.test(g)
    || /knowledge\s*base/.test(g)
    || /\bkb\b/.test(g);

  const lookupish =
    /найди|найти|опиши|описание|что\s+такое|расскажи|покажи|ищи|поищи|lookup|find\b/.test(g)
    || /в\s+(баз|knowledge|kb)/.test(g);

  const hasKb =
    mentionsKb
    || (/найди|найти|опиши|описание|что\s+такое|расскажи|покажи/.test(g)
      && /(баз|документ|знан|kb|протокол)/.test(g));

  if (hasKb && lookupish) return 'read';

  return 'explore';
}

export function resolveWorkspaceMode(
  goal: string,
  manual: WorkspaceModeInput = 'auto',
): WorkspaceMode {
  if (manual === 'read' || manual === 'explore' || manual === 'edit') return manual;
  return inferWorkspaceMode(goal);
}

export function normalizeWorkspaceModeInput(v: unknown): WorkspaceModeInput {
  if (v === 'read' || v === 'explore' || v === 'edit' || v === 'auto') return v;
  return 'auto';
}

function intersectTools(a: readonly string[], b: readonly string[]): string[] {
  const setB = new Set(b);
  return a.filter((t) => setB.has(t));
}

/**
 * Effective tool whitelist for a resolved workspace mode.
 *
 * Priority:
 *   1. Caller non-empty whitelist — intersected with mode tools (safety)
 *   2. Mode tools ∩ template whitelist (if template set)
 *   3. Mode tools
 */
export function applyModeWhitelist(
  mode: WorkspaceMode,
  opts: {
    callerWhitelist?: string[] | null;
    templateWhitelist?: string[] | null;
  } = {},
): string[] {
  const modeTools = WORKSPACE_MODE_TOOLS[mode];
  const { callerWhitelist, templateWhitelist } = opts;

  if (callerWhitelist && callerWhitelist.length > 0) {
    return intersectTools(callerWhitelist, modeTools);
  }
  if (templateWhitelist && templateWhitelist.length > 0) {
    return intersectTools(modeTools, templateWhitelist);
  }
  return [...modeTools];
}

/**
 * True when Edit would write into an empty auto-sandbox and user has not confirmed.
 * project / kb / env_default / explicit / intentional sandbox binding → no confirm.
 * Inherited artifact sandbox (fsScope already set) → no confirm.
 */
export function needsSandboxConfirm(
  mode: WorkspaceMode,
  resolvedKind: string,
  confirmSandbox?: boolean,
  opts?: { intentionalSandboxBinding?: boolean; fsScopeAlreadyBound?: boolean },
): boolean {
  if (mode !== 'edit') return false;
  if (confirmSandbox) return false;
  if (opts?.intentionalSandboxBinding) return false;
  // dry-run new sandbox has kind=sandbox + fsScope=null; inherited path is already bound.
  if (opts?.fsScopeAlreadyBound) return false;
  return resolvedKind === 'sandbox';
}

/** Read/Explore never need a write sandbox. */
export function modeAllowsWriteSandbox(mode: WorkspaceMode): boolean {
  return mode === 'edit';
}

export const WORKSPACE_MODE_LABELS: Record<WorkspaceModeInput, string> = {
  auto: 'Авто',
  read: 'Чтение',
  explore: 'Обзор',
  edit: 'Правка',
};

export const WORKSPACE_MODE_DESCRIPTIONS: Record<WorkspaceModeInput, string> = {
  auto: 'Доступ по смыслу задачи (не путать с «папкой чата» в шапке).',
  read: 'Только база знаний и веб — без записи на диск.',
  explore: 'Читать файлы и искать в коде — без правок и команд.',
  edit: 'Можно писать файлы и запускать команды в папке чата.',
};
