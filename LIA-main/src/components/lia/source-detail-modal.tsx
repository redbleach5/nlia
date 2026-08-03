'use client';

// ============================================================================
// SourceDetailModal — модалка с полным контентом source.
// ============================================================================
//
// Открывается:
//   - Из KbSidebar при клике на source или search result
//   - Из markdown-renderer при клике на citation badge [Source > Heading]
//
// Показывает:
//   - Header: имя source, тип, статус, chunkCount
//   - Body: scrollable список всех chunks (content + metadata)

import { useEffect, useState, useRef } from 'react';
import { Loader2, FileText } from 'lucide-react';
import { sourceTypeLabel, type SourceType } from '@/lib/kb/types';
import { cn } from '@/lib/utils';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface SourceDetailModalProps {
  sourceId: string;
  onClose: () => void;
  /** Опционально — подсветить конкретный chunk (например, при клике на citation) */
  highlightChunkId?: string;
}

interface ChunkDetail {
  id: string;
  content: string;
  metadata: {
    heading?: string;
    path?: string;
    sectionIndex?: number;
    author?: string;
    createdAt?: string;
    updatedAt?: string;
  };
  position: number;
  parentId: string | null;
}

interface SourceInfo {
  id: string;
  name: string;
  type: SourceType;
  status: string;
  chunkCount: number;
  lastIndexedAt: string | null;
  errorMessage: string | null;
}

export function SourceDetailModal({ sourceId, onClose, highlightChunkId }: SourceDetailModalProps) {
  const [source, setSource] = useState<SourceInfo | null>(null);
  const [chunks, setChunks] = useState<ChunkDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const highlightRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const [sourceRes, chunksRes] = await Promise.all([
          fetch(`/api/kb/sources/${sourceId}`),
          fetch(`/api/kb/sources/${sourceId}/chunks`),
        ]);

        if (!sourceRes.ok) {
          throw new Error(`Failed to load source: ${sourceRes.status}`);
        }
        if (!chunksRes.ok) {
          throw new Error(`Failed to load chunks: ${chunksRes.status}`);
        }

        const sourceData = await sourceRes.json();
        const chunksData = await chunksRes.json();

        if (cancelled) return;

        setSource(sourceData.source);
        setChunks(chunksData.chunks ?? []);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Не удалось загрузить');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [sourceId]);

  // Phase 6: scroll highlighted chunk into view after load
  useEffect(() => {
    if (loading || !highlightChunkId) return;
    const t = window.setTimeout(() => {
      highlightRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 50);
    return () => window.clearTimeout(t);
  }, [loading, highlightChunkId, chunks.length]);

  return (
    <Dialog open onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }}>
      <DialogContent
        className="flex max-h-[85vh] w-full max-w-3xl flex-col gap-0 overflow-hidden border-border bg-popover p-0"
      >
        {/* Header */}
        <DialogHeader className="shrink-0 border-b border-border p-4 pr-12 text-left">
          <div className="flex min-w-0 items-center gap-2">
            <FileText className="w-4 h-4 text-accent-2 shrink-0" />
            <div className="min-w-0">
              <DialogTitle className="truncate text-sm font-medium">
                {source?.name ?? 'Загрузка…'}
              </DialogTitle>
              {source && (
                <DialogDescription className="text-[10px] text-muted-foreground">
                  {sourceTypeLabel(source.type)} ·{' '}
                  {source.chunkCount} фрагментов · {source.status}
                  {source.lastIndexedAt && (
                    <> · {new Date(source.lastIndexedAt).toLocaleDateString('ru-RU')}</>
                  )}
                  {highlightChunkId && (
                    <> · <span className="text-accent">фрагмент</span></>
                  )}
                </DialogDescription>
              )}
              {!source && (
                <DialogDescription className="sr-only">
                  Загрузка содержимого источника базы знаний
                </DialogDescription>
              )}
            </div>
          </div>
        </DialogHeader>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-5 h-5 animate-spin text-accent" />
            </div>
          ) : error ? (
            <div className="text-sm text-destructive p-4" role="alert">{error}</div>
          ) : chunks.length === 0 ? (
            <div className="text-sm text-muted-foreground p-4 text-center">
              В источнике нет чанков. Возможно, индексация ещё не завершена.
            </div>
          ) : (
            <div className="space-y-3">
              {chunks.map(chunk => (
                <div
                  key={chunk.id}
                  ref={chunk.id === highlightChunkId ? highlightRef : undefined}
                >
                  <ChunkCard
                    chunk={chunk}
                    highlighted={chunk.id === highlightChunkId}
                  />
                </div>
              ))}
            </div>
          )}
        </div>

        {source?.errorMessage && (
          <div className="p-3 border-t border-border bg-destructive/5 shrink-0">
            <div className="text-[11px] text-destructive">
              <strong>Ошибка:</strong> {source.errorMessage}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ============================================================================
// ChunkCard — один чанк в списке
// ============================================================================

function ChunkCard({ chunk, highlighted }: { chunk: ChunkDetail; highlighted: boolean }) {
  const meta = chunk.metadata;

  return (
    <div
      className={cn(
        'rounded-md border p-3 transition-colors',
        highlighted
          ? 'border-accent bg-accent/5'
          : 'border-border bg-surface/50',
      )}
    >
      {/* Metadata header */}
      <div className="flex items-center gap-2 mb-2 flex-wrap">
        {meta.heading && (
          <span className="text-[10px] text-muted-foreground truncate">
            {meta.path ? `${meta.path} > ` : ''}{meta.heading}
          </span>
        )}
        {meta.author && (
          <span className="text-[10px] text-muted-foreground">
            by {meta.author}
          </span>
        )}
      </div>

      {/* Content */}
      <pre className="text-xs whitespace-pre-wrap font-sans leading-relaxed text-foreground">
        {chunk.content}
      </pre>

      {/* Footer */}
      {meta.updatedAt && (
        <div className="text-[9px] text-text-dim mt-2">
          обновлён: {new Date(meta.updatedAt).toLocaleString('ru-RU')}
        </div>
      )}
      {!meta.updatedAt && meta.createdAt && (
        <div className="text-[9px] text-text-dim mt-2">
          создан: {new Date(meta.createdAt).toLocaleString('ru-RU')}
        </div>
      )}
    </div>
  );
}
