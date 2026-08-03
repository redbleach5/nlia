'use client';

// Shared presence avatar state for AvatarColumn + CompanionPortrait.
// Loads active VRM / config from settings; tracks load failure per src key.

import { useCallback, useEffect, useState } from 'react';
import {
  DEFAULT_AVATAR_CONFIG,
  parseAvatarConfig,
  type AvatarConfig,
} from '@/lib/avatar-config';
import { LIA_APP_EVENTS, dispatchLiaAppEvent, onLiaAppEvent } from '@/lib/lia-app-events';

export type PresenceAvatarState = {
  settingsReady: boolean;
  vrmSrc: string | undefined;
  avatarConfig: AvatarConfig;
  vrmFailed: boolean;
  handleVrmError: () => void;
  /** One-click sample VRM for first presence (spouse-first path). */
  downloadSample: () => Promise<{ ok: boolean; error?: string }>;
  downloading: boolean;
};

function notifySettingsChanged() {
  dispatchLiaAppEvent(LIA_APP_EVENTS.settingsChanged);
}

export function usePresenceAvatar(): PresenceAvatarState {
  const [settingsReady, setSettingsReady] = useState(false);
  const [vrmSrc, setVrmSrc] = useState<string | undefined>(undefined);
  const [avatarConfig, setAvatarConfig] = useState<AvatarConfig>(DEFAULT_AVATAR_CONFIG);
  const [vrmFailedKey, setVrmFailedKey] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);

  const vrmLoadKey = vrmSrc ?? 'default';
  const vrmFailed = vrmFailedKey === vrmLoadKey;

  useEffect(() => {
    const loadSettings = () => {
      fetch('/api/settings')
        .then(res => res.json())
        .then(data => {
          if (data.activeVrm) setVrmSrc(data.activeVrm);
          else setVrmSrc(undefined);
          if (data.avatarConfig) {
            setAvatarConfig(parseAvatarConfig(JSON.stringify(data.avatarConfig)));
          }
          setSettingsReady(true);
        })
        .catch(() => {
          setSettingsReady(true);
        });
    };
    loadSettings();
    return onLiaAppEvent(LIA_APP_EVENTS.settingsChanged, loadSettings);
  }, []);

  const handleVrmError = useCallback(() => {
    setVrmFailedKey(vrmLoadKey);
  }, [vrmLoadKey]);

  const downloadSample = useCallback(async () => {
    setDownloading(true);
    try {
      const res = await fetch('/api/settings/download-vrm', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        return {
          ok: false,
          error: typeof data.error === 'string' ? data.error : `HTTP ${res.status}`,
        };
      }
      notifySettingsChanged();
      return { ok: true };
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      };
    } finally {
      setDownloading(false);
    }
  }, []);

  return {
    settingsReady,
    vrmSrc,
    avatarConfig,
    vrmFailed,
    handleVrmError,
    downloadSample,
    downloading,
  };
}
