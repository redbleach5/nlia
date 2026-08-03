'use client';

import { useRef } from 'react';
import type { ChatAttachmentMeta } from '@/stores/chat-store';
import { cn } from '@/lib/utils';
import { Paperclip, X, FileText, FileType, ImageIcon, Loader2 } from 'lucide-react';

const CHAT_ATTACHMENT_ACCEPT = '.jpg,.jpeg,.png,.webp,.gif,.txt,.md,.pdf,.docx';

function attachmentHref(id: string, episodeId: string): string {
  return `/api/chat/attachments/${id}?episodeId=${encodeURIComponent(episodeId)}`;
}

function FileKindIcon({ kind }: { kind: ChatAttachmentMeta['kind'] }) {
  if (kind === 'image') return <ImageIcon className="size-3.5 shrink-0" />;
  if (kind === 'pdf') return <FileType className="size-3.5 shrink-0" />;
  return <FileText className="size-3.5 shrink-0" />;
}

export function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

/** Paperclip — иконка-кнопка в тулбаре composer (рядом с режимом). */
export function ChatAttachButton({
  onPickFiles,
  disabled,
  uploading,
}: {
  onPickFiles: (files: FileList | null) => void;
  disabled?: boolean;
  uploading?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <>
      <button
        type="button"
        disabled={disabled || uploading}
        title="Прикрепить файл к сообщению"
        aria-label="Прикрепить файл"
        onClick={() => inputRef.current?.click()}
        className={cn(
          'inline-flex h-8 w-8 items-center justify-center rounded-lg',
          'text-muted-foreground hover:text-foreground hover:bg-surface-2/80',
          'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
          'disabled:pointer-events-none disabled:opacity-40',
        )}
      >
        {uploading
          ? <Loader2 className="size-3.5 animate-spin" />
          : <Paperclip className="size-3.5" />}
      </button>
      <input
        ref={inputRef}
        type="file"
        className="sr-only"
        accept={CHAT_ATTACHMENT_ACCEPT}
        multiple
        disabled={disabled || uploading}
        onChange={e => {
          onPickFiles(e.target.files);
          e.target.value = '';
        }}
      />
    </>
  );
}

/** Чипы pending-вложений над textarea внутри composer. */
export function PendingAttachmentChips({
  pending,
  episodeId,
  onRemove,
  disabled,
}: {
  pending: ChatAttachmentMeta[];
  episodeId: string | null;
  onRemove: (id: string) => void;
  disabled?: boolean;
}) {
  if (pending.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2 px-3 pt-3 pb-0">
      {pending.map(a => {
        const href = episodeId ? attachmentHref(a.id, episodeId) : null;
        const isImage = a.kind === 'image' && href;

        return (
          <div
            key={a.id}
            className={cn(
              'group relative flex items-center gap-2 rounded-lg border border-border/70 bg-background/70',
              'max-w-[220px] overflow-hidden',
              isImage ? 'p-1 pr-7' : 'px-2.5 py-1.5 pr-7',
            )}
          >
            {isImage ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={href}
                alt={a.name}
                className="size-10 rounded-md object-cover shrink-0 bg-surface-2"
              />
            ) : (
              <span className="text-muted-foreground">
                <FileKindIcon kind={a.kind} />
              </span>
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate text-[11px] font-medium leading-tight text-foreground">{a.name}</p>
              <p className="text-[10px] text-text-dim leading-tight mt-0.5">
                {formatAttachmentSize(a.sizeBytes)}
              </p>
            </div>
            <button
              type="button"
              disabled={disabled}
              onClick={() => onRemove(a.id)}
              aria-label={`Убрать ${a.name}`}
              className={cn(
                'absolute top-1 right-1 flex size-5 items-center justify-center rounded-full',
                'bg-surface text-muted-foreground hover:text-foreground hover:bg-surface-2',
                'border border-border/60 shadow-xs',
                'disabled:opacity-40',
              )}
            >
              <X className="size-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

/** Вложения внутри пузыря сообщения пользователя. */
export function MessageAttachmentList({
  attachments,
  episodeId,
}: {
  attachments: ChatAttachmentMeta[];
  episodeId: string;
}) {
  if (!attachments.length) return null;

  const images = attachments.filter(a => a.kind === 'image');
  const files = attachments.filter(a => a.kind !== 'image');

  return (
    <div className="flex flex-col gap-2">
      {images.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {images.map(a => {
            const href = attachmentHref(a.id, episodeId);
            return (
              <a
                key={a.id}
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="block overflow-hidden rounded-lg border border-border/50 bg-background/40"
                title={a.name}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={href}
                  alt={a.name}
                  className="max-h-40 max-w-[220px] object-cover"
                />
              </a>
            );
          })}
        </div>
      )}
      {files.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {files.map(a => (
            <a
              key={a.id}
              href={attachmentHref(a.id, episodeId)}
              target="_blank"
              rel="noopener noreferrer"
              className={cn(
                'inline-flex items-center gap-1.5 rounded-lg border border-border/60',
                'bg-background/60 px-2.5 py-1.5 text-[11px] text-foreground',
                'hover:border-accent/40 hover:bg-background transition-colors',
              )}
            >
              <span className="text-accent">
                <FileKindIcon kind={a.kind} />
              </span>
              <span className="truncate max-w-[160px] font-medium">{a.name}</span>
              <span className="text-text-dim shrink-0">{formatAttachmentSize(a.sizeBytes)}</span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
