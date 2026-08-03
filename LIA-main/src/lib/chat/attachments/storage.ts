import 'server-only';

import { randomUUID } from 'crypto';
import { mkdir, writeFile, unlink, rm } from 'fs/promises';
import { join } from 'path';
import { PATHS } from '@/lib/paths';
import { db } from '@/lib/db';
import { extractChatAttachmentText } from './extract';
import {
  CHAT_ATTACHMENT_MAX_BYTES,
  CHAT_ATTACHMENT_MAX_COUNT,
  kindForMime,
} from './policy';
import type { ChatAttachmentMeta } from './types';

function sanitizeFilename(name: string): string {
  const base = name.replace(/[/\\?%*:|"<>]/g, '_').replace(/\s+/g, ' ').trim();
  return base.slice(0, 120) || 'file';
}

function mimeFromFilename(name: string): string | null {
  const ext = name.toLowerCase().split('.').pop();
  const map: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    gif: 'image/gif',
    txt: 'text/plain',
    md: 'text/markdown',
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  };
  return ext ? map[ext] ?? null : null;
}

export async function saveChatAttachmentUpload(params: {
  episodeId: string;
  originalName: string;
  mimeType: string;
  buffer: Buffer;
}): Promise<{ ok: true; attachment: ChatAttachmentMeta } | { ok: false; error: string }> {
  const { episodeId, originalName, buffer } = params;
  let mimeType = params.mimeType;
  if (!mimeType || mimeType === 'application/octet-stream') {
    mimeType = mimeFromFilename(originalName) ?? mimeType;
  }

  const kind = kindForMime(mimeType);
  if (!kind) {
    return { ok: false, error: 'Тип файла не поддерживается для вложений в чат.' };
  }
  if (buffer.byteLength > CHAT_ATTACHMENT_MAX_BYTES) {
    return { ok: false, error: `Файл слишком большой (макс. ${CHAT_ATTACHMENT_MAX_BYTES / (1024 * 1024)} МБ).` };
  }

  const pendingCount = await db.chatAttachment.count({
    where: { episodeId, messageId: null },
  });
  if (pendingCount >= CHAT_ATTACHMENT_MAX_COUNT) {
    return { ok: false, error: `Не больше ${CHAT_ATTACHMENT_MAX_COUNT} вложений на одно сообщение.` };
  }

  const episode = await db.episode.findUnique({ where: { id: episodeId }, select: { id: true } });
  if (!episode) {
    return { ok: false, error: 'Чат не найден.' };
  }

  const id = randomUUID().replace(/-/g, '').slice(0, 16);

  const safeName = sanitizeFilename(originalName);
  const storageKey = join('chat-attachments', episodeId, `${id}_${safeName}`);
  const absolutePath = join(PATHS.artifacts, storageKey);

  await mkdir(join(PATHS.artifacts, 'chat-attachments', episodeId), { recursive: true });
  await writeFile(absolutePath, buffer);

  const textPreview = await extractChatAttachmentText(absolutePath, mimeType, kind);

  const row = await db.chatAttachment.create({
    data: {
      id,
      episodeId,
      originalName: safeName,
      mimeType,
      sizeBytes: buffer.byteLength,
      kind,
      storageKey: storageKey.replace(/\\/g, '/'),
      textPreview,
    },
  });

  return {
    ok: true,
    attachment: {
      id: row.id,
      name: row.originalName,
      mimeType: row.mimeType,
      kind: row.kind as ChatAttachmentMeta['kind'],
      sizeBytes: row.sizeBytes,
    },
  };
}

export async function deleteChatAttachmentFile(storageKey: string): Promise<void> {
  const absolutePath = join(PATHS.artifacts, storageKey);
  try {
    await unlink(absolutePath);
  } catch {
    /* already gone */
  }
}

export async function deleteEpisodeChatAttachmentFiles(episodeId: string): Promise<void> {
  const dir = join(PATHS.artifacts, 'chat-attachments', episodeId);
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    /* non-fatal */
  }
}
