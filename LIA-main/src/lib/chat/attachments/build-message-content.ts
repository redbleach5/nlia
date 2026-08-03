import 'server-only';

import { readFile } from 'fs/promises';
import type { ModelMessage, UserContent } from 'ai';
import type { ResolvedChatAttachment } from './types';
import { CHAT_ATTACHMENT_MAX_TEXT_TOTAL } from './policy';
import { modelSupportsVision } from './vision';

function buildTextAttachmentBlock(attachments: ResolvedChatAttachment[]): string {
  const parts: string[] = [];
  let total = 0;

  for (const a of attachments) {
    if (a.kind === 'image' || !a.textPreview) continue;
    let chunk = a.textPreview;
    const room = CHAT_ATTACHMENT_MAX_TEXT_TOTAL - total;
    if (room <= 0) break;
    if (chunk.length > room) {
      chunk = `${chunk.slice(0, room)}\n…[обрезано]`;
    }
    total += chunk.length;
    parts.push(`### ${a.name}\n${chunk}`);
  }

  if (parts.length === 0) return '';
  return [
    'Прикреплённые файлы к этому сообщению (контекст только для этого ответа; не база знаний):',
    parts.join('\n\n'),
  ].join('\n\n');
}

/**
 * Build the final user turn for streamText — text + optional image parts.
 */
export async function buildUserModelMessage(params: {
  text: string;
  attachments: ResolvedChatAttachment[];
  modelName: string;
}): Promise<ModelMessage> {
  const { text, attachments, modelName } = params;
  const vision = modelSupportsVision(modelName);

  const fileBlock = buildTextAttachmentBlock(attachments);
  const textParts: string[] = [];
  if (text.trim()) textParts.push(text.trim());
  if (fileBlock) textParts.push(fileBlock);

  const images = attachments.filter(a => a.kind === 'image');
  if (images.length > 0 && !vision) {
    const names = images.map(i => i.name).join(', ');
    textParts.push(
      `[Изображение: ${names}. Текущая модель не поддерживает vision — опиши картинку словами или выбери vision-модель (llava, qwen2-vl и т.п.) в Настройках → Модель.]`,
    );
  }

  const combinedText = textParts.join('\n\n') || '(вложение без текста)';

  if (vision && images.length > 0) {
    const content: UserContent = [{ type: 'text', text: combinedText }];
    for (const img of images) {
      const buf = await readFile(img.absolutePath);
      content.push({
        type: 'image',
        image: buf,
        mediaType: img.mimeType,
      });
    }
    return { role: 'user', content };
  }

  return { role: 'user', content: combinedText };
}
