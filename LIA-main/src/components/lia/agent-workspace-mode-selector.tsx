'use client';

import { useEffect, useRef, useState } from 'react';
import {
  WORKSPACE_MODE_INPUTS,
  WORKSPACE_MODE_LABELS,
  WORKSPACE_MODE_DESCRIPTIONS,
  type WorkspaceModeInput,
} from '@/lib/agent/workspace-modes';
import { useChatStore } from '@/stores/chat-store';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { BookOpen, Eye, Pencil, Sparkles, Check, ChevronDown, Zap, Shield } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { toast } from 'sonner';

const ICONS: Record<WorkspaceModeInput, LucideIcon> = {
  auto: Sparkles,
  read: BookOpen,
  explore: Eye,
  edit: Pencil,
};

type Props = {
  disabled?: boolean;
  className?: string;
};

/**
 * Read / Explore / Edit + sticky Apply mode (ask|auto).
 * Hotkey Ctrl+Shift+A toggles ask ↔ auto in agent mode.
 */
export function AgentWorkspaceModeSelector({ disabled, className }: Props) {
  const mode = useChatStore(s => s.agentWorkspaceMode);
  const setMode = useChatStore(s => s.setAgentWorkspaceMode);
  const applyMode = useChatStore(s => s.agentApplyMode);
  const setApplyMode = useChatStore(s => s.setAgentApplyMode);
  const chatMode = useChatStore(s => s.mode);
  const executor = useChatStore(s => s.activeTaskExecutor);
  const isClaudeCode = executor === 'claude_code';
  const ActiveIcon = ICONS[mode] ?? Sparkles;
  const autoConfirmed = useRef(false);
  const [confirmAuto, setConfirmAuto] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (chatMode !== 'agent') return;
      if (useChatStore.getState().activeTaskExecutor === 'claude_code') return;
      if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.key.toLowerCase() !== 'a') return;
      e.preventDefault();
      const next = useChatStore.getState().agentApplyMode === 'ask' ? 'auto' : 'ask';
      if (next === 'auto' && !autoConfirmed.current) {
        setConfirmAuto(true);
        return;
      }
      setApplyMode(next);
      toast.message(next === 'auto' ? 'Авто-применение правок' : 'Спрашивать перед записью');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [chatMode, setApplyMode]);

  const enableAuto = () => {
    autoConfirmed.current = true;
    setConfirmAuto(false);
    setApplyMode('auto');
    toast.message('Авто-применение до конца чата (Ctrl+Shift+A — переключить)');
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild disabled={disabled || isClaudeCode}>
          <button
            type="button"
            title={
              isClaudeCode
                ? 'Backend: Claude Code (режимы Read/Explore/Edit не применяются)'
                : `${WORKSPACE_MODE_DESCRIPTIONS[mode]} · ${applyMode === 'ask' ? 'Спрашивать перед записью' : 'Авто-применение'} (Ctrl+Shift+A)`
            }
            aria-label={
              isClaudeCode
                ? 'Claude Code'
                : `Доступ агента: ${WORKSPACE_MODE_LABELS[mode]}`
            }
            className={cn(
              'inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium',
              'text-muted-foreground hover:text-foreground hover:bg-surface-2/80',
              'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
              'disabled:pointer-events-none disabled:opacity-50',
              className,
            )}
          >
            <ActiveIcon className="w-3.5 h-3.5 shrink-0 text-accent" />
            <span>{isClaudeCode ? 'Claude Code' : WORKSPACE_MODE_LABELS[mode]}</span>
            {!isClaudeCode && (applyMode === 'auto' ? (
              <Zap className="w-3 h-3 text-amber-400" aria-label="auto-apply" />
            ) : (
              <Shield className="w-3 h-3 text-sky-400" aria-label="ask-before-write" />
            ))}
            {!isClaudeCode && <ChevronDown className="w-3 h-3 opacity-50" />}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-72 p-1">
          {WORKSPACE_MODE_INPUTS.map((id) => {
            const Icon = ICONS[id];
            const isActive = mode === id;
            return (
              <DropdownMenuItem
                key={id}
                onSelect={() => setMode(id)}
                className="flex items-start gap-2.5 px-2.5 py-2 cursor-pointer"
              >
                <Icon className={cn('w-3.5 h-3.5 mt-0.5 shrink-0', isActive ? 'text-accent' : 'text-muted-foreground')} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium">{WORKSPACE_MODE_LABELS[id]}</span>
                    {isActive && <Check className="w-3 h-3 text-accent shrink-0" />}
                  </div>
                  <p className="text-[10px] leading-snug text-muted-foreground mt-0.5">
                    {WORKSPACE_MODE_DESCRIPTIONS[id]}
                  </p>
                </div>
              </DropdownMenuItem>
            );
          })}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => {
              if (applyMode === 'ask') {
                if (!autoConfirmed.current) {
                  setConfirmAuto(true);
                  return;
                }
                setApplyMode('auto');
              } else {
                setApplyMode('ask');
              }
            }}
            className="flex items-start gap-2.5 px-2.5 py-2 cursor-pointer"
          >
            {applyMode === 'ask' ? (
              <Zap className="w-3.5 h-3.5 mt-0.5 text-amber-400" />
            ) : (
              <Shield className="w-3.5 h-3.5 mt-0.5 text-sky-400" />
            )}
            <div className="flex-1 min-w-0">
              <span className="text-xs font-medium">
                {applyMode === 'ask' ? 'Включить авто-применение' : 'Спрашивать перед записью'}
              </span>
              <p className="text-[10px] leading-snug text-muted-foreground mt-0.5">
                Сейчас: {applyMode === 'ask' ? 'Apply вручную' : 'писать сразу'}. Горячая клавиша Ctrl+Shift+A.
              </p>
            </div>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {confirmAuto && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="rounded-lg border border-border bg-surface p-4 max-w-sm shadow-lg">
            <p className="text-sm mb-3">
              Дальше правки в этом чате будут применяться без вопросов. Переключить обратно — Ctrl+Shift+A.
            </p>
            <div className="flex gap-2 justify-end">
              <button type="button" className="text-xs text-muted-foreground px-2 py-1" onClick={() => setConfirmAuto(false)}>
                Отмена
              </button>
              <button type="button" className="text-xs text-amber-300 underline px-2 py-1" onClick={enableAuto}>
                Включить авто
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
