/** Shared settings section ids — safe for server + client. */

export const SETTINGS_SECTIONS = ['model', 'avatar', 'kb', 'about'] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export function isSettingsSection(value: string): value is SettingsSection {
  return (SETTINGS_SECTIONS as readonly string[]).includes(value);
}

export function resolveSettingsSection(raw: string | undefined): SettingsSection {
  if (raw && isSettingsSection(raw)) return raw;
  return 'model';
}
