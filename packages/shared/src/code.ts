/**
 * Code symbol types — shared between backend (code service) and frontend.
 *
 * Per docs/ARCHITECTURE.md § 5.4 + § 7.2.
 */

export type CodeSymbolType =
  | "function"
  | "method"
  | "class"
  | "interface"
  | "type"
  | "const"
  | "file";

export type CodeReferenceKind =
  | "call"
  | "import"
  | "type_annotation"
  | "override";

export type SupportedLanguage =
  | "typescript"
  | "javascript"
  | "python"
  | "go"
  | "rust"
  | "java";

export interface CodeSymbol {
  id: string;
  resourceId: string;
  filePath: string;
  language: SupportedLanguage;
  symbolType: CodeSymbolType;
  name: string;
  isExported: boolean;
  lineStart: number;
  lineEnd: number;
  signature: string | null;
  contentHash: string;
  /** Derived: reference count (for enriched search results). */
  referenceCount?: number;
}

export interface CodeReference {
  id: string;
  symbolId: string;
  resourceId: string;
  filePath: string;
  line: number;
  column: number;
  kind: CodeReferenceKind;
  /** Symbol name (joined from codeSymbols for convenience). */
  symbolName?: string;
}

export interface SymbolSearchResult {
  symbol: CodeSymbol;
  references: CodeReference[];
  referenceCount: number;
}
