import 'server-only';

import { join } from 'path';
import { PATHS } from '@/lib/paths';
import { db } from '@/lib/db';
import type { ChatAttachmentMeta, ResolvedChatAttachment } from './types';
import { CHAT_ATTACHMENT_MAX_COUNT } from './policy';

export function metaFromRow(row: {
  id: string;
  originalName: string;
  mimeType: string;
  kind: string;
  sizeBytes: number;
}): ChatAttachmentMeta {
  return {
    id: row.id,
    name: row.originalName,
    mimeType: row.mimeType,
    kind: row.kind as ChatAttachmentMeta['kind'],
    sizeBytes: row.sizeBytes,
  };
}

/**
 * Load pending (unlinked) attachments for this send, same episode only.
 */
export async function resolvePendingChatAttachments(
  episodeId: string,
  attachmentIds: string[] | undefined,
): Promise<{ ok: true; attachments: ResolvedChatAttachment[] } | { ok: false; error: string }> {
  if (!attachmentIds || attachmentIds.length === 0) {
    return { ok: true, attachments: [] };
  }
  const unique = [...new Set(attachmentIds)];
  if (unique.length > CHAT_ATTACHMENT_MAX_COUNT) {
    return { ok: false, error: `Не больше ${CHAT_ATTACHMENT_MAX_COUNT} вложений.` };
  }

  const rows = await db.chatAttachment.findMany({
    where: {
      id: { in: unique },
      episodeId,
      messageId: null,
    },
  });

  if (rows.length !== unique.length) {
    return { ok: false, error: 'Одно или несколько вложений недоступны (устарели или из другого чата).' };
  }

  const attachments: ResolvedChatAttachment[] = rows.map(r => ({
    ...metaFromRow(r),
    storageKey: r.storageKey,
    textPreview: r.textPreview,
    absolutePath: join(PATHS.artifacts, r.storageKey),
  }));

  return { ok: true, attachments };
}

export async function linkAttachmentsToMessage(
  messageId: string,
  attachmentIds: string[],
): Promise<void> {
  if (attachmentIds.length === 0) return;
  await db.chatAttachment.updateMany({
    where: { id: { in: attachmentIds }, messageId: null },
    data: { messageId },
  });
}

export function parseAttachmentsJson(json: string | null | undefined): ChatAttachmentMeta[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (x): x is ChatAttachmentMeta =>
        !!x &&
        typeof x === 'object' &&
        typeof (x as ChatAttachmentMeta).id === 'string' &&
        typeof (x as ChatAttachmentMeta).name === 'string',
    );
  } catch {
    return [];
  }
}
