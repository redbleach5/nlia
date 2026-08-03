import 'server-only';

// ============================================================================
// DocumentChunker — semantic chunking для Markdown и TXT файлов.
// ============================================================================
//
// Стратегия: Semantic Chunking с parent-child иерархией.
//
//   1. Разрезаем по заголовкам (#, ##, ### ...). Каждый раздел получает
//      heading + path (например "Глава 1 > Раздел 1.2 > Подраздел").
//   2. Если раздел длиннее MAX_CHUNK_CHARS — режем по параграфам (\n\n)
//      с OVERLAP_CHARS на границах, чтобы не разрывать предложения.
//   3. Если чанк короче MIN_CHUNK_CHARS — сливаем с предыдущим.
//   4. contentHash (SHA-256) на content — для дедупликации при реиндексации.
//
// Поддерживаемые форматы:
//   - .md / .markdown — нативный парсинг заголовков
//   - .txt — нет заголовков, только параграфовое разбиение
//   - .text — то же что .txt
//   - .pdf / .docx — через indexer (pdf-parse / mammoth → markdown)

import { createHash } from 'crypto';
import type { Chunk, DocumentChunkMetadata } from '../types';

export interface DocumentSection {
  heading: string;
  path: string;        // "Глава 1 > Раздел 1.2"
  content: string;
  charStart: number;
  charEnd: number;
}

export class DocumentChunker {
  private readonly MAX_CHUNK_CHARS = 2000;
  private readonly MIN_CHUNK_CHARS = 50;
  private readonly OVERLAP_CHARS = 200;

  /**
   * Разбить документ на чанки.
   *
   * @param markdown  сырой текст документа (Markdown или plain text)
   * @param sourceId  ID источника (Source.id) — для заполнения Chunk.sourceId
   * @returns массив чанков (минимум 1 для непустого документа, 0 для пустого)
   */
  chunk(markdown: string, sourceId: string): Chunk[] {
    // Trim BOM и trailing whitespace — не информативны для поиска
    const text = markdown.replace(/^\uFEFF/, '').replace(/\s+$/, '');
    if (text.length === 0) return [];

    const sections = this.splitByHeadings(text);
    const chunks: Chunk[] = [];

    for (const section of sections) {
      const subChunks = section.content.length > this.MAX_CHUNK_CHARS
        ? this.splitByParagraphs(section.content, this.MAX_CHUNK_CHARS, this.OVERLAP_CHARS)
        : [section.content];

      subChunks.forEach((content, i) => {
        // Prepend heading to content (помогает embedding модели понять контекст)
        const fullContent = section.heading
          ? `${section.heading}\n\n${content}`.trim()
          : content.trim();

        if (fullContent.length === 0) return;

        // Слишком короткий — сливаем с предыдущим (если есть)
        if (fullContent.length < this.MIN_CHUNK_CHARS && chunks.length > 0) {
          const prev = chunks[chunks.length - 1];
          prev.content = prev.content + '\n\n' + fullContent;
          // Пересчитать hash, т.к. content изменился
          prev.contentHash = sha256(prev.content);
          return;
        }

        const metadata: DocumentChunkMetadata = {
          heading: section.heading || undefined,
          path: section.path || undefined,
          sectionIndex: i,
          charStart: section.charStart,
          charEnd: section.charEnd,
        };

        chunks.push({
          id: crypto.randomUUID(),
          sourceId,
          content: fullContent,
          contentHash: sha256(fullContent),
          metadata,
          parentId: null,
          position: chunks.length,
          summary: null,
        });
      });
    }

    return chunks;
  }

