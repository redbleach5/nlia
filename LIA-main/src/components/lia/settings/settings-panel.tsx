'use client';

// SettingsPanel — full-page settings body (nav + tabs). Shared by /settings.

import { useCallback, useEffect, useState } from 'react';
import {
  MessageSquare,
  User,
  Info,
  BookOpen,
  Loader2,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import {
  DEFAULT_AVATAR_CONFIG,
  parseAvatarConfig,
  type AvatarConfig,
} from '@/lib/avatar-config';
import { ModelTab } from './model-tab';
import { AvatarTab } from './avatar-tab';
import { KbTab } from './kb-tab';
import { AboutTab } from './about-tab';
import type { Settings } from './types';
import type { SettingsSection } from './settings-sections';

export type { SettingsSection };
export { SETTINGS_SECTIONS, isSettingsSection } from './settings-sections';

const NAV: Array<{
  id: SettingsSection;
  label: string;
  description: string;
  icon: typeof MessageSquare;
}> = [
  { id: 'model', label: 'Модель', description: 'Ollama, роли, Claude Code', icon: MessageSquare },
  { id: 'avatar', label: 'Вид', description: 'Образ и анимация', icon: User },
  { id: 'kb', label: 'База', description: 'Источники знаний', icon: BookOpen },
  { id: 'about', label: 'О Лии', description: 'Профиль и сведения', icon: Info },
];

type SettingsPanelProps = {
  section: SettingsSection;
  onSectionChange: (section: SettingsSection) => void;
};

export function SettingsPanel({ section, onSectionChange }: SettingsPanelProps) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);

  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [agentModel, setAgentModel] = useState('');
  const [secondaryModel, setSecondaryModel] = useState('');
  const [heavyModel, setHeavyModel] = useState('');
  const [embedModel, setEmbedModel] = useState('auto');
  const [activeVrm, setActiveVrm] = useState<string | null>(null);
  const [avatarConfig, setAvatarConfig] = useState<AvatarConfig>(DEFAULT_AVATAR_CONFIG);

  const refresh = useCallback(async (opts?: { quiet?: boolean }) => {
    const quiet = Boolean(opts?.quiet && settings);
    if (!quiet) setLoading(true);
    try {
      const settingsRes = await fetch('/api/settings');
      const settingsData = await settingsRes.json();
      setSettings(settingsData);
      setBaseUrl(settingsData.baseUrl ?? '');
      setModel(settingsData.model ?? '');
      setAgentModel(settingsData.agentModel ?? '');
      setSecondaryModel(settingsData.secondaryModel ?? '');
      setHeavyModel(settingsData.heavyModel ?? '');
      setEmbedModel(settingsData.embedModel ?? 'auto');
      setActiveVrm(settingsData.activeVrm);
      setAvatarConfig(settingsData.avatarConfig
        ? parseAvatarConfig(JSON.stringify(settingsData.avatarConfig))
        : DEFAULT_AVATAR_CONFIG);
    } catch {
      toast.error('Не удалось загрузить настройки');
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [settings]);

  useEffect(() => {
    void refresh();
    // Initial load only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex flex-col md:flex-row gap-4 md:gap-6 min-w-0 w-full">
      <nav
        className={cn(
          'shrink-0 flex md:flex-col gap-1 overflow-x-auto md:overflow-visible',
          'md:w-52 lg:w-56 md:sticky md:top-4 md:self-start',
        )}
        aria-label="Разделы настроек"
      >
        {NAV.map(({ id, label, description, icon: Icon }) => {
          const active = section === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => onSectionChange(id)}
              className={cn(
                'flex items-start gap-2.5 rounded-lg px-3 py-2.5 text-left transition-colors',
                'min-w-[8.5rem] md:min-w-0 md:w-full',
                active
                  ? 'bg-surface-2 text-foreground'
                  : 'text-muted-foreground hover:bg-surface-2/60 hover:text-foreground',
              )}
              aria-current={active ? 'page' : undefined}
            >
              <Icon className="w-4 h-4 mt-0.5 shrink-0" />
              <span className="min-w-0">
                <span className="block text-sm font-medium leading-tight">{label}</span>
                <span className="hidden md:block text-[0.6875rem] text-text-dim mt-0.5 leading-snug">
                  {description}
                </span>
              </span>
            </button>
          );
        })}
      </nav>

      <div className="flex-1 min-w-0">
        {loading && !settings && (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="w-5 h-5 animate-spin text-accent" />
          </div>
        )}

        {settings && section === 'model' && (
          <ModelTab
            settings={settings}
            baseUrl={baseUrl}
            model={model}
            agentModel={agentModel}
            secondaryModel={secondaryModel}
            heavyModel={heavyModel}
            embedModel={embedModel}
            setBaseUrl={setBaseUrl}
            setModel={setModel}
            setAgentModel={setAgentModel}
            setSecondaryModel={setSecondaryModel}
            setHeavyModel={setHeavyModel}
            setEmbedModel={setEmbedModel}
            onSaved={() => refresh({ quiet: true })}
          />
        )}

        {settings && section === 'avatar' && (
          <AvatarTab
            settings={settings}
            activeVrm={activeVrm}
            avatarConfig={avatarConfig}
            setActiveVrm={setActiveVrm}
            setAvatarConfig={setAvatarConfig}
            onSaved={() => refresh({ quiet: true })}
            onUploadComplete={() => refresh({ quiet: true })}
          />
        )}

        {settings && section === 'kb' && (
          <KbTab onRefresh={refresh} />
        )}

        {settings && section === 'about' && (
          <AboutTab
            people={settings.people ?? []}
            maxPeople={settings.maxPeople ?? 3}
            onPeopleChanged={async () => { await refresh({ quiet: true }); }}
          />
        )}
      </div>
    </div>
  );
}
