'use client';

// ============================================================================
// ThemePicker — выбор темы оформления (classic / quiet / wow)
//   • Используется в Settings → Внешний вид
//   • 3 карточки с preview + название + описание
//   • Клик — мгновенное переключение темы
//   • Активная тема подсвечивается accent-рамкой + галочкой
// ============================================================================

import { useTheme, THEMES, type LiaTheme } from './theme-provider';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

const PREVIEW_CLASS: Record<LiaTheme, string> = {
  classic: 'lia-theme-card-preview-classic',
  quiet: 'lia-theme-card-preview-quiet',
  wow: 'lia-theme-card-preview-wow',
};

export function ThemePicker() {
  const { theme, setTheme } = useTheme();

  return (
    <div className="space-y-1.5">
      <label className="text-xs font-medium text-foreground">Тема оформления</label>
      <p className="text-[10px] text-text-dim mb-2 leading-snug">
        Стиль интерфейса. В шапке — быстрое переключение между «Тёплый лён» и «Тихая студия».
        «Северное сияние» включается только здесь.
      </p>
      <div className="grid grid-cols-3 gap-2">
        {THEMES.map(t => {
          const isActive = theme === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setTheme(t.id)}
              className="lia-theme-card text-left"
              data-active={isActive ? 'true' : 'false'}
              aria-pressed={isActive}
            >
              <div className="lia-theme-card-check">
                <Check className="w-3 h-3" strokeWidth={3} />
              </div>
              <div className={cn('lia-theme-card-preview', PREVIEW_CLASS[t.id])} />
              <div className="lia-theme-card-name">{t.label}</div>
              <div className="lia-theme-card-desc">{t.description}</div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
