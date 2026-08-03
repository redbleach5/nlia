/**
 * EpisodesSidebar — left column. Clay & Cream aesthetic.
 */

import { useEffect, useState } from "react";
import { Plus, Trash2, MessageCircle } from "lucide-react";
import { useEpisodesStore } from "../stores/episodes.js";
import { Button } from "./ui/Button.js";

export function EpisodesSidebar() {
  const episodes = useEpisodesStore((s) => s.episodes);
  const currentEpisodeId = useEpisodesStore((s) => s.currentEpisodeId);
  const loading = useEpisodesStore((s) => s.loading);
  const error = useEpisodesStore((s) => s.error);
  const init = useEpisodesStore((s) => s.init);
  const create = useEpisodesStore((s) => s.create);
  const select = useEpisodesStore((s) => s.select);
  const remove = useEpisodesStore((s) => s.remove);
  const clearOthers = useEpisodesStore((s) => s.clearOthers);

  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    void init();
  }, [init]);

  const handleNew = () => {
    setPendingDeleteId(null);
    void create({ title: null });
  };

  const handleDeleteClick = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (pendingDeleteId === id) {
      setPendingDeleteId(null);
      void remove(id);
      return;
    }
    setPendingDeleteId(id);
  };

  const handleClearOthers = async () => {
    if (episodes.length <= 1) return;
    setClearing(true);
    try {
      await clearOthers();
      setPendingDeleteId(null);
    } finally {
      setClearing(false);
    }
  };

  return (
    <aside className="w-64 shrink-0 border-r border-[var(--color-border-soft)] flex flex-col bg-[var(--color-surface)]">
      <header className="h-12 shrink-0 px-4 border-b border-[var(--color-border-soft)] flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="flex items-baseline gap-1.5">
            <span className="font-display-italic text-[22px] font-medium text-[var(--color-fg-ink)] tracking-tight leading-none">
              Lia
            </span>
            <span className="anthropic-spark text-[16px]" aria-hidden="true">
              ✦
            </span>
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={handleNew}
          title="Новый разговор"
          aria-label="Новый разговор"
        >
          <Plus size={15} />
        </Button>
      </header>

      {error && (
        <div className="px-3 py-2 text-xs text-[var(--color-danger)] bg-[var(--color-danger-subtle)] border-b border-[var(--color-danger)]/20">
          {error}
        </div>
      )}

      <div className="px-4 pt-5 pb-2 flex items-center justify-between gap-2">
        <p className="editorial-label">Разговоры · {episodes.length}</p>
        {episodes.length > 1 && (
          <button
            type="button"
            onClick={() => void handleClearOthers()}
            disabled={clearing}
            className="text-[10px] font-mono text-[var(--color-danger)] hover:underline transition-colors disabled:opacity-50 shrink-0"
            title="Удалить все разговоры, кроме выбранного"
          >
            {clearing ? "удаляю…" : "удалить все лишние"}
          </button>
        )}
      </div>

      {episodes.length > 20 && (
        <div className="mx-2 mb-2 px-2.5 py-2 text-[11px] leading-snug rounded-[var(--radius-sm)] bg-[var(--color-warning-subtle)] text-[var(--color-fg-muted)]">
          В базе {episodes.length} чатов (в т.ч. тестовые). Нажмите «удалить все лишние», иначе список будет огромным.
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {loading && episodes.length === 0 ? (
          <p className="text-center text-xs text-[var(--color-fg-muted)] py-8 font-display italic">
            Загрузка…
          </p>
        ) : episodes.length === 0 ? (
          <div className="text-center py-12 px-3">
            <div className="w-9 h-9 mx-auto mb-3 rounded-full bg-[var(--color-surface-2)] flex items-center justify-center border border-[var(--color-border-soft)]">
              <MessageCircle size={16} className="text-[var(--color-fg-subtle)]" />
            </div>
            <p className="text-[13px] text-[var(--color-fg-muted)] font-medium font-display">
              Пока пусто
            </p>
            <p className="text-[11px] text-[var(--color-fg-faint)] mt-1 editorial-label">
              нажмите + чтобы начать
            </p>
          </div>
        ) : (
          <ul className="space-y-0.5">
            {episodes.map((ep) => {
              const isActive = ep.id === currentEpisodeId;
              const isPending = pendingDeleteId === ep.id;
              return (
                <li key={ep.id} className="relative">
                  {isActive && (
                    <span className="absolute left-0 top-2 bottom-2 w-[2px] bg-[var(--color-ember)]" />
                  )}
                  <div
                    className={`w-full pl-3 pr-1.5 py-2 rounded-[var(--radius-sm)] text-[13px] flex items-center justify-between gap-1.5 transition-colors ${
                      isActive
                        ? "bg-[var(--color-ember-subtle)] text-[var(--color-fg-ink)]"
                        : "hover:bg-[var(--color-surface-2)] text-[var(--color-fg-ink)]"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        setPendingDeleteId(null);
                        select(ep.id);
                      }}
                      className="min-w-0 flex-1 text-left"
                    >
                      <p className={`truncate ${isActive ? "font-medium" : "font-normal"}`}>
                        {ep.title || "Новый разговор"}
                      </p>
                      <p className="text-[11px] text-[var(--color-fg-faint)] mt-0.5 font-mono">
                        {ep.messageCount} сообщ.
                      </p>
                    </button>

                    {isPending ? (
                      <div className="shrink-0 flex items-center gap-0.5">
                        <button
                          type="button"
                          onClick={(e) => handleDeleteClick(ep.id, e)}
                          className="px-1.5 h-6 rounded-[var(--radius-sm)] text-[10px] font-medium bg-[var(--color-danger)] text-white"
                          aria-label="Подтвердить удаление"
                        >
                          да
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setPendingDeleteId(null);
                          }}
                          className="px-1.5 h-6 rounded-[var(--radius-sm)] text-[10px] text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-3)]"
                          aria-label="Отмена"
                        >
                          нет
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={(e) => handleDeleteClick(ep.id, e)}
                        className="shrink-0 inline-flex items-center justify-center w-7 h-7 rounded-[var(--radius-sm)] text-[var(--color-fg-subtle)] hover:text-[var(--color-danger)] hover:bg-[var(--color-danger-subtle)] transition-colors"
                        title="Удалить"
                        aria-label={`Удалить ${ep.title || "разговор"}`}
                      >
                        <Trash2 size={13} />
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <footer className="px-4 py-2.5 border-t border-[var(--color-border-soft)] flex items-center justify-between text-[10px] font-mono">
        <span className="text-[var(--color-fg-faint)] editorial-label">local · v3.0</span>
        <span
          className="w-1.5 h-1.5 rounded-full bg-[var(--color-success)]"
          title="Сервис активен"
        />
      </footer>
    </aside>
  );
}
