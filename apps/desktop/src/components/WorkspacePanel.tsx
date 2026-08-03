/**
 * WorkspacePanel — right column: resource list + mount/upload.
 * Clay & Cream aesthetic (Anthropic-inspired).
 *
 * Signature: cream surface, clay-tinted active rows, hairline borders,
 * kind icons in subtle clay-tinted circles, status dots with semantic colors.
 */

import { useEffect, useState } from "react";
import {
  X,
  FileText,
  Folder,
  Package,
  Link as LinkIcon,
  Search,
  AlertTriangle,
  Trash2,
  Loader2,
} from "lucide-react";
import { useWorkspaceStore } from "../stores/workspace.js";
import { useEpisodesStore } from "../stores/episodes.js";
import * as api from "../lib/api.js";
import { Button } from "./ui/Button.js";
import type { Resource, ResourceLicense } from "@lia/shared";

const KIND_ICON = {
  inline: FileText,
  folder: Folder,
  codebase: Package,
  symbol: Search,
  url: LinkIcon,
} as const;

const STATUS_META: Record<string, { label: string; dot: string }> = {
  idle: { label: "ожидает", dot: "bg-[var(--color-fg-faint)]" },
  indexing: { label: "индексация…", dot: "bg-[var(--color-warning)] animate-pulse" },
  ready: { label: "готово", dot: "bg-[var(--color-success)]" },
  error: { label: "ошибка", dot: "bg-[var(--color-danger)]" },
};

