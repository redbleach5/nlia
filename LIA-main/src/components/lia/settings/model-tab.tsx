'use client';

// ============================================================================
// ModelTab — настройки Ollama (chat / agent / embed).
// ============================================================================

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Check, Loader2, AlertCircle, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { isOllamaLoopbackUrl, normalizeOllamaBaseUrl } from '@/lib/ollama-base-url';
import { isCloudModelTag } from '@/lib/ollama-cloud-tags';
import type { Settings } from './types';
import { describeEmbedModel } from './describe-embed-model';
import { LIA_APP_EVENTS, dispatchLiaAppEvent } from '@/lib/lia-app-events';

/** Embed / retrieval models must not appear in the chat picker. */
const EMBED_MODEL_RE = /embed|nomic|minilm|e5-/i;
const LOCAL_OLLAMA_URL = 'http://127.0.0.1:11434';

/** Local chat/agent only — cloud tags burn ollama.com limits with Lia system prompts. */
function isLocalChatModel(name: string): boolean {
  return !EMBED_MODEL_RE.test(name) && !isCloudModelTag(name);
}

function formatSettingsError(data: { error?: string; details?: Array<{ path?: string; message?: string }> }, status: number): string {
  if (data.error === 'validation failed' && Array.isArray(data.details) && data.details.length > 0) {
    return data.details
      .map((d) => (d.path ? `${d.path}: ${d.message ?? ''}` : (d.message ?? 'invalid')))
      .join('; ');
  }
  return data.error || `HTTP ${status}`;
}

type ModelTabProps = {
  settings: Settings;
  baseUrl: string;
  model: string;
  agentModel: string;
  secondaryModel: string;
  heavyModel: string;
  embedModel: string;
  setBaseUrl: (v: string) => void;
  setModel: (v: string) => void;
  setAgentModel: (v: string) => void;
  setSecondaryModel: (v: string) => void;
  setHeavyModel: (v: string) => void;
  setEmbedModel: (v: string) => void;
  onSaved: () => Promise<void>;
};

