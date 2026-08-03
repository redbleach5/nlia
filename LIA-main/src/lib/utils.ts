import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Platform modifier key label for hotkey hints (⌘ on Apple, Ctrl elsewhere). */
export function getModKeyLabel(): string {
  if (typeof navigator === 'undefined') return 'Ctrl';
  const ua = navigator.userAgent || '';
  const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform
    || navigator.platform
    || '';
  if (/Mac|iPhone|iPad|iPod/i.test(platform) || /Mac OS|iPhone|iPad|iPod/i.test(ua)) {
    return '⌘';
  }
  return 'Ctrl';
}
