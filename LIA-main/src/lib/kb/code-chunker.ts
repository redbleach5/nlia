import 'server-only';

// ============================================================================
// Code Chunker — превращает ParsedFile в Chunk[] для KB indexer.
// ============================================================================
//
// Стратегия chunking'а:
//
// 1. КАЖДЫЙ символ (function/class/method/interface/type) = 1 chunk.
//    Тело символа + docstring + сигнатура = content chunk'а.
//
// 2. Если символ огромный (> 4000 chars), он разбивается на части
//    по границам строк с overlap 200 chars. Это редкий случай —
//    обычно это сгенерированные файлы или огромные тестовые suites.
//
// 3. Если в файле НЕТ символов (например, чисто импорты, конфиг,
//    env.example) — создаётся 1 file-level chunk с полным содержимым
//    (до 4000 chars, иначе разбивается).
//
// 4. File-level chunk ВСЕГДА создаётся первым (position 0):
//    - Content: "File: path/to/file.ts\nLanguage: typescript\nImports: ...\nSymbols: ..."
//    - Это summary-чанк для быстрого поиска по имени файла.
//
// Иерархия: file chunk (parent) → symbol chunks (children).
// В Chunk.metadata.symbolType = 'file' для parent, иначе тип символа.
//
// contentHash для symbol chunk = SHA-256(symbol body + filePath + symbolName).
// Это позволяет incremental reindex: если тело функции не изменилось —
// hash совпадёт, embedding переиспользуется.
// ============================================================================

import { createHash } from 'node:crypto';
import type { ParsedFile, CodeSymbol } from './code-parser';
import type { Chunk } from './types';

// ============================================================================
// CodebaseChunkMetadata (расширяет ChunkMetadata)
// ============================================================================

export interface CodebaseChunkMetadata {
  /** relativePath от projectPath */
  filePath: string;
  /** 'typescript' | 'javascript' | 'python' */
  language: string;
  /** 'function' | 'method' | 'class' | 'interface' | 'type' | 'file' */
  symbolType: string;
  /** Имя символа (для file chunk — пустая строка) */
  symbolName: string;
  /** Exported? (TS/JS) */
  isExported: boolean;
  /** 1-indexed строка начала */
  lineStart: number;
  /** 1-indexed строка конца */
  lineEnd: number;
  /** Imports внутри символа (для file chunk — все imports файла) */
  imports?: string[];
  /** Docstring (если есть) */
  docstring?: string;
  /** Для multi-part chunks: part number (0-indexed) */
  partIndex?: number;
  /** Для multi-part chunks: total parts */
  partCount?: number;
}

// ============================================================================
// Constants
// ============================================================================

const MAX_CHUNK_CHARS = 4000;
const MIN_CHUNK_CHARS = 50;
const OVERLAP_CHARS = 200;
const FILE_SUMMARY_MAX_CHARS = 800;

// ============================================================================
// Helpers
// ============================================================================

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function genId(): string {
  return 'cs_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-6);
}

/**
 * Разбить текст на части по границам строк, каждая <= maxChars.
 * Overlap — последние overlapChars предыдущей части в начало следующей.
 */
function splitTextWithOverlap(text: string, maxChars: number, overlap: number): string[] {
  if (text.length <= maxChars) return [text];

  const parts: string[] = [];
  let pos = 0;
  while (pos < text.length) {
    let end = Math.min(pos + maxChars, text.length);
    // Откатываемся до последней границы строки в пределах maxChars
    if (end < text.length) {
      const lastNewline = text.lastIndexOf('\n', end);
      if (lastNewline > pos + MIN_CHUNK_CHARS) {
        end = lastNewline + 1;
      }
    }
    parts.push(text.slice(pos, end));
    if (end >= text.length) break;
    // Следующая часть начинается с overlap
    pos = end - overlap;
    if (pos < 0) pos = 0;
    // Выравниваем на границу строки
    const nextNewline = text.indexOf('\n', pos);
    if (nextNewline !== -1 && nextNewline < end) {
      pos = nextNewline + 1;
    }
  }
  return parts.filter(p => p.trim().length > 0);
}

// ============================================================================
// Build symbol chunk content
// ============================================================================

function buildSymbolChunkContent(
  filePath: string,
  language: string,
  symbol: CodeSymbol,
): string {
  // Формат, оптимизированный для semantic search:
  //   File: path/to/file.ts
  //   Symbol: function runAgentTask (exported)
  //   Lines: 207-340
  //   <docstring если есть>
  //   <body>
  const header = [
    `File: ${filePath}`,
    `Language: ${language}`,
    `Symbol: ${symbol.type} ${symbol.name}${symbol.isExported ? ' (exported)' : ''}`,
    `Lines: ${symbol.lineStart}-${symbol.lineEnd}`,
  ].join('\n');

  const docstringBlock = symbol.docstring
    ? `\n\nDocstring:\n${symbol.docstring}`
    : '';

  return `${header}${docstringBlock}\n\n${symbol.body}`;
}

// ============================================================================
// Build file-level summary chunk
// ============================================================================