  /**
   * Разбить текст по Markdown-заголовкам (#{1,6} Title).
   *
   * Сохраняет иерархию в `path` — например "Глава 1 > Раздел 1.2 > Подраздел".
   * Для plain text (без заголовков) возвращает один section со всем текстом.
   *
   * charStart / charEnd — это смещения в оригинальном text, для отображения
   * в UI "перейти к месту в документе".
   */
  private splitByHeadings(text: string): DocumentSection[] {
    const lines = text.split('\n');
    const sections: DocumentSection[] = [];
    const headingStack: string[] = [];
    let currentHeading = '';
    let currentContent: string[] = [];
    let currentStart = 0;

    // Helper: flush текущий section
    const flush = (endLineIndex: number) => {
      if (currentContent.length > 0 || currentHeading) {
        const content = currentContent.join('\n').trim();
        if (content.length > 0 || currentHeading) {
          // Считаем charStart/charEnd по line ranges (приблизительно)
          const startChar = lines.slice(0, currentStart).join('\n').length;
          const endChar = lines.slice(0, endLineIndex).join('\n').length;
          sections.push({
            heading: currentHeading,
            path: headingStack.filter(Boolean).join(' > '),
            content,
            charStart: startChar,
            charEnd: endChar,
          });
        }
      }
      currentContent = [];
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const headingMatch = line.match(/^(#{1,6})\s+(.+?)\s*$/);

      if (headingMatch) {
        // Flush previous section
        flush(i);

        const level = headingMatch[1].length;
        const title = headingMatch[2];

        // Обновляем heading stack: оставляем только заголовки уровня < текущего
        headingStack.length = Math.max(0, level - 1);
        // Заполняем пустые уровни (если был # затем ### — добавляем пустой "##")
        while (headingStack.length < level - 1) headingStack.push('');
        headingStack.push(title);

        currentHeading = title;
        currentStart = i + 1;  // контент начинается со следующей строки
      } else {
        currentContent.push(line);
      }
    }

    // Last section
    flush(lines.length);

    // Если ничего не нашли (пустой документ после trim) — возвращаем пустой
    if (sections.length === 0 && text.length > 0) {
      sections.push({
        heading: '',
        path: '',
        content: text,
        charStart: 0,
        charEnd: text.length,
      });
    }

    return sections;
  }

  /**
   * Разбить длинный текст на параграфы с overlap.
   *
   * Стратегия:
   *   - Разрезаем по \n\n+ (один или больше пустых строк)
   *   - Накапливаем параграфы в current, пока не превысим maxChars
   *   - На разрыве: сохраняем current, переносим последние `overlap` символов
   *     в начало нового current (чтобы фразы на границе не разрывались)
   *
   * Edge cases:
   *   - Один параграф длиннее maxChars — он возвращается целиком (не разрезаем
   *     посимвольно, чтобы не разрывать предложения). Indexer решит что с ним
   *     делать (embedding может быть хуже, но это лучше, чем обрыв).
   */
  private splitByParagraphs(text: string, maxChars: number, overlap: number): string[] {
    const paragraphs = text.split(/\n\n+/).filter(p => p.trim().length > 0);
    if (paragraphs.length === 0) return [];

    const result: string[] = [];
    let current = '';

    for (const para of paragraphs) {
      // Если параграф сам по себе длиннее maxChars — он идёт отдельным chunk
      if (para.length > maxChars) {
        if (current) {
          result.push(current);
          current = current.slice(-overlap);
        }
        result.push(para);
        current = '';
        continue;
      }

      const candidate = current ? current + '\n\n' + para : para;
      if (candidate.length > maxChars && current) {
        result.push(current);
        // Overlap: последние `overlap` символов переносим в следующий chunk
        current = current.slice(-overlap) + '\n\n' + para;
      } else {
        current = candidate;
      }
    }
    if (current) result.push(current);
    return result;
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Вычислить SHA-256 от строки и вернуть hex.
 *
 * Используется для contentHash в Chunk — детектор изменений при реиндексации.
 * Если content не изменился — chunk не пере-embed'ится (экономия HTTP calls
 * к Ollama при реиндексации больших документов).
 */
export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** SHA-256 от бинарного содержимого (PDF, DOCX) — для contentHash при upload. */
export function sha256Buffer(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}
