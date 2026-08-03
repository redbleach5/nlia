import { Sparkles, Rocket } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ChatMode } from '@/stores/slices/types';

interface ChatModeDef {
  id: ChatMode;
  label: string;
  short: string;
  icon: LucideIcon;
  description: string;
}

/** Режимы, видимые в UI — только два. */
export const UI_CHAT_MODES: ChatModeDef[] = [
  {
    id: 'auto',
    label: 'Диалог',
    short: 'Д',
    icon: Sparkles,
    description: 'Обычный разговор — глубина подстраивается под задачу и железо.',
  },
  {
    id: 'agent',
    label: 'Агент',
    short: 'А',
    icon: Rocket,
    description: 'Многошаговые задачи: план, файлы, код и поиск.',
  },
];

/** Нормализует режим (в т.ч. legacy fast/standard/deep из localStorage). */
export function normalizeChatMode(mode: string): ChatMode {
  return mode === 'agent' ? 'agent' : 'auto';
}

export function getUiChatMode(id: ChatMode): ChatModeDef {
  return UI_CHAT_MODES.find(m => m.id === id) ?? UI_CHAT_MODES[0];
}
