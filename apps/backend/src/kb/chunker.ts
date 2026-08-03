/**
 * Document chunker — semantic chunking for Markdown and text files.
 *
 * Ported from v2 src/lib/kb/chunkers/document-chunker.ts.
 * Per docs/ARCHITECTURE.md § 7.1 — 2000 chars, paragraph boundaries.
 *
 * Strategy:
 *   1. Split by Markdown headings (#, ##, ###). Each section gets heading + path.
 *   2. If section > MAX_CHUNK_CHARS → split by paragraphs (\n\n) with OVERLAP.
 *   3. If chunk < MIN_CHUNK_CHARS → merge with previous.
 *   4. contentHash (SHA-256) on content for dedup on reindex.
 */

import { createHash } from "node:crypto";

export interface ChunkMetadata {
  heading?: string;
  path?: string;
  sectionIndex?: number;
  charStart?: number;
  charEnd?: number;
  mimeType?: string;
  filePath?: string;
}

export interface ChunkOutput {
  content: string;
  contentHash: string;
  metadata: ChunkMetadata;
  parentId: string | null;
  position: number;
}

export interface DocumentSection {
  heading: string;
  path: string;
  content: string;
  charStart: number;
  charEnd: number;
}

const MAX_CHUNK_CHARS = 2000;
const MIN_CHUNK_CHARS = 50;
const OVERLAP_CHARS = 200;

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Split a document into chunks.
 *
 * @param text     raw document text (Markdown or plain text)
 * @param opts     optional mimeType + filePath for metadata
 * @returns array of chunks (0 for empty input)
 */
export function chunkDocument(
  text: string,
  opts: { mimeType?: string; filePath?: string } = {},
): ChunkOutput[] {
  const cleaned = text.replace(/^\uFEFF/, "").replace(/\s+$/, "");
  if (cleaned.length === 0) return [];

  const sections = splitByHeadings(cleaned);
  const chunks: ChunkOutput[] = [];

  for (const section of sections) {
    const subChunks =
      section.content.length > MAX_CHUNK_CHARS
        ? splitByParagraphs(section.content, MAX_CHUNK_CHARS, OVERLAP_CHARS)
        : [section.content];

    subChunks.forEach((content, i) => {
      const fullContent = section.heading
        ? `${section.heading}\n\n${content}`.trim()
        : content.trim();

      if (fullContent.length === 0) return;

      // Too short → merge with previous
      if (fullContent.length < MIN_CHUNK_CHARS && chunks.length > 0) {
        const prev = chunks[chunks.length - 1];
        prev.content = prev.content + "\n\n" + fullContent;
        prev.contentHash = sha256(prev.content);
        return;
      }

      const metadata: ChunkMetadata = {
        heading: section.heading || undefined,
        path: section.path || undefined,
        sectionIndex: i,
        charStart: section.charStart,
        charEnd: section.charEnd,
        mimeType: opts.mimeType,
        filePath: opts.filePath,
      };

      chunks.push({
        content: fullContent,
        contentHash: sha256(fullContent),
        metadata,
        parentId: null,
        position: chunks.length,
      });
    });
  }

  return chunks;
}

/**
 * Split text by Markdown headings (#{1,6} Title).
 * Preserves hierarchy in `path` — e.g. "Chapter 1 > Section 1.2 > Subsection".
 * For plain text (no headings) returns one section with all text.
 */
function splitByHeadings(text: string): DocumentSection[] {
  const lines = text.split("\n");
  const sections: DocumentSection[] = [];
  const headingStack: string[] = [];
  let currentHeading = "";
  let currentContent: string[] = [];
  let currentStart = 0;

  const flush = (endLineIndex: number) => {
    if (currentContent.length > 0 || currentHeading) {
      const content = currentContent.join("\n").trim();
      if (content.length > 0 || currentHeading) {
        const startChar = lines.slice(0, currentStart).join("\n").length;
        const endChar = lines.slice(0, endLineIndex).join("\n").length;
        sections.push({
          heading: currentHeading,
          path: headingStack.filter(Boolean).join(" > "),
          content,
          charStart: startChar,
          charEnd: endChar,
        });
      }
    }
    currentContent = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const headingMatch = line.match(/^(#{1,6})\s+(.+?)\s*$/);

    if (headingMatch) {
      flush(i);
      const level = headingMatch[1]!.length;
      const title = headingMatch[2]!;
      headingStack.length = Math.max(0, level - 1);
      while (headingStack.length < level - 1) headingStack.push("");
      headingStack.push(title);
      currentHeading = title;
      currentStart = i + 1;
    } else {
      currentContent.push(line);
    }
  }

  flush(lines.length);

  if (sections.length === 0 && text.length > 0) {
    sections.push({
      heading: "",
      path: "",
      content: text,
      charStart: 0,
      charEnd: text.length,
    });
  }

  return sections;
}

/**
 * Split long text into paragraphs with overlap.
 * Splits on \n\n+, accumulates until maxChars, carries overlap to next chunk.
 */
function splitByParagraphs(text: string, maxChars: number, overlap: number): string[] {
  const paragraphs = text.split(/\n\n+/).filter((p) => p.trim().length > 0);
  if (paragraphs.length === 0) return [];

  const result: string[] = [];
  let current = "";

  for (const para of paragraphs) {
    if (para.length > maxChars) {
      if (current) {
        result.push(current);
        current = current.slice(-overlap);
      }
      result.push(para);
      current = "";
      continue;
    }

    const candidate = current ? current + "\n\n" + para : para;
    if (candidate.length > maxChars && current) {
      result.push(current);
      current = current.slice(-overlap) + "\n\n" + para;
    } else {
      current = candidate;
    }
  }
  if (current) result.push(current);
  return result;
}
