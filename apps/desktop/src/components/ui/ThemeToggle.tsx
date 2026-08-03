/**
 * ThemeToggle — manual light/dark theme switch.
 * Clay & Cream aesthetic — minimalist, hairline border.
 */

import { useEffect, useState } from "react";
import { Sun, Moon } from "lucide-react";

type Theme = "light" | "dark";

function getInitialTheme(): Theme {
  if (typeof window === "undefined") return "light";
  const stored = localStorage.getItem("lia:theme");
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute("data-theme", theme);
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(getInitialTheme);

  useEffect(() => {
    applyTheme(theme);
    localStorage.setItem("lia:theme", theme);
  }, [theme]);

  const toggle = () => setTheme((t) => (t === "dark" ? "light" : "dark"));

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={theme === "dark" ? "Переключить на светлую тему" : "Переключить на тёмную тему"}
      title={theme === "dark" ? "Светлая тема" : "Тёмная тема"}
      className="inline-flex items-center justify-center w-8 h-8 rounded-[var(--radius-sm)] text-[var(--color-fg-muted)] hover:text-[var(--color-ember)] hover:bg-[var(--color-surface-2)] transition-colors border border-transparent hover:border-[var(--color-border)]"
    >
      {theme === "dark" ? <Sun size={14} /> : <Moon size={14} />}
    </button>
  );
}
