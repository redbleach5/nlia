'use client';

import { useTheme, type LiaTheme } from './theme-provider';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn, getModKeyLabel } from '@/lib/utils';
import {
  PanelLeft,
  PanelLeftClose,
  BookOpen,
  UserRound,
  UserRoundCheck,
  UserRoundX,
  Sun,
  Leaf,
  CircleHelp,
  MoreHorizontal,
} from 'lucide-react';
import { useEffect, useState } from 'react';

// ============================================================================
// HeaderStatus — companion-first chrome
//   Visible: chats · avatar · «Ещё»
//   «Ещё»: KB, theme, shortcuts
// ============================================================================

type AvatarMode = 'full' | 'portrait' | 'hidden';

type HeaderStatusProps = {
  episodesCollapsed: boolean;
  onToggleEpisodes: () => void;
  avatarMode: AvatarMode;
  onCycleAvatar: () => void;
  kbOpen: boolean;
  onToggleKb: () => void;
  onOpenShortcuts: () => void;
};

export function HeaderStatus({
  episodesCollapsed,
  onToggleEpisodes,
  avatarMode,
  onCycleAvatar,
  kbOpen,
  onToggleKb,
  onOpenShortcuts,
}: HeaderStatusProps) {
  const { theme, cycleTheme } = useTheme();
  const [mod, setMod] = useState('Ctrl');
  useEffect(() => { setMod(getModKeyLabel()); }, []);

  const AvatarIcon = avatarMode === 'full' ? UserRoundCheck : avatarMode === 'portrait' ? UserRound : UserRoundX;
  const avatarLabel = avatarMode === 'full'
    ? 'Образ: сцена справа'
    : avatarMode === 'portrait'
      ? 'Образ: рядом с ответами'
      : 'Образ скрыт';

  const themeLabelMap: Record<LiaTheme, string> = {
    classic: 'Тёплый лён',
    quiet: 'Тихая студия',
    wow: 'Северное сияние',
  };
  const themeLabel = themeLabelMap[theme];
  const ThemeIcon = theme === 'quiet' ? Leaf : Sun;

  return (
    <div className="flex items-center gap-0.5">
      <button
        type="button"
        onClick={onToggleEpisodes}
        className="lia-icon-btn"
        title={episodesCollapsed ? `Показать чаты (${mod}+\\)` : `Скрыть чаты (${mod}+\\)`}
        aria-label="Список чатов"
        data-active={!episodesCollapsed ? 'true' : 'false'}
      >
        {episodesCollapsed ? <PanelLeft className="w-3.5 h-3.5" /> : <PanelLeftClose className="w-3.5 h-3.5" />}
      </button>

      <button
        type="button"
        onClick={onCycleAvatar}
        className="lia-icon-btn"
        title={`${avatarLabel} (${mod}+Shift+A)`}
        aria-label={avatarLabel}
        data-active={avatarMode !== 'hidden' ? 'true' : 'false'}
      >
        <AvatarIcon className="w-3.5 h-3.5" />
      </button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="lia-icon-btn"
            title="Ещё"
            aria-label="Дополнительные действия"
          >
            <MoreHorizontal className="w-3.5 h-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={8} className="w-56 rounded-xl">
          <DropdownMenuLabel className="text-[11px] text-text-dim font-normal">
            Рядом с Лией
          </DropdownMenuLabel>
          <DropdownMenuItem className="gap-2 cursor-pointer" onSelect={() => onToggleKb()}>
            <BookOpen className="w-3.5 h-3.5 text-muted-foreground" />
            <span className="flex-1">База знаний</span>
            {kbOpen && <span className="text-[10px] text-accent">открыта</span>}
          </DropdownMenuItem>
          <DropdownMenuItem
            className="gap-2 cursor-pointer"
            onSelect={() => cycleTheme()}
          >
            <ThemeIcon className={cn('w-3.5 h-3.5', theme !== 'classic' && 'text-accent')} />
            <span className="flex-1">Тема: {themeLabel}</span>
          </DropdownMenuItem>
          <DropdownMenuItem className="gap-2 cursor-pointer" onSelect={() => onOpenShortcuts()}>
            <CircleHelp className="w-3.5 h-3.5 text-muted-foreground" />
            Горячие клавиши
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
