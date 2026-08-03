/**
 * Typed window events for cross-component chrome (settings, composer, episodes).
 * Prefer these helpers over magic strings. New app chrome should use Zustand
 * when both sides are React; keep events for lazy/settings boundaries.
 */

export const LIA_APP_EVENTS = {
  openSettings: 'lia-open-settings',
  openKb: 'lia-open-kb',
  openWorkspaceFile: 'lia-open-workspace-file',
  settingsChanged: 'lia-settings-changed',
  suggestion: 'lia-suggestion',
  focusComposer: 'lia-focus-composer',
  newEpisode: 'lia-new-episode',
} as const;

export type LiaAppEventName = (typeof LIA_APP_EVENTS)[keyof typeof LIA_APP_EVENTS];

export function dispatchLiaAppEvent(
  name: LiaAppEventName,
  detail?: unknown,
): void {
  if (typeof window === 'undefined') return;
  if (detail === undefined) {
    window.dispatchEvent(new Event(name));
  } else {
    window.dispatchEvent(new CustomEvent(name, { detail }));
  }
}

export function onLiaAppEvent(
  name: LiaAppEventName,
  handler: (ev: Event) => void,
): () => void {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener(name, handler);
  return () => window.removeEventListener(name, handler);
}
