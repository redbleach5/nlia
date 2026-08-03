'use client';

// ============================================================================
// ThemeProvider — управление data-theme на <html>
//   • Хранит тему в localStorage
//   • Синхронизирует между вкладками
//   • Применяет на <html> до первого paint (через inline script в layout)
//   • Cross-fade transition при смене темы (280ms)
//   • Поддерживает: 'classic' | 'quiet' | 'wow'
// ============================================================================

import { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';

export type LiaTheme = 'classic' | 'quiet' | 'wow';

const THEME_KEY = 'lia-theme';

export const THEMES: Array<{ id: LiaTheme; label: string; description: string }> = [
  {
    id: 'classic',
    label: 'Тёплый лён',
    description: 'Светлый тёплый фон, спокойный акцент. Базовая тема.',
  },
  {
    id: 'quiet',
    label: 'Тихая студия',
    description: 'Минимализм, мягкий зелёный акцент, без свечения.',
  },
  {
    id: 'wow',
    label: 'Северное сияние',
    description: 'Тёмная палитра для вечера — без свечения и орбов.',
  },
];

type ThemeContextValue = {
  theme: LiaTheme;
  setTheme: (theme: LiaTheme) => void;
  cycleTheme: () => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    return {
      theme: 'classic',
      setTheme: () => { /* no-op */ },
      cycleTheme: () => { /* no-op */ },
    };
  }
  return ctx;
}

function readStoredTheme(): LiaTheme {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'classic' || saved === 'quiet' || saved === 'wow') return saved;
  } catch { /* */ }
  return 'classic';
}

function readDomTheme(): LiaTheme | null {
  if (typeof document === 'undefined') return null;
  const attr = document.documentElement.getAttribute('data-theme');
  if (attr === 'classic' || attr === 'quiet' || attr === 'wow') return attr;
  return null;
}

// Порядок цикла для кнопки в header
const CYCLE: LiaTheme[] = ['classic', 'quiet'];

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // SSR + first client paint must match — restore preference after mount.
  // no-flash script already set data-theme on <html> before paint.
  const [theme, setThemeState] = useState<LiaTheme>('classic');
  const [ready, setReady] = useState(false);

  // Ref для transition timer — чтобы можно было отменить при быстром переключении
  const transitionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const next = readDomTheme() ?? readStoredTheme();
    setThemeState(next);
    setReady(true);
  }, []);

  // Apply theme on <html> + persist + cross-fade transition
  useEffect(() => {
    if (!ready) return;

    const root = document.documentElement;
    const body = document.body;

    // Добавляем transition-класс для плавного перехода
    if (body && !body.classList.contains('lia-theme-transition')) {
      body.classList.add('lia-theme-transition');
    }

    // Меняем тему
    root.setAttribute('data-theme', theme);

    // Persist
    try { localStorage.setItem(THEME_KEY, theme); } catch { /* */ }

    // Убираем transition-класс через 320ms (280ms transition + 40ms buffer)
    if (transitionTimerRef.current) clearTimeout(transitionTimerRef.current);
    transitionTimerRef.current = setTimeout(() => {
      if (body) body.classList.remove('lia-theme-transition');
    }, 320);
  }, [theme, ready]);

  // Cross-tab sync
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key === THEME_KEY) {
        const v = e.newValue;
        if (v === 'classic' || v === 'quiet' || v === 'wow') {
          setThemeState(v);
        }
      }
    };
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, []);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (transitionTimerRef.current) clearTimeout(transitionTimerRef.current);
    };
  }, []);

  const setTheme = useCallback((t: LiaTheme) => setThemeState(t), []);
  const cycleTheme = useCallback(() => {
    setThemeState(prev => {
      // Header cycles only couple-safe themes; WOW stays in Settings → Внешний вид
      const safe = prev === 'wow' ? 'classic' : prev;
      const idx = CYCLE.indexOf(safe);
      return CYCLE[(idx + 1) % CYCLE.length];
    });
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, setTheme, cycleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

// ============================================================================
// Inline script — применяется до first paint, чтобы не было FOUC
// Вставляется в <head> через layout.tsx
// ============================================================================

export const themeNoFlashScript = `
(function() {
  try {
    var t = localStorage.getItem('${THEME_KEY}');
    if (t === 'wow' || t === 'quiet') {
      document.documentElement.setAttribute('data-theme', t);
    } else {
      document.documentElement.setAttribute('data-theme', 'classic');
    }
  } catch (e) {
    document.documentElement.setAttribute('data-theme', 'classic');
  }
})();
`;
