// Smoke tests for src/lib/kb/chunkers/document-chunker.ts
//
// Тестируют:
//   - Split by headings (с сохранением иерархии в path)
//   - Split long sections by paragraphs (с overlap)
//   - Merge too-short chunks with previous
//   - ContentHash уникальность и детерминированность
//   - Empty input edge cases

import { describe, it, expect } from 'vitest';
import { DocumentChunker, sha256, sha256Buffer } from '@/lib/kb/chunkers/document-chunker';
import type { DocumentChunkMetadata } from '@/lib/kb/types';

const SOURCE_ID = 'test-source-id';

describe('DocumentChunker', () => {
  const chunker = new DocumentChunker();

  it('returns empty array for empty input', () => {
    expect(chunker.chunk('', SOURCE_ID)).toEqual([]);
    expect(chunker.chunk('   \n\n  ', SOURCE_ID)).toEqual([]);
  });

  it('returns single chunk for plain text without headings', () => {
    const text = 'This is a paragraph.\n\nThis is another paragraph.';
    const chunks = chunker.chunk(text, SOURCE_ID);
    expect(chunks.length).toBe(1);
    expect(chunks[0].sourceId).toBe(SOURCE_ID);
    expect(chunks[0].content).toContain('This is a paragraph');
    expect(chunks[0].content).toContain('another paragraph');
    expect(chunks[0].parentId).toBeNull();
    expect(chunks[0].position).toBe(0);
  });

  it('splits by H1/H2/H3 headings and builds path hierarchy', () => {
    const md = `# Глава 1

В этой главе мы рассмотрим основные концепции и принципы, лежащие в основе системы.

## Раздел 1.1

Раздел 1.1 посвящён детальному разбору первой группы концепций, с примерами.

### Подраздел

Подраздел описывает конкретные кейсы применения изученных концепций на практике.

## Раздел 1.2

Раздел 1.2 расширяет материал предыдущего раздела и вводит дополнительные понятия.

# Глава 2

Вторая глава фокусируется на практическом применении изученного материала в реальных проектах.`;

    const chunks = chunker.chunk(md, SOURCE_ID);
    expect(chunks.length).toBeGreaterThanOrEqual(5);

    // Каждый chunk должен иметь heading в metadata
    const headings = chunks.map(c => (c.metadata as DocumentChunkMetadata).heading);
    expect(headings).toContain('Глава 1');
    expect(headings).toContain('Раздел 1.1');
    expect(headings).toContain('Подраздел');
    expect(headings).toContain('Раздел 1.2');
    expect(headings).toContain('Глава 2');

    // Path для подраздела должен содержать родительские заголовки
    const sub = chunks.find(c => (c.metadata as DocumentChunkMetadata).heading === 'Подраздел');
    expect((sub?.metadata as DocumentChunkMetadata).path).toContain('Глава 1');
    expect((sub?.metadata as DocumentChunkMetadata).path).toContain('Раздел 1.1');
    expect((sub?.metadata as DocumentChunkMetadata).path).toContain('Подраздел');
  });

  it('merges too-short chunks (< MIN_CHUNK_CHARS) with previous', () => {
    // Раздел "Короткий" содержит только 1 слово — должен слиться с предыдущим
    const md = `# Большой раздел

${'a'.repeat(300)} этот раздел достаточно длинный чтобы быть отдельным чанком.

# Короткий

tiny`;

    const chunks = chunker.chunk(md, SOURCE_ID);
    // Короткий "tiny" должен быть слит с предыдущим chunk
    expect(chunks.length).toBe(1);
    expect(chunks[0].content).toContain('tiny');
  });

  it('splits long sections by paragraphs with overlap', () => {
    // Создаём длинный раздел > MAX_CHUNK_CHARS (2000)
    const longPara1 = 'a'.repeat(800);
    const longPara2 = 'b'.repeat(800);
    const longPara3 = 'c'.repeat(800);
    const md = `# Длинный раздел

${longPara1}

${longPara2}

${longPara3}`;

    const chunks = chunker.chunk(md, SOURCE_ID);
    expect(chunks.length).toBeGreaterThan(1);

    // Каждый chunk должен начинаться с heading (мы prepend'им heading в content)
    for (const c of chunks) {
      expect(c.content).toContain('Длинный раздел');
    }

    // Chunks должны иметь возрастающие positions
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i].position).toBe(i);
    }
  });

  it('computes contentHash as SHA-256 hex (deterministic + unique)', () => {
    const text1 = 'Hello world';
    const text2 = 'Hello world';
    const text3 = 'Hello world!';

    const hash1 = sha256(text1);
    const hash2 = sha256(text2);
    const hash3 = sha256(text3);

    expect(hash1).toBe(hash2);          // same content → same hash
    expect(hash1).not.toBe(hash3);      // different content → different hash
    expect(hash1).toMatch(/^[0-9a-f]{64}$/);  // SHA-256 hex = 64 chars
  });

  it('sha256Buffer hashes binary content correctly', () => {
    const buf = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF-
    const hash = sha256Buffer(buf);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256Buffer(buf)).toBe(hash);
    expect(sha256Buffer(Buffer.from([0x50, 0x4b]))).not.toBe(hash);
  });

  it('each chunk has unique id and contentHash matches content', () => {
    const md = `# Section 1

This is the first section with enough content to clear the minimum chunk size threshold.

# Section 2

This is the second section, also with sufficient content to remain as its own chunk.`;

    const chunks = chunker.chunk(md, SOURCE_ID);
    expect(chunks.length).toBeGreaterThanOrEqual(2);

    // All ids unique
    const ids = new Set(chunks.map(c => c.id));
    expect(ids.size).toBe(chunks.length);

    // Each contentHash matches SHA-256 of content
    for (const c of chunks) {
      expect(c.contentHash).toBe(sha256(c.content));
    }
  });

  it('preserves heading in content (prepended for embedding context)', () => {
    const md = `# API Reference

GET /users endpoint description.`;

    const chunks = chunker.chunk(md, SOURCE_ID);
    expect(chunks.length).toBe(1);
    // Heading должен быть prepend'нут к content
    expect(chunks[0].content.startsWith('API Reference')).toBe(true);
    expect(chunks[0].content).toContain('GET /users');
  });

  it('handles mixed heading levels (H2 without H1)', () => {
    const md = `## Только H2

Достаточно длинный текст под заголовком H2 без родительского H1 заголовка в документе.

### Под H3

Текст под H3 заголовком, тоже достаточно длинный чтобы пройти порог минимального размера чанка.`;

    const chunks = chunker.chunk(md, SOURCE_ID);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    const h3 = chunks.find(c => (c.metadata as DocumentChunkMetadata).heading === 'Под H3');
    expect(h3).toBeDefined();
    expect((h3?.metadata as DocumentChunkMetadata).path).toContain('Только H2');
  });
});
