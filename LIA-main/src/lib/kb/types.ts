// Shared types для Knowledge Base layer.

export type SourceType = 'document' | 'folder' | 'url' | 'codebase';

export function sourceTypeLabel(type: SourceType | string): string {
  switch (type) {
    case 'document': return 'Документ';
    case 'folder': return 'Папка';
    case 'url': return 'URL';
    case 'codebase': return 'Кодовая база';
    default: return type;
  }
}

export interface DocumentSourceConfig {
  filePath: string;
  mimeType: string;
  fileSize: number;
  contentHash?: string;
  originalFilename?: string;
}

type FolderIndexMode = 'manifest' | 'full';

export interface FolderSourceConfig {
  folderPath: string;
  fileCount?: number;
  watchEnabled?: boolean;
  fileHashes?: Record<string, string>;
  indexMode?: FolderIndexMode;
  contentIndexedCount?: number;
  projectGroupId?: string;
}

export interface UrlSourceConfig {
  url: string;
  title?: string;
  contentLength?: number;
  contentHash?: string;
  fetchedAt?: string;
}

export interface DocumentChunkMetadata {
  heading?: string;
  path?: string;
  relativePath?: string;
  manifest?: boolean;
  sectionIndex?: number;
  charStart?: number;
  charEnd?: number;
  page?: number;
}

export interface CodebaseSourceConfig {
  projectPath: string;
  languages: string[];
  excludePatterns?: string[];
  watchEnabled?: boolean;
  fileHashes?: Record<string, string>;
  fileCount?: number;
  projectGroupId?: string;
}

export interface CodebaseChunkMetadata {
  filePath: string;
  language: string;
  symbolType: string;
  symbolName: string;
  isExported: boolean;
  lineStart: number;
  lineEnd: number;
  imports?: string[];
  docstring?: string;
  partIndex?: number;
  partCount?: number;
}

export type ChunkMetadata = DocumentChunkMetadata | CodebaseChunkMetadata;

export interface SearchResult {
  id: string;
  sourceId: string;
  content: string;
  metadata: ChunkMetadata;
  score: number;
  matchType: 'vector' | 'bm25' | 'fused' | 'folder_probe' | 'context_expansion';
  sourceName?: string;
  sourceType?: SourceType;
  citation?: string;
}

export interface Chunk {
  id: string;
  sourceId: string;
  content: string;
  contentHash: string;
  metadata: ChunkMetadata;
  parentId: string | null;
  position: number;
  summary?: string | null;
}

export interface VectorSearchHit {
  id: string;
  sourceId: string;
  similarity: number;
}