export function ModelTab({
  settings,
  baseUrl,
  model,
  agentModel,
  secondaryModel,
  heavyModel,
  embedModel,
  setBaseUrl,
  setModel,
  setAgentModel,
  setSecondaryModel,
  setHeavyModel,
  setEmbedModel,
  onSaved,
}: ModelTabProps) {
  const [saving, setSaving] = useState(false);
  const [claudeCodeEnabled, setClaudeCodeEnabled] = useState(!!settings.claudeCodeEnabled);
  const [claudeCodeModel, setClaudeCodeModel] = useState(settings.claudeCodeModel ?? '');
  const [ollamaApiKeyDraft, setOllamaApiKeyDraft] = useState('');
  const [apiKeyConfigured, setApiKeyConfigured] = useState(!!settings.ollamaApiKeyConfigured);

  useEffect(() => {
    setClaudeCodeEnabled(!!settings.claudeCodeEnabled);
    setClaudeCodeModel(settings.claudeCodeModel ?? '');
  }, [settings.claudeCodeEnabled, settings.claudeCodeModel]);

  useEffect(() => {
    setApiKeyConfigured(!!settings.ollamaApiKeyConfigured);
  }, [settings.ollamaApiKeyConfigured]);

  /** Pulled local tags only — never :cloud in companion pickers. */
  const chatModels = settings.availableModels.filter(isLocalChatModel);
  /** Cloud catalog — only when Claude Code is on (isolated prompts, no Lia system). */
  const cloudModels = claudeCodeEnabled
    ? (settings.availableCloudModels ?? []).filter((m) => !EMBED_MODEL_RE.test(m))
    : [];
  const effectiveBase = normalizeOllamaBaseUrl(baseUrl) ?? baseUrl;
  const isRemote = Boolean(effectiveBase) && !isOllamaLoopbackUrl(effectiveBase);
  const persist = async (overrides: {
    model?: string;
    agentModel?: string;
    secondaryModel?: string;
    heavyModel?: string;
    embedModel?: string;
    baseUrl?: string;
    claudeCodeEnabled?: boolean;
    claudeCodeModel?: string;
    ollamaApiKey?: string;
  } = {}, opts?: { quietSuccess?: boolean; connectionCheck?: boolean; silent?: boolean }) => {
    setSaving(true);
    try {
      const nextModel = overrides.model ?? model;
      const nextAgent = overrides.agentModel ?? agentModel;
      const nextSecondary = overrides.secondaryModel ?? secondaryModel;
      const nextHeavy = overrides.heavyModel ?? heavyModel;
      const nextEmbed = overrides.embedModel ?? embedModel;
      const rawBase = overrides.baseUrl ?? baseUrl;
      const normalizedBase = rawBase.trim()
        ? (normalizeOllamaBaseUrl(rawBase) ?? rawBase.trim())
        : '';
      const nextCcEnabled = overrides.claudeCodeEnabled ?? claudeCodeEnabled;
      const nextCcModel = overrides.claudeCodeModel ?? claudeCodeModel;

      if (rawBase.trim() && !normalizeOllamaBaseUrl(rawBase)) {
        throw new Error('Некорректный хост Ollama. Пример: 192.168.1.50 или http://192.168.1.50:11434');
      }

      // Cloud only via Claude Code model override — never companion chat / ReAct agent.
      if (isCloudModelTag(nextModel)) {
        throw new Error('Cloud-модели нельзя ставить на чат — включи Claude Code и выбери cloud в «Модель CC».');
      }
      if (isCloudModelTag(nextAgent)) {
        throw new Error('Cloud-модели нельзя ставить на слот агента — только в «Модель CC» при включённом Claude Code.');
      }
      if (isCloudModelTag(nextSecondary)) {
        throw new Error('Cloud-модели нельзя ставить на secondary.');
      }
      if (isCloudModelTag(nextHeavy)) {
        throw new Error('Cloud-модели нельзя ставить на heavy — только локальные теги.');
      }
      if (isCloudModelTag(nextCcModel) && !nextCcEnabled) {
        throw new Error('Cloud-модель для CC доступна только при включённом Claude Code.');
      }

      if (normalizedBase && normalizedBase !== baseUrl) {
        setBaseUrl(normalizedBase);
      }

      const body: Record<string, unknown> = {
        baseUrl: normalizedBase || undefined,
        model: nextModel,
        agentModel: nextAgent,
        secondaryModel: nextSecondary,
        heavyModel: nextHeavy,
        embedModel: nextEmbed === 'auto' ? '' : nextEmbed,
        claudeCodeEnabled: nextCcEnabled,
        claudeCodeModel: nextCcModel,
      };
      if (overrides.ollamaApiKey !== undefined) {
        body.ollamaApiKey = overrides.ollamaApiKey;
      }

      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({})) as {
        error?: string;
        details?: Array<{ path?: string; message?: string }>;
        ollamaOk?: boolean;
        ollamaError?: string;
        model?: string;
        baseUrl?: string;
        ollamaApiKeyConfigured?: boolean;
      };
      if (!res.ok) {
        throw new Error(formatSettingsError(data, res.status));
      }

      if (data.baseUrl) setBaseUrl(data.baseUrl);
      if (typeof data.ollamaApiKeyConfigured === 'boolean') {
        setApiKeyConfigured(data.ollamaApiKeyConfigured);
      }
      if (overrides.ollamaApiKey !== undefined) {
        setOllamaApiKeyDraft('');
      }

      if (!opts?.silent) {
        if (opts?.connectionCheck) {
          if (data.ollamaOk) {
            toast.success(`Ollama на связи · ${data.baseUrl || normalizedBase}`);
          } else {
            toast.warning(`Нет ответа от Ollama: ${data.ollamaError ?? 'unknown'}`);
          }
        } else if (!opts?.quietSuccess) {
          if (data.ollamaOk) {
            toast.success(`Сохранено · чат: ${data.model || nextModel}`);
          } else {
            toast.warning(`Модель записана, но Ollama не отвечает: ${data.ollamaError ?? 'unknown'}`);
          }
        } else {
          toast.success(`Модель: ${data.model || nextModel}`);
        }
      }
      await onSaved();
      dispatchLiaAppEvent(LIA_APP_EVENTS.settingsChanged);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(`Не удалось сохранить: ${msg}`);
      throw e;
    } finally {
      setSaving(false);
    }
  };

  const saveModel = async () => {
    try {
      await persist();
    } catch {
      /* toast already shown */
    }
  };

  const checkConnection = async () => {
    try {
      await persist({}, { connectionCheck: true });
    } catch {
      /* toast already shown */
    }
  };

  const useLocalHost = () => {
    setBaseUrl(LOCAL_OLLAMA_URL);
  };

  const onHostBlur = () => {
    const normalized = normalizeOllamaBaseUrl(baseUrl);
    if (normalized && normalized !== baseUrl) setBaseUrl(normalized);
  };

  const pickChatModel = async (name: string) => {
    if (name === model) return;
    setModel(name);
    try {
      await persist({ model: name }, { quietSuccess: true });
    } catch {
      /* toast already shown */
    }
  };

  const pickCcModel = async (name: string) => {
    setClaudeCodeModel(name);
    try {
      await persist({ claudeCodeModel: name }, { quietSuccess: true });
    } catch {
      /* toast already shown */
    }
  };

  const renderModelGrid = (
    models: string[],
    selected: string,
    onPick: (name: string) => void,
    keyPrefix: string,
  ) => (
    <div className="grid grid-cols-2 gap-1.5 max-h-48 overflow-y-auto">
      {models.map((m) => (
        <button
          type="button"
          key={`${keyPrefix}-${m}`}
          disabled={saving}
          onClick={() => onPick(m)}
          className={cn(
            'text-left text-xs px-2 py-1.5 rounded border transition-colors',
            selected === m
              ? 'border-accent bg-accent/10 text-accent'
              : 'border-border hover:border-accent/50',
            saving && 'opacity-60',
          )}
        >
          <div className="flex items-center justify-between gap-1">
            <span className="truncate font-mono">{m}</span>
            {selected === m && <Check className="w-3 h-3 shrink-0" />}
          </div>
        </button>
      ))}
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="rounded-md border border-border bg-surface/40 px-3 py-2 text-xs">
        <span className="text-text-dim">Сейчас в чате: </span>
        <span className="font-mono text-foreground">{model || '—'}</span>
        <span className="text-text-dim"> · Ollama{isRemote ? ' (удалённый)' : ''}</span>
      </div>

      {/* Ollama host — local or remote GPU box */}
      <div className="space-y-1.5 rounded-md border border-border bg-surface/40 p-3">
        <Label htmlFor="baseUrl" className="text-xs">Хост Ollama</Label>
        <p className="text-[10px] text-text-dim leading-relaxed">
          Лия на ноутбуке, модели на ПК с видеокартой — укажи IP этого ПК
          (например <span className="font-mono">192.168.1.50</span>).
          На том компьютере Ollama должна слушать сеть:
          <span className="font-mono"> OLLAMA_HOST=0.0.0.0 ollama serve</span>.
          Хост и модели сохраняются в настройках приложения (не в .env).
        </p>
        <Input
          id="baseUrl"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          onBlur={onHostBlur}
          placeholder="192.168.1.50 или http://192.168.1.50:11434"
          className="text-sm font-mono"
          autoComplete="off"
          spellCheck={false}
        />
        <div className="flex flex-wrap gap-1.5 pt-0.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 text-[11px] px-2"
            disabled={saving || baseUrl === LOCAL_OLLAMA_URL}
            onClick={useLocalHost}
          >
            Этот компьютер
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 text-[11px] px-2"
            disabled={saving || !baseUrl.trim()}
            onClick={() => void checkConnection()}
          >
            {saving ? (
              <Loader2 className="w-3 h-3 mr-1 animate-spin" />
            ) : (
              <RefreshCw className="w-3 h-3 mr-1" />
            )}
            Проверить связь
          </Button>
        </div>
        {isRemote && (
          <p className="text-[10px] text-text-dim">
            Для бюджета VRAM на удалённой карте задай в .env{' '}
            <span className="font-mono">LIA_INFERENCE_VRAM_GB</span> (ГБ видеокарты ПК).
          </p>
        )}
      </div>

      {/* Ollama health status */}
      <div className={cn(
        'rounded-md border p-3 text-xs flex items-center gap-2',
        settings.ollamaOk
          ? 'border-success/40 bg-success/5 text-success'
          : 'border-warning/40 bg-warning/5 text-warning',
      )}>
        <div className={cn(
          'w-2 h-2 rounded-full',
          settings.ollamaOk ? 'bg-success' : 'bg-warning',
        )} />
        <span className="flex-1">
          {settings.ollamaOk
            ? `На связи${isRemote ? ` · ${effectiveBase}` : ''} · моделей для чата: ${chatModels.length}`
            : isRemote
              ? `Нет связи с ${effectiveBase || 'удалённым хостом'}. Проверь IP, firewall и OLLAMA_HOST=0.0.0.0.`
              : 'Пока не удалось подключиться. Проверь, что Ollama запущена на этом компьютере.'}
        </span>
      </div>

      {/* Chat model — primary companion choice */}
      <div className="space-y-1.5">
        <Label className="text-xs">Модель для разговора</Label>
        <p className="text-[10px] text-text-dim">Клик по модели сразу сохраняет выбор</p>
        {chatModels.length === 0 ? (
          <p className="text-xs text-text-dim">
            Нет локальных моделей. В Ollama скачай, например, qwen3:8b
          </p>
        ) : (
          renderModelGrid(chatModels, model, (name) => { void pickChatModel(name); }, 'chat')
        )}
        <Input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="qwen3:8b"
          className="text-sm mt-1"
        />
        <p className="text-[10px] text-text-dim">
          Только локальные модели. Cloud — в Claude Code (иначе системные промпты сожрут лимиты).
          Ручной ввод — «Сохранить» ниже.
        </p>
      </div>

      <Button onClick={() => void saveModel()} disabled={saving} className="w-full" size="sm">
        {saving ? <Loader2 className="w-3 h-3 mr-1.5 animate-spin" /> : null}
        Сохранить
      </Button>

      <details className="rounded-md border border-border bg-surface/40 p-3">
        <summary className="text-xs font-medium cursor-pointer text-foreground">
          Агент и память
        </summary>
        <div className="mt-3 space-y-4">
      {/* Agent model */}
      <div className="space-y-1.5">
        <Label className="text-xs">
          Модель для агента
          <span className="text-text-dim font-normal ml-1.5">
            {claudeCodeEnabled
              ? '— модель для Claude Code (через Ollama Anthropic API)'
              : '— длинные задачи с tools (не Reasoning Distilled)'}
          </span>
        </Label>
        <p className="text-[10px] text-text-dim leading-snug -mt-0.5 mb-1">
          {claudeCodeEnabled
            ? 'При включённом Claude Code слот агента (или override ниже) передаётся как --model.'
            : 'Для Агента нужна модель с tools; Reasoning Distilled — для обычного диалога.'}
        </p>
        <div className="grid grid-cols-2 gap-1.5 max-h-40 overflow-y-auto">
          <button
            type="button"
            onClick={() => setAgentModel('')}
            className={cn(
              'text-left text-xs px-2 py-1.5 rounded border transition-colors col-span-2',
              agentModel === ''
                ? 'border-accent bg-accent/10 text-accent'
                : 'border-border hover:border-accent/50',
            )}
          >
            <div className="flex items-center justify-between gap-1">
              <span>Как у чата</span>
              {agentModel === '' && <Check className="w-3 h-3 shrink-0" />}
            </div>
            <div className="text-[10px] text-text-dim mt-0.5">
              Сейчас: {settings.agentModelEffective || model || '—'}
            </div>
          </button>
          {chatModels.map(m => (
              <button
                key={`agent-${m}`}
                type="button"
                onClick={() => setAgentModel(m)}
                className={cn(
                  'text-left text-xs px-2 py-1.5 rounded border transition-colors',
                  agentModel === m
                    ? 'border-accent bg-accent/10 text-accent'
                    : 'border-border hover:border-accent/50',
                )}
              >
                <div className="flex items-center justify-between gap-1">
                  <span className="truncate font-mono">{m}</span>
                  {agentModel === m && <Check className="w-3 h-3 shrink-0" />}
                </div>
              </button>
            ))}
        </div>
        <Input
          value={agentModel}
          onChange={(e) => setAgentModel(e.target.value)}
          placeholder="пусто = как у чата, напр. qwen3:8b"
          className="text-sm font-mono mt-1"
        />
      </div>

      {/* Secondary — trivial turns */}
      <div className="space-y-1.5">
        <Label className="text-xs">Secondary (лёгкая)</Label>
        <p className="text-[10px] text-text-dim leading-snug -mt-0.5 mb-1">
          Маленькая модель для коротких реплик вроде «привет» — быстрее и меньше греет GPU.
          Пусто = выкл (всегда модель разговора). Сейчас: {secondaryModel.trim() || 'выкл'}
        </p>
        <div className="grid grid-cols-2 gap-1.5 max-h-32 overflow-y-auto">
          <button
            type="button"
            onClick={() => { setSecondaryModel(''); void persist({ secondaryModel: '' }); }}
            className={cn(
              'text-left text-xs px-2 py-1.5 rounded border transition-colors col-span-2',
              secondaryModel === ''
                ? 'border-accent bg-accent/10 text-accent'
                : 'border-border hover:border-accent/50',
            )}
          >
            Не использовать
          </button>
          {chatModels.map(m => (
            <button
              key={`sec-${m}`}
              type="button"
              onClick={() => { setSecondaryModel(m); void persist({ secondaryModel: m }); }}
              className={cn(
                'text-left text-xs px-2 py-1.5 rounded border transition-colors',
                secondaryModel === m
                  ? 'border-accent bg-accent/10 text-accent'
                  : 'border-border hover:border-accent/50',
              )}
            >
              <span className="truncate font-mono">{m}</span>
            </button>
          ))}
        </div>
        <Input
          value={secondaryModel}
          onChange={(e) => setSecondaryModel(e.target.value)}
          placeholder="пусто = выкл"
          className="text-sm font-mono mt-1"
        />
      </div>

      {/* Heavy — escalate */}
      <div className="space-y-1.5">
        <Label className="text-xs">Heavy (тяжёлая)</Label>
        <p className="text-[10px] text-text-dim leading-snug -mt-0.5 mb-1">
          Более сильная модель только для «мозга» агента: сложный план, исследование,
          застрявший цикл. Ответ пользователю по-прежнему пишет модель разговора (голос Лии).
          В обычном чате не включается. Пусто = выкл. Сейчас: {heavyModel.trim() || 'выкл'}
        </p>
        <div className="grid grid-cols-2 gap-1.5 max-h-32 overflow-y-auto">
          <button
            type="button"
            onClick={() => { setHeavyModel(''); void persist({ heavyModel: '' }); }}
            className={cn(
              'text-left text-xs px-2 py-1.5 rounded border transition-colors col-span-2',
              heavyModel === ''
                ? 'border-accent bg-accent/10 text-accent'
                : 'border-border hover:border-accent/50',
            )}
          >
            Не использовать
          </button>
          {chatModels.map(m => (
            <button
              key={`heavy-${m}`}
              type="button"
              onClick={() => { setHeavyModel(m); void persist({ heavyModel: m }); }}
              className={cn(
                'text-left text-xs px-2 py-1.5 rounded border transition-colors',
                heavyModel === m
                  ? 'border-accent bg-accent/10 text-accent'
                  : 'border-border hover:border-accent/50',
              )}
            >
              <span className="truncate font-mono">{m}</span>
            </button>
          ))}
        </div>
        <Input
          value={heavyModel}
          onChange={(e) => setHeavyModel(e.target.value)}
          placeholder="пусто = выкл"
          className="text-sm font-mono mt-1"
        />
      </div>

      {/* Claude Code coding backend */}
      <div className="space-y-2 rounded-md border border-border/60 p-2.5">
        <div className="flex items-center justify-between gap-2">
          <Label className="text-xs">Coding: Claude Code</Label>
          <button
            type="button"
            role="switch"
            aria-checked={claudeCodeEnabled}
            disabled={saving}
            onClick={() => {
              const next = !claudeCodeEnabled;
              setClaudeCodeEnabled(next);
              const overrides: {
                claudeCodeEnabled: boolean;
                model?: string;
                agentModel?: string;
                claudeCodeModel?: string;
              } = { claudeCodeEnabled: next };
              // CC off → strip cloud so companion prompts cannot hit ollama.com.
              if (!next) {
                if (isCloudModelTag(model)) {
                  const fallback = chatModels[0] ?? '';
                  setModel(fallback);
                  overrides.model = fallback;
                }
                if (isCloudModelTag(agentModel)) {
                  setAgentModel('');
                  overrides.agentModel = '';
                }
                if (isCloudModelTag(claudeCodeModel)) {
                  setClaudeCodeModel('');
                  overrides.claudeCodeModel = '';
                }
              }
              void persist(overrides, { quietSuccess: true }).catch(() => {
                setClaudeCodeEnabled(!next);
              });
            }}
            className={cn(
              'relative h-5 w-9 rounded-full transition-colors shrink-0',
              claudeCodeEnabled ? 'bg-accent' : 'bg-border',
            )}
          >
            <span
              className={cn(
                'absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white transition-transform',
                claudeCodeEnabled && 'translate-x-4',
              )}
            />
          </button>
        </div>
        <p className="text-[10px] text-text-dim leading-snug">
          Project coding через Claude Code CLI + Ollama Anthropic Messages API.
          Cloud только здесь (без системных промптов Лии). Рекомендуется ctx ≥64k.
          Create Runtime / KB остаются у Лии.
        </p>
        <div className={cn(
          'text-[10px] flex items-center gap-1.5',
          settings.claudeBinaryOk ? 'text-success' : 'text-warning',
        )}>
          {settings.claudeBinaryOk
            ? 'Claude Code CLI найден в PATH'
            : (settings.claudeBinaryError || 'Claude Code CLI не найден — установи и перезапусти сервер')}
        </div>
        {claudeCodeEnabled && (
          <div className="space-y-2">
            <div className="space-y-1">
              <Label className="text-[10px] text-text-dim">Модель CC (пусто = слот агента)</Label>
              {cloudModels.length > 0 && (
                <div className="space-y-1">
                  <Label className="text-[10px] text-text-dim">Cloud (ollama.com)</Label>
                  <p className="text-[10px] text-text-dim leading-snug">
                    Только для Claude Code — клик сохраняет. Не для чата / ReAct.
                  </p>
                  {renderModelGrid(
                    cloudModels,
                    claudeCodeModel,
                    (name) => { void pickCcModel(name); },
                    'cc-cloud',
                  )}
                </div>
              )}
              {chatModels.length > 0 && (
                <div className="space-y-1">
                  <Label className="text-[10px] text-text-dim">Локальные (override)</Label>
                  {renderModelGrid(
                    chatModels,
                    claudeCodeModel,
                    (name) => { void pickCcModel(name); },
                    'cc-local',
                  )}
                </div>
              )}
              <Input
                value={claudeCodeModel}
                onChange={(e) => setClaudeCodeModel(e.target.value)}
                placeholder={settings.agentModelEffective || model || 'glm-4.7:cloud'}
                className="text-sm font-mono h-8"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="ollamaApiKey" className="text-[10px] text-text-dim">
                Ollama API key (cloud напрямую)
              </Label>
              <p className="text-[10px] text-text-dim leading-snug">
                Если задан и модель <span className="font-mono">*:cloud</span>, Claude Code
                ходит на <span className="font-mono">https://ollama.com</span>.
                Иначе — через хост Ollama (<span className="font-mono">ollama signin</span>).
                Ключ: ollama.com/settings/keys
                {apiKeyConfigured ? ' · сейчас сохранён' : ''}.
              </p>
              <div className="flex gap-1.5">
                <Input
                  id="ollamaApiKey"
                  type="password"
                  value={ollamaApiKeyDraft}
                  onChange={(e) => setOllamaApiKeyDraft(e.target.value)}
                  placeholder={apiKeyConfigured ? '•••••••• (новый ключ или очистить)' : 'не задан'}
                  className="text-sm font-mono h-8"
                  autoComplete="off"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8 shrink-0 text-[11px]"
                  disabled={saving || (!ollamaApiKeyDraft.trim() && !apiKeyConfigured)}
                  onClick={() => {
                    const nextKey = ollamaApiKeyDraft.trim();
                    void persist(
                      { ollamaApiKey: nextKey },
                      { silent: true },
                    ).then(() => {
                      toast.success(nextKey ? 'API key сохранён' : 'API key очищен');
                    }).catch(() => { /* toast already shown */ });
                  }}
                >
                  {ollamaApiKeyDraft.trim() ? 'Сохранить key' : 'Очистить'}
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Embed model */}
      <div className="space-y-1.5">
        <Label className="text-xs">
          Модель для памяти
          <span className="text-text-dim font-normal ml-1.5">
            — запоминает смысл разговоров (через Ollama)
          </span>
        </Label>

        <button
          type="button"
          onClick={() => setEmbedModel('auto')}
          className={cn(
            'w-full text-left text-xs px-2 py-1.5 rounded border transition-colors flex items-start gap-2',
            embedModel === 'auto'
              ? 'border-accent bg-accent/10 text-accent'
              : 'border-border hover:border-accent/50',
          )}
        >
          <div className="flex-1">
            <div className="flex items-center justify-between gap-1">
              <span className="font-medium">Авто</span>
              {embedModel === 'auto' && <Check className="w-3 h-3 shrink-0" />}
            </div>
            <div className="text-[10px] text-text-dim mt-0.5">
              Лия сама выберет подходящую модель из доступных
            </div>
          </div>
        </button>

        {settings.availableEmbedModels.length > 0 ? (
          <div className="space-y-1 max-h-40 overflow-y-auto">
            {settings.availableEmbedModels.map(m => (
              <button
                type="button"
                key={m}
                onClick={() => setEmbedModel(m)}
                className={cn(
                  'w-full text-left text-xs px-2 py-1.5 rounded border transition-colors',
                  embedModel === m
                    ? 'border-accent bg-accent/10 text-accent'
                    : 'border-border hover:border-accent/50',
                )}
              >
                <div className="flex items-center justify-between gap-1">
                  <span className="truncate font-mono">{m}</span>
                  {embedModel === m && <Check className="w-3 h-3 shrink-0" />}
                </div>
                <div className="text-[10px] text-text-dim mt-0.5">
                  {describeEmbedModel(m)}
                </div>
              </button>
            ))}
          </div>
        ) : (
          <div className="rounded border border-warning/40 bg-warning/5 p-2 text-[11px] text-warning flex items-start gap-2">
            <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>
              Не найдено моделей для памяти. Скачай в Ollama:
              <code className="font-mono ml-1">nomic-embed-text</code>,
              <code className="font-mono ml-1">bge-m3</code>.
            </span>
          </div>
        )}

        <details className="mt-1">
          <summary className="text-[10px] text-text-dim cursor-pointer hover:text-foreground">
            Указать вручную
          </summary>
          <Input
            value={embedModel === 'auto' ? '' : embedModel}
            onChange={(e) => setEmbedModel(e.target.value || 'auto')}
            placeholder="например, bge-m3:latest"
            className="text-sm font-mono mt-1"
          />
        </details>
      </div>

        </div>
      </details>

      <McpSettingsBlock />
    </div>
  );
}