function buildFileSummaryContent(file: ParsedFile): string {
  const exportedSymbols = file.symbols.filter(s => s.isExported);
  const symbolList = file.symbols
    .slice(0, 30) // ограничиваем для контекста
    .map(s => `  - ${s.type} ${s.name}${s.isExported ? ' (exported)' : ''} [L${s.lineStart}-${s.lineEnd}]`)
    .join('\n');

  const importsList = file.fileImports
    .slice(0, 20)
    .map(i => `  - ${i}`)
    .join('\n');

  const header = [
    `File: ${file.filePath}`,
    `Language: ${file.language}`,
  ].join('\n');

  const sections = [header];
  if (file.fileImports.length > 0) {
    sections.push(`Imports (${file.fileImports.length}):\n${importsList}`);
  }
  if (symbolList) {
    sections.push(`Symbols (${file.symbols.length}):\n${symbolList}`);
  }

  return sections.join('\n\n').slice(0, FILE_SUMMARY_MAX_CHARS);
}

// ============================================================================
// Main: fileToChunks
// ============================================================================

export function fileToChunks(
  file: ParsedFile,
  sourceId: string,
): Chunk[] {
  const chunks: Chunk[] = [];

  // ── File-level summary chunk (position 0) ──
  const fileSummaryContent = buildFileSummaryContent(file);
  const fileId = genId();
  chunks.push({
    id: fileId,
    sourceId,
    content: fileSummaryContent,
    contentHash: sha256(fileSummaryContent + ':file:' + file.filePath),
    metadata: {
      filePath: file.filePath,
      language: file.language,
      symbolType: 'file',
      symbolName: '',
      isExported: false,
      lineStart: 1,
      lineEnd: file.fullContent.split('\n').length,
      imports: file.fileImports,
    } as CodebaseChunkMetadata,
    parentId: null,
    position: 0,
    summary: null,
  });

  // ── Symbol chunks ──
  let position = 1;
  for (const symbol of file.symbols) {
    const baseContent = buildSymbolChunkContent(file.filePath, file.language, symbol);

    // Если символ огромный — разбиваем на части
    if (baseContent.length > MAX_CHUNK_CHARS) {
      const parts = splitTextWithOverlap(baseContent, MAX_CHUNK_CHARS, OVERLAP_CHARS);
      parts.forEach((part, idx) => {
        const chunkId = genId();
        const partContent = parts.length > 1
          ? `${part}\n\n[Part ${idx + 1}/${parts.length}]`
          : part;
        chunks.push({
          id: chunkId,
          sourceId,
          content: partContent,
          contentHash: sha256(partContent + ':sym:' + file.filePath + ':' + symbol.name + ':' + idx),
          metadata: {
            filePath: file.filePath,
            language: file.language,
            symbolType: symbol.type,
            symbolName: symbol.name,
            isExported: symbol.isExported,
            lineStart: symbol.lineStart,
            lineEnd: symbol.lineEnd,
            imports: symbol.imports.length > 0 ? symbol.imports : undefined,
            docstring: symbol.docstring,
            partIndex: parts.length > 1 ? idx : undefined,
            partCount: parts.length > 1 ? parts.length : undefined,
          } as CodebaseChunkMetadata,
          parentId: fileId,
          position: position++,
          summary: null,
        });
      });
    } else {
      const chunkId = genId();
      chunks.push({
        id: chunkId,
        sourceId,
        content: baseContent,
        contentHash: sha256(baseContent + ':sym:' + file.filePath + ':' + symbol.name),
        metadata: {
          filePath: file.filePath,
          language: file.language,
          symbolType: symbol.type,
          symbolName: symbol.name,
          isExported: symbol.isExported,
          lineStart: symbol.lineStart,
          lineEnd: symbol.lineEnd,
          imports: symbol.imports.length > 0 ? symbol.imports : undefined,
          docstring: symbol.docstring,
        } as CodebaseChunkMetadata,
        parentId: fileId,
        position: position++,
        summary: null,
      });
    }
  }

  // ── Если символов нет, но файл непустой — file-content chunk ──
  if (file.symbols.length === 0 && file.fullContent.trim().length > MIN_CHUNK_CHARS) {
    const contentParts = splitTextWithOverlap(file.fullContent, MAX_CHUNK_CHARS, OVERLAP_CHARS);
    contentParts.forEach((part, idx) => {
      const chunkId = genId();
      const partContent = contentParts.length > 1
        ? `File: ${file.filePath}\nLanguage: ${file.language}\n[Part ${idx + 1}/${contentParts.length}]\n\n${part}`
        : `File: ${file.filePath}\nLanguage: ${file.language}\n\n${part}`;
      chunks.push({
        id: chunkId,
        sourceId,
        content: partContent,
        contentHash: sha256(partContent + ':raw:' + file.filePath + ':' + idx),
        metadata: {
          filePath: file.filePath,
          language: file.language,
          symbolType: 'file',
          symbolName: '',
          isExported: false,
          lineStart: 1,
          lineEnd: file.fullContent.split('\n').length,
          partIndex: contentParts.length > 1 ? idx : undefined,
          partCount: contentParts.length > 1 ? contentParts.length : undefined,
        } as CodebaseChunkMetadata,
        parentId: fileId,
        position: position++,
        summary: null,
      });
    });
  }

  return chunks;
}
