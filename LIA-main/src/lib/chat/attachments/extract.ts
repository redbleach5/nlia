import 'server-only';

import { readFile } from 'fs/promises';
import { parseKbFile } from '@/lib/kb/indexer';
import type { ChatAttachmentKind } from './types';
import {
  CHAT_ATTACHMENT_MAX_TEXT_PER_FILE,
} from './policy';

/**
 * Extract text for prompt injection (text/pdf/docx). Images return null.
 */
export async function extractChatAttachmentText(
  absolutePath: string,
  mimeType: string,
  kind: ChatAttachmentKind,
): Promise<string | null> {
  if (kind === 'image') return null;

  try {
    const full = await parseKbFile(absolutePath, mimeType, AbortSignal.timeout(60_000));
    const trimmed = full.trim();
    if (!trimmed) return null;
    return trimmed.length > CHAT_ATTACHMENT_MAX_TEXT_PER_FILE
      ? `${trimmed.slice(0, CHAT_ATTACHMENT_MAX_TEXT_PER_FILE)}\n…[обрезано для контекста сообщения]`
      : trimmed;
  } catch {
    if (kind === 'text') {
      try {
        const raw = await readFile(absolutePath, 'utf-8');
        const trimmed = raw.trim();
        if (!trimmed) return null;
        return trimmed.length > CHAT_ATTACHMENT_MAX_TEXT_PER_FILE
          ? `${trimmed.slice(0, CHAT_ATTACHMENT_MAX_TEXT_PER_FILE)}\n…[обрезано]`
          : trimmed;
      } catch {
        return null;
      }
    }
    return null;
  }
}
