/**
 * SettingsDialog — modal with 4 tabs. Clay & Cream aesthetic.
 *
 * Signature: Newsreader italic for dialog title, clay-tinted tab indicator,
 * cream surface with hairline borders, clay focus rings on inputs.
 */

import { useEffect, useState } from "react";
import {
  X,
  Cpu,
  User,
  Bot,
  Info,
  Upload,
  Trash2,
  CheckCircle2,
  XCircle,
  ExternalLink,
} from "lucide-react";
import type { CapabilityProfile, ModelSlots } from "@lia/shared";
import * as api from "../lib/api.js";
import { Button } from "./ui/Button.js";

type Tab = "model" | "avatar" | "identity" | "about";

const TABS: Array<{ id: Tab; label: string; icon: typeof Cpu }> = [
  { id: "model", label: "Модель", icon: Cpu },
  { id: "avatar", label: "Аватар", icon: Bot },
  { id: "identity", label: "Личность", icon: User },
  { id: "about", label: "О программе", icon: Info },
];

export function SettingsDialog({
  open,
  onClose,
  onVrmChange,
}: {
  open: boolean;
  onClose: () => void;
  onVrmChange?: (exists: boolean) => void;
}) {
  const [tab, setTab] = useState<Tab>("model");
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4 animate-fade-in"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Настройки"
    >
      <div
        className="bg-[var(--color-bg)] rounded-[var(--radius-lg)] shadow-[var(--shadow-lg)] border border-[var(--color-border)] w-full max-w-2xl max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-6 py-5 border-b border-[var(--color-border-soft)] flex items-center justify-between">
          <div className="flex items-baseline gap-2.5">
            <h2 className="font-display-italic text-[26px] font-medium text-[var(--color-fg-ink)] tracking-tight leading-none">
              Настройки
            </h2>
            <span className="anthropic-spark text-[18px]" aria-hidden="true">✦</span>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Закрыть">
            <X size={15} />
          </Button>
        </header>

        {/* Tab bar */}
        <nav className="flex gap-0.5 px-5 py-2 border-b border-[var(--color-border-soft)]">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--radius-sm)] text-[13px] font-medium transition-all ${
                tab === id
                  ? "bg-[var(--color-ember-subtle)] text-[var(--color-ember-deep)]"
                  : "text-[var(--color-fg-muted)] hover:text-[var(--color-fg-ink)] hover:bg-[var(--color-surface-2)]"
              }`}
            >
              <Icon size={12} />
              {label}
            </button>
          ))}
        </nav>

        <div className="flex-1 overflow-y-auto px-6 py-6">
          {tab === "model" && <ModelTab />}
          {tab === "avatar" && <AvatarTab onVrmChange={onVrmChange} />}
          {tab === "identity" && <IdentityTab />}
          {tab === "about" && <AboutTab />}
        </div>

        <footer className="px-6 py-4 border-t border-[var(--color-border-soft)] flex justify-end">
          <Button variant="primary" size="md" onClick={onClose}>
            Готово
          </Button>
        </footer>
      </div>
    </div>
  );
}

// ─── Model tab ──────────────────────────────────────────────────────
function ModelTab() {
  const [slots, setSlots] = useState<ModelSlots | null>(null);
  const [capability, setCapability] = useState<CapabilityProfile | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [s, c] = await Promise.all([api.getSettings(), api.getCapability()]);
        setSlots(s);
        setCapability(c);
        setError(null);
      } catch (e) {
        setError(String(e));
      }
    })();
  }, []);

  const handleSave = async (patch: Partial<ModelSlots>) => {
    if (!slots) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await api.updateSettings(patch);
      setSlots(updated);
      const c = await api.getCapability();
      setCapability(c);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  if (error) return <div className="text-sm text-[var(--color-danger)]">{error}</div>;
  if (!slots || !capability)
    return <p className="text-sm text-[var(--color-fg-muted)] font-display italic">Загрузка…</p>;

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <SectionLabel>Состояние Ollama</SectionLabel>
        <div className="flex items-center gap-2 text-sm">
          {capability.ollamaOk ? (
            <CheckCircle2 size={15} className="text-[var(--color-success)]" />
          ) : (
            <XCircle size={15} className="text-[var(--color-danger)]" />
          )}
          <span
            className={
              capability.ollamaOk ? "text-[var(--color-success)]" : "text-[var(--color-danger)]"
            }
          >
            {capability.ollamaOk ? "Подключён" : capability.error ?? "Недоступен"}
          </span>
        </div>
        <p className="text-xs text-[var(--color-fg-muted)]">
          {capability.models.length} моделей найдено локально
        </p>
      </section>

      <section className="space-y-2">
        <SectionLabel>Адрес Ollama</SectionLabel>
        <input
          type="url"
          defaultValue={slots.baseUrl}
          key={slots.baseUrl}
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (v && v !== slots.baseUrl) void handleSave({ baseUrl: v });
          }}
          placeholder="http://127.0.0.1:11434"
          className="w-full rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-[13px] font-mono focus:outline-none focus:border-[var(--color-ember)] focus:shadow-[0_0_0_3px_var(--color-ember-glow)] transition-all"
        />
      </section>

      {(["chat", "agent", "heavy", "embed"] as const).map((slot) => (
        <ModelSlotRow
          key={slot}
          slot={slot}
          value={slots[slot]}
          models={
            slot === "embed"
              ? capability.embedModels ?? capability.models.filter((m) => /embed|nomic|minilm|e5/i.test(m))
              : capability.chatModels ?? capability.models.filter((m) => !/embed|nomic|minilm|e5/i.test(m))
          }
          effective={capability.effective[slot]}
          disabled={saving}
          onChange={(v) => void handleSave({ [slot]: v })}
        />
      ))}
    </div>
  );
}

function ModelSlotRow({
  slot,
  value,
  models,
  effective,
  disabled,
  onChange,
}: {
  slot: "chat" | "agent" | "heavy" | "embed";
  value: string;
  models: string[];
  effective: string;
  disabled: boolean;
  onChange: (v: string) => void;
}) {
  const labels: Record<typeof slot, string> = {
    chat: "Модель чата",
    agent: "Модель агента",
    heavy: "Тяжёлая модель (эскалация)",
    embed: "Модель эмбеддингов",
  };
  const hints: Record<typeof slot, string> = {
    chat: "Основная модель для диалога",
    agent: "Если пусто — используется модель чата",
    heavy: "Если пусто — без эскалации",
    embed: "Если пусто — автоматический выбор",
  };
  const emptyLabel =
    slot === "agent"
      ? "— как у чата —"
      : slot === "heavy"
      ? "— нет —"
      : slot === "embed"
      ? "— авто —"
      : null;

  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between">
        <SectionLabel>{labels[slot]}</SectionLabel>
        {value !== effective && (
          <span className="text-[11px] text-[var(--color-fg-faint)]">
            эффективная: <code className="font-mono text-[var(--color-ember-deep)]">{effective}</code>
          </span>
        )}
      </div>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="w-full rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-[13px] focus:outline-none focus:border-[var(--color-ember)] focus:shadow-[0_0_0_3px_var(--color-ember-glow)] transition-all disabled:opacity-50"
      >
        {emptyLabel !== null && <option value="">{emptyLabel}</option>}
        {models.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
        {value && !models.includes(value) && (
          <option value={value}>{value} (не загружено)</option>
        )}
      </select>
      <p className="text-[11px] text-[var(--color-fg-muted)] italic font-display">{hints[slot]}</p>
    </section>
  );
}

// ─── Avatar tab ─────────────────────────────────────────────────────
function AvatarTab({ onVrmChange }: { onVrmChange?: (exists: boolean) => void }) {
  const [vrmExists, setVrmExists] = useState(false);
  const [vrmSize, setVrmSize] = useState<number | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const checkVrm = async () => {
    try {
      const result = await api.checkVrmExists();
      setVrmExists(result.exists);
      setVrmSize(result.size ?? null);
      onVrmChange?.(result.exists);
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    void checkVrm();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refresh once when tab mounts
  }, []);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      await api.uploadVrm(file);
      await checkVrm();
    } catch (err) {
      setError(String(err));
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = async () => {
    try {
      await api.deleteVrm();
      await checkVrm();
    } catch (err) {
      setError(String(err));
    }
  };

  return (
    <div className="space-y-5">
      <section className="space-y-3">
        <SectionLabel>3D-аватар</SectionLabel>
        <p className="text-[13px] text-[var(--color-fg-muted)] leading-relaxed">
          Загрузите .vrm файл — он будет отображаться как 3D-аватар Лии. Доступны
          простая анимация дыхания и моргание. Эмоциональные выражения и lip-sync
          запланированы на следующие версии.
        </p>

        {vrmExists ? (
          <div className="rounded-[var(--radius-md)] border border-[var(--color-success)]/40 bg-[var(--color-success-subtle)] p-3.5">
            <div className="flex items-center gap-2">
              <CheckCircle2 size={14} className="text-[var(--color-success)]" />
              <p className="text-sm text-[var(--color-fg-ink)]">
                Аватар загружен
                {vrmSize !== null && (
                  <span className="text-[var(--color-fg-muted)] font-mono text-xs ml-1">
                    {(vrmSize / 1024 / 1024).toFixed(1)} МБ
                  </span>
                )}
              </p>
            </div>
            <Button variant="danger" size="sm" onClick={handleDelete} className="mt-3">
              <Trash2 size={11} />
              Удалить аватар
            </Button>
          </div>
        ) : (
          <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-6 text-center">
            <div className="w-11 h-11 mx-auto mb-3 rounded-full bg-[var(--color-ember-subtle)] flex items-center justify-center">
              <Bot size={20} className="text-[var(--color-ember-deep)]" />
            </div>
            <p className="text-sm text-[var(--color-fg-muted)] font-display">Аватар не загружен</p>
            <p className="text-xs text-[var(--color-fg-faint)] mt-1">
              Бесплатные модели — на{" "}
              <a
                href="https://vroid.com"
                target="_blank"
                rel="noreferrer"
                className="text-[var(--color-ember-deep)] hover:underline inline-flex items-center gap-0.5"
              >
                VRoid Hub
                <ExternalLink size={10} />
              </a>
            </p>
          </div>
        )}

        <label className="block">
          <span className="editorial-label block mb-1.5">
            Загрузить .vrm файл
          </span>
          <input
            type="file"
            accept=".vrm"
            onChange={handleUpload}
            disabled={uploading}
            className="block w-full text-sm text-[var(--color-fg-muted)] file:mr-3 file:py-1.5 file:px-3 file:rounded-[var(--radius-sm)] file:border-0 file:bg-[var(--color-ember)] file:text-white file:cursor-pointer file:font-medium file:text-[12px] hover:file:opacity-90 disabled:opacity-50"
          />
        </label>

        {uploading && (
          <p className="text-xs text-[var(--color-fg-muted)] flex items-center gap-1.5">
            <Upload size={11} className="animate-pulse text-[var(--color-ember)]" />
            Загрузка…
          </p>
        )}
        {error && (
          <p className="text-xs text-[var(--color-danger)] flex items-center gap-1.5">
            <XCircle size={11} />
            {error}
          </p>
        )}
      </section>
    </div>
  );
}

// ─── Identity tab ───────────────────────────────────────────────────
function IdentityTab() {
  const [userName, setUserName] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/global-facts");
        const body = await res.json();
        const nameFact = body.facts?.find((f: { key: string }) => f.key === "user.name");
        setUserName(nameFact?.value ?? "");
        setLoaded(true);
      } catch {
        setLoaded(true);
      }
    })();
  }, []);

  const saveName = async () => {
    const trimmed = userName.trim();
    if (!trimmed) return;
    try {
      await fetch("/api/global-facts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "user.name", value: trimmed }),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch {
      // non-fatal
    }
  };

  if (!loaded) return <p className="text-sm text-[var(--color-fg-muted)] font-display italic">Загрузка…</p>;

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <SectionLabel>Ваше имя</SectionLabel>
        <p className="text-[13px] text-[var(--color-fg-muted)] leading-relaxed">
          Лия запомнит его и будет использовать в разговорах на протяжении всех эпизодов.
        </p>
        <div className="flex gap-2 items-center">
          <input
            type="text"
            value={userName}
            onChange={(e) => setUserName(e.target.value)}
            onBlur={saveName}
            placeholder="Ваше имя"
            className="flex-1 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-[13px] focus:outline-none focus:border-[var(--color-ember)] focus:shadow-[0_0_0_3px_var(--color-ember-glow)] transition-all"
          />
          {saved && (
            <span className="inline-flex items-center gap-1 text-xs text-[var(--color-success)] px-2">
              <CheckCircle2 size={12} />
              Сохранено
            </span>
          )}
        </div>
      </section>

      <section className="space-y-2">
        <SectionLabel>Персона</SectionLabel>
        <p className="text-[13px] text-[var(--color-fg-muted)] leading-relaxed">
          Характер Лии описан в <code className="font-mono text-[12px] text-[var(--color-ember-deep)]">character.ts</code> и{" "}
          <code className="font-mono text-[12px] text-[var(--color-ember-deep)]">static-core.ts</code>. Пользовательская
          настройка персоны (голос, темперамент, границы) появится в следующих версиях.
        </p>
      </section>
    </div>
  );
}

// ─── About tab ──────────────────────────────────────────────────────
function AboutTab() {
  return (
    <div className="space-y-6">
      <section>
        <div className="flex items-baseline gap-2.5">
          <h3 className="font-display-italic text-[44px] font-medium text-[var(--color-fg-ink)] tracking-tight leading-none">
            Lia
          </h3>
          <span className="anthropic-spark text-[24px]" aria-hidden="true">✦</span>
          <span className="text-[var(--color-ember)] text-xs font-mono ml-1">v3.0.0</span>
        </div>
        <p className="text-[14px] text-[var(--color-fg-muted)] mt-4 leading-relaxed max-w-md">
          Локальный ИИ-компаньон: приватная работа с моделью и собственными данными,
          без облака и внешних зависимостей.
        </p>
      </section>

      <section className="space-y-2 pt-4 border-t border-[var(--color-border-soft)]">
        <SectionLabel>Стек</SectionLabel>
        <ul className="text-[13px] space-y-1 text-[var(--color-fg-muted)] font-mono">
          <li>Бэкенд: Hono · Drizzle ORM · sqlite-vec · AI SDK v7</li>
          <li>Фронтенд: React 19 · Vite · Tailwind CSS 4 · Zustand</li>
          <li>Desktop-оболочка: Tauri 2.0</li>
          <li>LLM: Ollama (локально)</li>
          <li>Аватар: three.js + @pixiv/three-vrm</li>
        </ul>
      </section>

      <section className="space-y-2 pt-4 border-t border-[var(--color-border-soft)]">
        <SectionLabel>Ссылки</SectionLabel>
        <ul className="text-[13px] space-y-1">
          <li>
            <a
              href="https://github.com/redbleach5/LIA-v3"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-[var(--color-ember-deep)] hover:underline"
            >
              GitHub: redbleach5/LIA-v3
              <ExternalLink size={11} />
            </a>
          </li>
          <li>
            <a
              href="https://ollama.com"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-[var(--color-ember-deep)] hover:underline"
            >
              Ollama
              <ExternalLink size={11} />
            </a>
          </li>
        </ul>
      </section>

      <section className="text-[11px] text-[var(--color-fg-faint)] pt-4 border-t border-[var(--color-border-soft)] leading-relaxed italic font-display">
        Аватар: дыхание + моргание. Эмоциональные выражения, lip-sync, взгляд — в планах.
      </section>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <label className="editorial-label block">{children}</label>
  );
}
