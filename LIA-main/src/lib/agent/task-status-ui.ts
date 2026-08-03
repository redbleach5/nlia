/** Busy = агент реально работает (блокирует ввод / пульс / cancel). */
export function isAgentBusyStatus(status: string | null | undefined): boolean {
  return status === 'planning'
    || status === 'executing'
    || status === 'waiting_input'
    || status === 'synthesizing';
}

/**
 * Single vocabulary for agent phase UI.
 * Keep labels short — do not stack synonyms («планирую» + «планирует» + «составляю план»).
 */
export const AGENT_PHASE_LABEL: Record<string, string> = {
  pending: 'ожидает',
  planning: 'план',
  executing: 'шаги',
  waiting_input: 'вопрос',
  synthesizing: 'итог',
  done: 'готово',
  failed: 'ошибка',
  cancelled: 'отменено',
};

/** Compact subtitle under workbench header — never repeats the phase badge wording. */
export function agentWorkbenchSummary(opts: {
  status: string | null | undefined;
  busy: boolean;
  stepCount?: number;
  editCount?: number;
  undoableCount?: number;
  runtimeHealthy?: boolean;
  designKind?: string | null;
}): string {
  const {
    status,
    busy,
    stepCount = 0,
    editCount = 0,
    undoableCount = 0,
    runtimeHealthy = false,
    designKind = null,
  } = opts;

  if (busy) {
    if (status === 'waiting_input') return 'ждёт ответ';
    if (status === 'executing' && stepCount > 0) return `шаг ${stepCount}`;
    // planning / synthesizing — фаза уже в thought bubble, без второго глагола
    return '';
  }
  if (runtimeHealthy) return 'preview';
  if (undoableCount > 0) return `${undoableCount} откат`;
  if (editCount > 0) return `${editCount} правок`;
  if (designKind) return designKind;
  if (status === 'done') return 'готово';
  if (status === 'failed') return 'ошибка';
  return AGENT_PHASE_LABEL[status ?? ''] ?? '';
}
