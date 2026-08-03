import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { parseBody, chatAttachmentUploadSchema } from '@/lib/infra/api-validation';
import {
  saveChatAttachmentUpload,
  CHAT_ATTACHMENT_HINT,
} from '@/lib/chat/attachments';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/chat/attachments — upload ephemeral file for the next chat message.
 * Not indexed in KB; not agent fsScope.
 */
export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const episodeId = formData.get('episodeId');
    const file = formData.get('file');

    const parsed = chatAttachmentUploadSchema.safeParse({ episodeId, file });
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? 'invalid upload', hint: CHAT_ATTACHMENT_HINT },
        { status: 400 },
      );
    }

    const { episodeId: epId, file: uploadFile } = parsed.data;
    const buffer = Buffer.from(await uploadFile.arrayBuffer());

    const result = await saveChatAttachmentUpload({
      episodeId: epId,
      originalName: uploadFile.name,
      mimeType: uploadFile.type || 'application/octet-stream',
      buffer,
    });

    if (!result.ok) {
      return NextResponse.json({ error: result.error, hint: CHAT_ATTACHMENT_HINT }, { status: 400 });
    }

    return NextResponse.json({ attachment: result.attachment });
  } catch (e) {
    logger.error('chat', 'attachment upload failed', {}, e);
    return NextResponse.json({ error: 'upload failed' }, { status: 500 });
  }
}

/** DELETE /api/chat/attachments?id= — remove pending attachment before send */
export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get('id');
  const episodeId = req.nextUrl.searchParams.get('episodeId');
  if (!id || !episodeId) {
    return NextResponse.json({ error: 'id and episodeId required' }, { status: 400 });
  }

  const row = await db.chatAttachment.findFirst({
    where: { id, episodeId, messageId: null },
  });
  if (!row) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  const { deleteChatAttachmentFile } = await import('@/lib/chat/attachments/storage');
  await deleteChatAttachmentFile(row.storageKey);
  await db.chatAttachment.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