export function WorkspacePanel({ onClose }: { onClose: () => void }) {
  const currentEpisodeId = useEpisodesStore((s) => s.currentEpisodeId);
  const resourcesByEpisode = useWorkspaceStore((s) => s.resourcesByEpisode);
  const loading = useWorkspaceStore((s) => s.loading);
  const error = useWorkspaceStore((s) => s.error);
  const load = useWorkspaceStore((s) => s.load);
  const attachInline = useWorkspaceStore((s) => s.attachInline);
  const mount = useWorkspaceStore((s) => s.mount);
  const remove = useWorkspaceStore((s) => s.remove);

  const [previewResource, setPreviewResource] = useState<Resource | null>(null);
  const [previewContent, setPreviewContent] = useState<string | null>(null);
  const [mountDialogOpen, setMountDialogOpen] = useState(false);

  useEffect(() => {
    if (currentEpisodeId) void load(currentEpisodeId);
  }, [currentEpisodeId, load]);

  const resources = currentEpisodeId ? resourcesByEpisode[currentEpisodeId] ?? [] : [];

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !currentEpisodeId) return;
    await attachInline(currentEpisodeId, file);
    e.target.value = "";
  };

  const handlePreview = async (resource: Resource) => {
    setPreviewResource(resource);
    setPreviewContent(null);
    try {
      const result = await api.readResource(resource.id);
      setPreviewContent(result.content);
    } catch (e) {
      setPreviewContent(`Ошибка: ${String(e)}`);
    }
  };

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!currentEpisodeId) return;
    if (confirm("Удалить этот ресурс?")) {
      await remove(currentEpisodeId, id);
      if (previewResource?.id === id) {
        setPreviewResource(null);
        setPreviewContent(null);
      }
    }
  };

  return (
    <aside className="w-80 shrink-0 border-l border-[var(--color-border-soft)] flex flex-col bg-[var(--color-surface)]">
      <header className="h-12 shrink-0 px-4 border-b border-[var(--color-border-soft)] flex items-center justify-between">
        <h2 className="editorial-label">Рабочая область</h2>
        <Button variant="ghost" size="icon" onClick={onClose} aria-label="Закрыть панель">
          <X size={15} />
        </Button>
      </header>

      {error && (
        <div className="px-3 py-2 text-xs text-[var(--color-danger)] bg-[var(--color-danger-subtle)] border-b border-[var(--color-danger)]/20">
          {error}
        </div>
      )}

      {!currentEpisodeId ? (
        <div className="flex-1 flex items-center justify-center text-[var(--color-fg-muted)] text-sm p-4 italic font-display">
          Выберите эпизод, чтобы увидеть рабочую область
        </div>
      ) : (
        <>
          {/* Add buttons */}
          <div className="px-3 py-3 border-b border-[var(--color-border-soft)] grid grid-cols-3 gap-1.5">
            <label className="cursor-pointer">
              <Button variant="primary" size="sm" className="w-full pointer-events-none">
                <FileText size={11} />
                Файл
              </Button>
              <input type="file" className="hidden" onChange={handleFileUpload} />
            </label>
            <Button variant="secondary" size="sm" onClick={() => setMountDialogOpen(true)}>
              <Folder size={11} />
              Папка
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setMountDialogOpen(true)}>
              <Package size={11} />
              Код
            </Button>
          </div>

          {/* Resource list */}
          <div className="flex-1 overflow-y-auto">
            {loading && resources.length === 0 ? (
              <div className="flex items-center justify-center gap-2 text-xs text-[var(--color-fg-muted)] py-8">
                <Loader2 size={13} className="animate-spin text-[var(--color-ember)]" />
                Загрузка…
              </div>
            ) : resources.length === 0 ? (
              <div className="text-center py-12 px-4">
                <div className="w-9 h-9 mx-auto mb-3 rounded-full bg-[var(--color-surface-2)] flex items-center justify-center border border-[var(--color-border-soft)]">
                  <Folder size={16} className="text-[var(--color-fg-subtle)]" />
                </div>
                <p className="text-[13px] text-[var(--color-fg-muted)] font-medium font-display">Пока нет ресурсов</p>
                <p className="text-[11px] text-[var(--color-fg-faint)] mt-1 editorial-label">
                  прикрепите файл или подключите папку
                </p>
              </div>
            ) : (
              <ul className="divide-y divide-[var(--color-border-soft)]">
                {resources.map((r) => {
                  const Icon = KIND_ICON[r.kind] ?? FileText;
                  const status = STATUS_META[r.status] ?? STATUS_META.idle;
                  const isGlobal = r.episodeId === null;
                  return (
                    <li
                      key={r.id}
                      onClick={() => handlePreview(r)}
                      className="px-3 py-2.5 hover:bg-[var(--color-surface-2)] cursor-pointer group transition-colors"
                    >
                      <div className="flex items-start gap-2.5">
                        <div className="w-7 h-7 shrink-0 rounded-[var(--radius-sm)] bg-[var(--color-ember-subtle)] flex items-center justify-center">
                          <Icon size={12} className="text-[var(--color-ember-deep)]" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between gap-2">
                            <p className="text-[13px] font-medium text-[var(--color-fg-ink)] truncate">
                              {r.name}
                            </p>
                            <button
                              onClick={(e) => handleDelete(r.id, e)}
                              className="opacity-0 group-hover:opacity-100 text-[var(--color-fg-muted)] hover:text-[var(--color-danger)] transition-all shrink-0"
                              aria-label="Удалить ресурс"
                            >
                              <Trash2 size={12} />
                            </button>
                          </div>
                          <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                            <span className="inline-flex items-center gap-1 text-[10px] text-[var(--color-fg-muted)]">
                              <span className={`inline-block w-1.5 h-1.5 rounded-full ${status.dot}`} />
                              {status.label}
                            </span>
                            {isGlobal && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded-[var(--radius-sm)] bg-[var(--color-surface-2)] text-[var(--color-fg-muted)] border border-[var(--color-border-soft)]">
                                глобальный
                              </span>
                            )}
                            {r.kind === "inline" && r.byteSize !== null && (
                              <span className="text-[10px] text-[var(--color-fg-faint)] font-mono">
                                {formatBytes(r.byteSize)}
                              </span>
                            )}
                            {r.config.license && r.config.license !== "Unknown" && (
                              <span className="text-[10px] text-[var(--color-fg-faint)] font-mono">
                                {r.config.license}
                              </span>
                            )}
                            {r.config.license === "Unknown" && (
                              <span
                                className="inline-flex items-center gap-0.5 text-[10px] text-[var(--color-warning)]"
                                title="Лицензия неизвестна — проверьте перед распространением"
                              >
                                <AlertTriangle size={10} />
                                лицензия?
                              </span>
                            )}
                            {r.config.distributionAllowed === false && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded-[var(--radius-sm)] bg-[var(--color-warning-subtle)] text-[var(--color-warning)] border border-[var(--color-warning)]/20">
                                локально
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </>
      )}

      {previewResource && (
        <PreviewModal
          resource={previewResource}
          content={previewContent}
          onClose={() => {
            setPreviewResource(null);
            setPreviewContent(null);
          }}
        />
      )}

      {mountDialogOpen && currentEpisodeId && (
        <MountDialog
          onMount={(req) => mount(currentEpisodeId, req)}
          onClose={() => setMountDialogOpen(false)}
        />
      )}
    </aside>
  );
}

// ─── Preview modal ──────────────────────────────────────────────────
function PreviewModal({
  resource,
  content,
  onClose,
}: {
  resource: Resource;
  content: string | null;
  onClose: () => void;
}) {
  const Icon = KIND_ICON[resource.kind] ?? FileText;
  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4 animate-fade-in"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Предпросмотр ресурса"
    >
      <div
        className="bg-[var(--color-bg)] rounded-[var(--radius-lg)] shadow-[var(--shadow-lg)] border border-[var(--color-border)] w-full max-w-2xl max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-5 py-4 border-b border-[var(--color-border-soft)] flex items-center justify-between">
          <div className="min-w-0 flex items-center gap-2.5">
            <div className="w-8 h-8 shrink-0 rounded-[var(--radius-sm)] bg-[var(--color-ember-subtle)] flex items-center justify-center">
              <Icon size={14} className="text-[var(--color-ember-deep)]" />
            </div>
            <div className="min-w-0">
              <h3 className="font-display text-[16px] font-medium text-[var(--color-fg-ink)] truncate tracking-tight">
                {resource.name}
              </h3>
              <p className="text-[11px] text-[var(--color-fg-faint)] font-mono">
                {resource.kind} · {resource.status}
                {resource.byteSize !== null && ` · ${formatBytes(resource.byteSize)}`}
              </p>
            </div>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Закрыть">
            <X size={15} />
          </Button>
        </header>
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {content === null ? (
            <div className="flex items-center gap-2 text-sm text-[var(--color-fg-muted)]">
              <Loader2 size={13} className="animate-spin text-[var(--color-ember)]" />
              Загрузка…
            </div>
          ) : (
            <pre className="text-xs font-mono whitespace-pre-wrap break-words leading-relaxed text-[var(--color-fg-ink)]">
              {content || "(пусто)"}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Mount dialog ───────────────────────────────────────────────────
function MountDialog({
  onMount,
  onClose,
}: {
  onMount: (req: import("@lia/shared").MountResourceRequest) => Promise<unknown>;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<"folder" | "codebase">("folder");
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [license, setLicense] = useState<ResourceLicense>("Unknown");
  const [distributionAllowed, setDistributionAllowed] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!path.trim()) {
      setError("Укажите путь — он обязателен");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onMount({
        kind,
        path: path.trim(),
        name: name.trim() || undefined,
        license,
        distributionAllowed,
      });
      onClose();
    } catch (err) {
      setError(String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4 animate-fade-in"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Подключить ресурс"
    >
      <div
        className="bg-[var(--color-bg)] rounded-[var(--radius-lg)] shadow-[var(--shadow-lg)] border border-[var(--color-border)] w-full max-w-md"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-5 py-4 border-b border-[var(--color-border-soft)] flex items-center justify-between">
          <h3 className="font-display text-[18px] font-medium text-[var(--color-fg-ink)] tracking-tight">
            Подключить {kind === "folder" ? "папку" : "кодовую базу"}
          </h3>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Закрыть">
            <X size={15} />
          </Button>
        </header>
        <form onSubmit={handleSubmit} className="px-5 py-5 space-y-4">
          {error && (
            <div className="rounded-[var(--radius-md)] border border-[var(--color-danger)]/40 bg-[var(--color-danger-subtle)] p-2.5 text-xs text-[var(--color-danger)]">
              {error}
            </div>
          )}

          <div className="grid grid-cols-2 gap-1.5">
            <button
              type="button"
              onClick={() => setKind("folder")}
              className={`inline-flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-[var(--radius-sm)] text-[13px] border transition-all ${
                kind === "folder"
                  ? "btn-ember border-transparent"
                  : "bg-[var(--color-surface-2)] text-[var(--color-fg-ink)] border-[var(--color-border-soft)] hover:bg-[var(--color-surface-3)]"
              }`}
            >
              <Folder size={12} />
              Папка
            </button>
            <button
              type="button"
              onClick={() => setKind("codebase")}
              className={`inline-flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-[var(--radius-sm)] text-[13px] border transition-all ${
                kind === "codebase"
                  ? "btn-ember border-transparent"
                  : "bg-[var(--color-surface-2)] text-[var(--color-fg-ink)] border-[var(--color-border-soft)] hover:bg-[var(--color-surface-3)]"
              }`}
            >
              <Package size={12} />
              Кодовая база
            </button>
          </div>

          <Field label="Путь (абсолютный)">
            <input
              type="text"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="/home/user/documents/project"
              className="w-full rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-[13px] font-mono focus:outline-none focus:border-[var(--color-ember)] focus:shadow-[0_0_0_3px_var(--color-ember-glow)] transition-all"
            />
          </Field>

          <Field label="Отображаемое имя (необязательно)">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Мой проект"
              className="w-full rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-[13px] focus:outline-none focus:border-[var(--color-ember)] focus:shadow-[0_0_0_3px_var(--color-ember-glow)] transition-all"
            />
          </Field>

          <Field label="Лицензия">
            <select
              value={license}
              onChange={(e) => setLicense(e.target.value as ResourceLicense)}
              className="w-full rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-[13px] focus:outline-none focus:border-[var(--color-ember)] focus:shadow-[0_0_0_3px_var(--color-ember-glow)] transition-all"
            >
              {["Unknown", "MIT", "Apache-2.0", "BSD-3-Clause", "CC-BY-4.0", "CC-BY-SA-4.0", "CC-BY-NC-4.0", "Proprietary"].map((l) => (
                <option key={l} value={l}>
                  {l === "Unknown" ? "Неизвестна" : l}
                </option>
              ))}
            </select>
          </Field>

          <label className="flex items-start gap-2 text-[13px] cursor-pointer">
            <input
              type="checkbox"
              checked={distributionAllowed}
              onChange={(e) => setDistributionAllowed(e.target.checked)}
              className="mt-0.5 accent-[var(--color-ember)]"
            />
            <span className="text-[var(--color-fg-muted)]">
              Разрешить распространение (может входить в собранные пакеты)
            </span>
          </label>

          <div className="flex justify-end gap-2 pt-3 border-t border-[var(--color-border-soft)]">
            <Button variant="ghost" size="md" onClick={onClose}>
              Отмена
            </Button>
            <Button variant="primary" size="md" type="submit" disabled={submitting}>
              {submitting ? "Подключаю…" : "Подключить"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="editorial-label block">{label}</label>
      {children}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}
