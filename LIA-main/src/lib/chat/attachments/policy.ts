import 'server-only';

/** Max files per single chat message. */
export const CHAT_ATTACHMENT_MAX_COUNT = 5;

/** Per-file size (ephemeral turn context — smaller than KB uploads). */
export const CHAT_ATTACHMENT_MAX_BYTES = 8 * 1024 * 1024;

/** Max extracted text injected into one message (all files combined). */
export const CHAT_ATTACHMENT_MAX_TEXT_TOTAL = 24_000;

/** Per-file extract cap before merge. */
export const CHAT_ATTACHMENT_MAX_TEXT_PER_FILE = 12_000;

import type { ChatAttachmentKind } from './types';

const ALLOWED: Record<string, ChatAttachmentKind> = {
  'image/jpeg': 'image',
  'image/png': 'image',
  'image/webp': 'image',
  'image/gif': 'image',
  'text/plain': 'text',
  'text/markdown': 'text',
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
};

export function kindForMime(mimeType: string): ChatAttachmentKind | null {
  return ALLOWED[mimeType] ?? null;
}

export function isAllowedChatAttachmentMime(mimeType: string): boolean {
  return kindForMime(mimeType) !== null;
}

export const CHAT_ATTACHMENT_ACCEPT =
  '.jpg,.jpeg,.png,.webp,.gif,.txt,.md,.pdf,.docx';

export const CHAT_ATTACHMENT_HINT =
  'Краткий контекст к сообщению (до 8 МБ). Для постоянной базы документов — Настройки → База. Для файлов проекта — режим Агента.';
