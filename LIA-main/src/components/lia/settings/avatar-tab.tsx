'use client';

// ============================================================================
// AvatarTab — тема, VRM-модель, простой кадр и фон.
// Тонкая настройка (свет, поза, анимации) в UI скрыта, но при сохранении
// lighting/body/animation из текущего config сохраняются (не затираются).
// ============================================================================

import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Check, Loader2, Upload, Download, RotateCcw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import {
  CAMERA_PRESETS,
  DEFAULT_AVATAR_CONFIG,
  type AvatarConfig,
  type CameraPreset,
  type BackgroundStyle,
} from '@/lib/avatar-config';
import type { Settings } from './types';
import { ThemePicker } from '../theme-picker';
import { LIA_APP_EVENTS, dispatchLiaAppEvent } from '@/lib/lia-app-events';

type AvatarTabProps = {
  settings: Settings;
  activeVrm: string | null;
  avatarConfig: AvatarConfig;
  setActiveVrm: (v: string | null) => void;
  setAvatarConfig: (v: AvatarConfig) => void;
  onSaved: () => Promise<void>;
  onUploadComplete: () => Promise<void>;
};

const FRAME_PRESETS: Array<[Exclude<CameraPreset, 'custom'>, string]> = [
  ['portrait', 'По грудь'],
  ['closeup', 'Крупный план'],
  ['fullbody', 'В полный рост'],
];

const BG_PRESETS: Array<[BackgroundStyle, string]> = [
  ['transparent', 'Прозрачный'],
  ['solid', 'Цвет'],
  ['gradient', 'Градиент'],
];

