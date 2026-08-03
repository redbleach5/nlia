import { describe, it, expect } from 'vitest';
import { modelSupportsVision } from '@/lib/chat/attachments/vision';
import { kindForMime, CHAT_ATTACHMENT_MAX_COUNT } from '@/lib/chat/attachments/policy';

describe('chat attachments policy', () => {
  it('maps allowed mime types', () => {
    expect(kindForMime('image/png')).toBe('image');
    expect(kindForMime('application/pdf')).toBe('pdf');
    expect(kindForMime('application/zip')).toBeNull();
  });

  it('detects vision-capable model names', () => {
    expect(modelSupportsVision('llava:7b')).toBe(true);
    expect(modelSupportsVision('qwen2.5:7b')).toBe(false);
  });

  it('caps attachment count constant', () => {
    expect(CHAT_ATTACHMENT_MAX_COUNT).toBeGreaterThan(0);
  });
});

describe('buildUserModelMessage', () => {
  it('injects text file preview into user content', async () => {
    const { buildUserModelMessage } = await import('@/lib/chat/attachments/build-message-content');
    const msg = await buildUserModelMessage({
      text: 'Что здесь?',
      modelName: 'qwen2.5:7b',
      attachments: [{
        id: 'a1',
        name: 'note.txt',
        mimeType: 'text/plain',
        kind: 'text',
        sizeBytes: 10,
        storageKey: 'k',
        textPreview: 'Hello world',
        absolutePath: '/tmp/x',
      }],
    });
    expect(msg.role).toBe('user');
    const content = typeof msg.content === 'string' ? msg.content : '';
    expect(content).toContain('Hello world');
    expect(content).toContain('note.txt');
  });
});