function McpSettingsBlock() {
  const [servers, setServers] = useState<Array<{ id: string; name: string; enabled: boolean }>>([]);
  const [loading, setLoading] = useState(false);

  const refresh = async () => {
    try {
      const res = await fetch('/api/agent/mcp');
      if (!res.ok) return;
      const data = await res.json();
      setServers(data.servers ?? []);
    } catch { /* ignore */ }
  };

  useEffect(() => {
    void refresh();
  }, []);

  return (
    <details className="mt-3 rounded border border-border/60 p-2">
      <summary className="text-xs font-medium cursor-pointer">MCP (бонус)</summary>
      <p className="text-[10px] text-text-dim mt-1 mb-2">
        Mock MCP tools для агента. Env <code className="font-mono">LIA_MCP_ENABLED=1</code> или тоггл ниже.
        Выключение не ломает агент.
      </p>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="text-[10px] h-7 mb-2"
        disabled={loading}
        onClick={async () => {
          setLoading(true);
          await refresh();
          setLoading(false);
        }}
      >
        {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
        <span className="ml-1">Обновить</span>
      </Button>
      <div className="space-y-1">
        {servers.map((s) => (
          <label key={s.id} className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={s.enabled}
              onChange={async (e) => {
                await fetch('/api/agent/mcp', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ id: s.id, enabled: e.target.checked }),
                });
                await refresh();
              }}
            />
            <span>{s.name}</span>
            <span className="font-mono text-text-dim text-[10px]">{s.id}</span>
          </label>
        ))}
        {servers.length === 0 && (
          <p className="text-[10px] text-text-dim">Нет серверов — нажми «Обновить».</p>
        )}
      </div>
    </details>
  );
}