export function AvatarTab({
  settings,
  activeVrm,
  avatarConfig,
  setActiveVrm,
  setAvatarConfig,
  onSaved,
  onUploadComplete,
}: AvatarTabProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [saving, setSaving] = useState(false);

  const saveAvatar = async () => {
    setSaving(true);
    try {
      // Preserve lighting / body / animation (layout may write body; don't wipe).
      const config: AvatarConfig = {
        ...avatarConfig,
        lighting: avatarConfig.lighting ?? DEFAULT_AVATAR_CONFIG.lighting,
        body: avatarConfig.body ?? DEFAULT_AVATAR_CONFIG.body,
        animation: avatarConfig.animation ?? DEFAULT_AVATAR_CONFIG.animation,
        camera: avatarConfig.camera,
        background: avatarConfig.background,
      };
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ activeVrm, avatarConfig: config }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      setAvatarConfig(config);
      toast.success('Настройки внешнего вида сохранены');
      await onSaved();
      dispatchLiaAppEvent(LIA_APP_EVENTS.settingsChanged);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(`Не удалось сохранить: ${msg}`);
    } finally {
      setSaving(false);
    }
  };

  const resetAvatarConfig = () => {
    setAvatarConfig({ ...DEFAULT_AVATAR_CONFIG });
    toast.info('Сброшено к значениям по умолчанию. Не забудь сохранить.');
  };

  const setFrame = (id: Exclude<CameraPreset, 'custom'>) => {
    setAvatarConfig({
      ...avatarConfig,
      camera: { preset: id, ...CAMERA_PRESETS[id] },
    });
  };

  const setBgStyle = (style: BackgroundStyle) => {
    setAvatarConfig({
      ...avatarConfig,
      background: { ...avatarConfig.background, style },
    });
  };

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch('/api/settings/upload-vrm', { method: 'POST', body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      toast.success(`Модель загружена: ${data.filename}`);
      await onUploadComplete();
      dispatchLiaAppEvent(LIA_APP_EVENTS.settingsChanged);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Загрузка не удалась');
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleDownloadSample = async () => {
    try {
      const res = await fetch('/api/settings/download-vrm', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Download failed');
      toast.success(data.alreadyExisted ? 'Образ уже был готов' : 'Образ Лии готов');
      await onUploadComplete();
      dispatchLiaAppEvent(LIA_APP_EVENTS.settingsChanged);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось загрузить образ');
    }
  };

  const framePreset = avatarConfig.camera.preset === 'custom'
    ? 'portrait'
    : avatarConfig.camera.preset;

  return (
    <div className="space-y-4 min-w-0 overflow-x-hidden">
      <ThemePicker />

      <hr className="lia-divider" />

      {/* Presence model */}
      <div className="space-y-1.5">
        <Label className="text-xs">Образ Лии</Label>
        {settings.vrmFiles.length === 0 ? (
          <div className="rounded-md border border-border bg-surface/40 p-3 text-xs text-muted-foreground">
            <p className="mb-2 text-foreground/90">
              Пока нет своего образа — можно показать готовый или загрузить свой.
            </p>
            <div className="flex gap-2 flex-wrap">
              <button
                type="button"
                onClick={handleDownloadSample}
                className="flex items-center gap-1 px-2 py-1 rounded bg-accent/20 hover:bg-accent/30 text-accent transition-colors text-[11px]"
              >
                <Download className="w-3 h-3" />
                Показать готовый
              </button>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="flex items-center gap-1 px-2 py-1 rounded border border-border hover:border-accent/50 transition-colors text-[11px]"
              >
                <Upload className="w-3 h-3" />
                Загрузить свой
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="space-y-1 max-h-40 overflow-y-auto">
              {settings.vrmFiles.map(url => {
                const filename = url.split('/').pop() ?? url;
                return (
                  <button
                    type="button"
                    key={url}
                    onClick={() => setActiveVrm(url)}
                    className={cn(
                      'w-full text-left text-xs px-2 py-1.5 rounded border transition-colors flex items-center gap-2',
                      activeVrm === url
                        ? 'border-accent bg-accent/10 text-accent'
                        : 'border-border hover:border-accent/50',
                    )}
                  >
                    <span className="truncate font-mono flex-1">{filename}</span>
                    {activeVrm === url && <Check className="w-3 h-3 shrink-0" />}
                  </button>
                );
              })}
            </div>
            <div className="flex gap-2 mt-2">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="flex items-center gap-1 px-2 py-1 rounded border border-border hover:border-accent/50 text-xs transition-colors"
              >
                <Upload className="w-3 h-3" />
                Загрузить ещё
              </button>
              <button
                type="button"
                onClick={handleDownloadSample}
                className="flex items-center gap-1 px-2 py-1 rounded border border-border hover:border-accent/50 text-xs transition-colors"
              >
                <Download className="w-3 h-3" />
                Показать готовый
              </button>
            </div>
          </>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept=".vrm"
          onChange={handleUpload}
          className="hidden"
        />
        <p className="text-[10px] text-text-dim leading-relaxed pt-1">
          Свой образ — файл .vrm (например из бесплатного VRoid Studio).
        </p>
      </div>

      {/* Кадр */}
      <div className="rounded-md border border-border bg-surface/40 p-3 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Кадр
          </div>
          <button
            type="button"
            onClick={resetAvatarConfig}
            className="flex items-center gap-1 text-[10px] text-text-dim hover:text-foreground transition-colors"
            title="Сбросить кадр и фон"
          >
            <RotateCcw className="w-3 h-3" />
            Сбросить
          </button>
        </div>
        <div className="grid grid-cols-3 gap-1.5">
          {FRAME_PRESETS.map(([id, label]) => (
            <button
              type="button"
              key={id}
              onClick={() => setFrame(id)}
              className={cn(
                'text-[10px] px-1.5 py-1.5 rounded border transition-colors leading-tight text-center',
                framePreset === id
                  ? 'border-accent bg-accent/10 text-accent'
                  : 'border-border hover:border-accent/50',
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Фон */}
      <div className="rounded-md border border-border bg-surface/40 p-3 space-y-2">
        <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Фон
        </div>
        <div className="grid grid-cols-3 gap-1.5">
          {BG_PRESETS.map(([id, label]) => (
            <button
              type="button"
              key={id}
              onClick={() => setBgStyle(id)}
              className={cn(
                'text-[10px] px-1.5 py-1.5 rounded border transition-colors leading-tight text-center',
                avatarConfig.background.style === id
                  ? 'border-accent bg-accent/10 text-accent'
                  : 'border-border hover:border-accent/50',
              )}
            >
              {label}
            </button>
          ))}
        </div>
        {avatarConfig.background.style !== 'transparent' && (
          <div className="flex items-center gap-3 pt-1">
            <label className="flex items-center gap-2 text-[10px] text-muted-foreground">
              Цвет
              <Input
                type="color"
                value={avatarConfig.background.color}
                onChange={e => setAvatarConfig({
                  ...avatarConfig,
                  background: { ...avatarConfig.background, color: e.target.value },
                })}
                className="h-8 w-12 p-1 cursor-pointer"
              />
            </label>
            {avatarConfig.background.style === 'gradient' && (
              <label className="flex items-center gap-2 text-[10px] text-muted-foreground">
                Края
                <Input
                  type="color"
                  value={avatarConfig.background.edgeColor}
                  onChange={e => setAvatarConfig({
                    ...avatarConfig,
                    background: { ...avatarConfig.background, edgeColor: e.target.value },
                  })}
                  className="h-8 w-12 p-1 cursor-pointer"
                />
              </label>
            )}
          </div>
        )}
      </div>

      <Button onClick={saveAvatar} disabled={saving} className="w-full" size="sm">
        {saving ? <Loader2 className="w-3 h-3 mr-1.5 animate-spin" /> : null}
        Сохранить
      </Button>
    </div>
  );
}
