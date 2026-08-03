'use client';

// ============================================================================
// SourcesList — list of KB sources with action buttons.
// ============================================================================
//
// Extracted from KbTab. Renders the list of sources with status badges,
// metadata (chunks count, last indexed, error message), and per-source
// action buttons (reindex, cancel, sync, pause/resume, delete).

import { Button } from '@/components/ui/button';
import {
  FileText, FolderOpen, Code2, Link as LinkIcon,
  Loader2, RefreshCw, Trash2, AlertCircle, CheckCircle2,
  Clock, XCircle,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { sourceTypeLabel } from '@/lib/kb/types';
import type { KbSource } from './use-kb-sources';

function StatusBadge({ status }: { status: KbSource['status'] }) {
  const config = {
    idle:      { label: 'Ожидает',   icon: Clock,          cls: 'text-muted-foreground' },
    indexing:  { label: 'Индексация', icon: Loader2,       cls: 'text-warning' },
    ready:     { label: 'Готов',      icon: CheckCircle2,  cls: 'text-success' },
    error:     { label: 'Ошибка',     icon: AlertCircle,   cls: 'text-destructive' },
    paused:    { label: 'Пауза',      icon: Clock,         cls: 'text-muted-foreground' },
  }[status];

  const Icon = config.icon;
  return (
    <span className={cn('inline-flex items-center gap-1 text-[11px]', config.cls)}>
      <Icon className={cn('w-3 h-3', status === 'indexing' && 'animate-spin')} />
      {config.label}
    </span>
  );
}

function SourceIcon({ type }: { type: KbSource['type'] }) {
  if (type === 'folder') return <FolderOpen className="w-4 h-4 mt-0.5 shrink-0 text-info" />;
  if (type === 'codebase') return <Code2 className="w-4 h-4 mt-0.5 shrink-0 text-success" />;
  if (type === 'url') return <LinkIcon className="w-4 h-4 mt-0.5 shrink-0 text-accent-2" />;
  return <FileText className="w-4 h-4 mt-0.5 shrink-0 text-muted-foreground" />;
}

function formatRelativeTime(isoDate: string): string {
  const date = new Date(isoDate);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffMin < 1) return 'только что';
  if (diffMin < 60) return `${diffMin} мин назад`;
  if (diffHour < 24) return `${diffHour} ч назад`;
  if (diffDay < 7) return `${diffDay} дн назад`;
  return date.toLocaleDateString('ru-RU');
}

function parseSourceConfig(config: string): {
  folderPath?: string;
  projectPath?: string;
  fileCount?: number;
  languages?: string[];
  projectGroupId?: string;
} {
  try {
    return JSON.parse(config) as {
      folderPath?: string;
      projectPath?: string;
      fileCount?: number;
      languages?: string[];
      projectGroupId?: string;
    };
  } catch {
    return {};
  }
}

interface SourcesListProps {
  sources: KbSource[];
  actionInProgress: string | null;
  onReindex: (sourceId: string) => void;
  onCancel: (sourceId: string) => void;
  onDelete: (sourceId: string, name: string) => void;
}

export function SourcesList({
  sources, actionInProgress,
  onReindex, onCancel, onDelete,
}: SourcesListProps) {
  return (
    <div className="space-y-2">
      {sources.map(source => {
        const cfg = parseSourceConfig(source.config);
        const pathLabel = cfg.folderPath ?? cfg.projectPath;
        return (
        <div
          key={source.id}
          className="rounded-md border border-border bg-surface/50 p-3"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-2 min-w-0 flex-1">
              <SourceIcon type={source.type} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium truncate">{source.name}</span>
                  <StatusBadge status={source.status} />
                  {cfg.projectGroupId && (
                    <span
                      className="text-[10px] px-1.5 py-0.5 rounded bg-accent/10 text-accent"
                      title={`Группа проекта ${cfg.projectGroupId.slice(0, 8)}`}
                    >
                      проект
                    </span>
                  )}
                </div>
                <div className="text-[11px] text-muted-foreground mt-0.5">
                  {sourceTypeLabel(source.type)} ·{' '}
                  {source.type === 'folder'
                    ? `${source.chunkCount} в каталоге`
                    : `${source.chunkCount} chunks`}
                  {source.type === 'folder' && cfg.fileCount != null && (
                    <> · {cfg.fileCount} файлов</>
                  )}
                  {source.type === 'codebase' && (
                    <>
                      {cfg.fileCount != null && <> · {cfg.fileCount} файлов</>}
                      {cfg.languages && cfg.languages.length > 0 && (
                        <> · {cfg.languages.join(', ')}</>
                      )}
                    </>
                  )}
                  {source.lastIndexedAt && (
                    <> · последний индекс: {formatRelativeTime(source.lastIndexedAt)}</>
                  )}
                  {pathLabel && (
                    <span className="block truncate" title={pathLabel}>
                      {pathLabel}
                    </span>
                  )}
                </div>
                {source.errorMessage && (
                  <div className="text-[11px] text-destructive mt-1 line-clamp-2">
                    {source.errorMessage}
                  </div>
                )}
              </div>
            </div>
            <div className="flex gap-1 shrink-0">
              {source.status === 'indexing' && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => onCancel(source.id)}
                  disabled={actionInProgress === source.id}
                  title="Отменить индексацию"
                >
                  <XCircle className="w-3 h-3 text-warning" />
                </Button>
              )}
              {(source.status === 'ready' || source.status === 'error') && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => onReindex(source.id)}
                  disabled={actionInProgress === source.id}
                  title={
                    source.status === 'error'
                      ? 'Повторить индексацию после ошибки'
                      : 'Переиндексировать (обновить после изменения файлов)'
                  }
                >
                  {actionInProgress === source.id ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : (
                    <RefreshCw className="w-3 h-3" />
                  )}
                </Button>
              )}
              {source.status === 'indexing' && (source.type === 'folder' || source.type === 'codebase') && (
                <span className="text-[10px] text-muted-foreground px-1 self-center" title="Изменения отслеживаются автоматически">
                  авто
                </span>
              )}
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onDelete(source.id, source.name)}
                disabled={actionInProgress === source.id}
                title="Удалить"
              >
                <Trash2 className="w-3 h-3 text-destructive" />
              </Button>
            </div>
          </div>
        </div>
        );
      })}
    </div>
  );
}
