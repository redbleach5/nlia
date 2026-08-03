'use client';

import { UI_CHAT_MODES, getUiChatMode, normalizeChatMode } from '@/lib/chat-modes';
import { useChatStore } from '@/stores/chat-store';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { Check, ChevronDown } from 'lucide-react';

type ChatModeSelectorProps = {
  disabled?: boolean;
  className?: string;
};

/** Единственный SoT выбора режима — footer composer'а. */
export function ChatModeSelector({ disabled, className }: ChatModeSelectorProps) {
  const mode = useChatStore(s => s.mode);
  const setMode = useChatStore(s => s.setMode);
  const uiMode = normalizeChatMode(mode);
  const active = getUiChatMode(uiMode);
  const ActiveIcon = active.icon;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <button
          type="button"
          title={active.description}
          aria-label={`Режим: ${active.label}. ${active.description}`}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium',
            'text-muted-foreground hover:text-foreground hover:bg-surface-2/80',
            'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
            'disabled:pointer-events-none disabled:opacity-50',
            className,
          )}
        >
          <ActiveIcon className="w-3.5 h-3.5 shrink-0 text-accent" />
          <span>{active.label}</span>
          <ChevronDown className="w-3 h-3 opacity-50" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56 p-1">
        {UI_CHAT_MODES.map(m => {
          const Icon = m.icon;
          const isActive = uiMode === m.id;
          return (
            <DropdownMenuItem
              key={m.id}
              onSelect={() => setMode(m.id)}
              className="flex items-start gap-2.5 px-2.5 py-2 cursor-pointer"
            >
              <Icon className={cn('w-3.5 h-3.5 mt-0.5 shrink-0', isActive ? 'text-accent' : 'text-muted-foreground')} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium">{m.label}</span>
                  {isActive && <Check className="w-3 h-3 text-accent shrink-0" />}
                </div>
                <p className="text-[10px] leading-snug text-muted-foreground mt-0.5">{m.description}</p>
              </div>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
