/**
 * Code symbol service — query layer over codeSymbols + codeReferences.
 *
 * Per docs/ARCHITECTURE.md § 7.2.
 * Provides:
 *   - searchSymbols: search by name (substring match)
 *   - listReferences: find all call sites of a symbol
 *   - listDefinitions: find the definition of a symbol name
 *   - listImporters: find files that import a given file
 *   - listFileSymbols: list all symbols in a file
 */

import { eq, like, and } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { getDb } from "../db/client.js";
import { codeSymbols, codeReferences } from "../db/schema.js";
import type { CodeSymbol, CodeReference, SymbolSearchResult } from "@lia/shared";

function rowToSymbol(row: typeof codeSymbols.$inferSelect): CodeSymbol {
  return {
    id: row.id,
    resourceId: row.resourceId,
    filePath: row.filePath,
    language: row.language as CodeSymbol["language"],
    symbolType: row.symbolType as CodeSymbol["symbolType"],
    name: row.name,
    isExported: Boolean(row.isExported),
    lineStart: row.lineStart,
    lineEnd: row.lineEnd,
    signature: row.signature,
    contentHash: row.contentHash,
  };
}

function rowToReference(row: typeof codeReferences.$inferSelect, symbolName?: string): CodeReference {
  return {
    id: row.id,
    symbolId: row.symbolId,
    resourceId: row.resourceId,
    filePath: row.filePath,
    line: row.line,
    column: row.column,
    kind: row.kind as CodeReference["kind"],
    symbolName,
  };
}

/**
 * Search symbols by name (case-insensitive substring match).
 * Returns symbols with their reference counts.
 */
export function searchSymbols(
  nameQuery: string,
  opts: { resourceIds?: string[]; limit?: number } = {},
): SymbolSearchResult[] {
  const sqlite = getDb();
  const db = drizzle(sqlite);
  const limit = opts.limit ?? 20;

  const symbolRows = db
    .select()
    .from(codeSymbols)
    .where(like(codeSymbols.name, `%${nameQuery}%`))
    .limit(limit)
    .all()
    .filter((r) => !opts.resourceIds || opts.resourceIds.includes(r.resourceId));

  return symbolRows.map((row) => {
    const symbol = rowToSymbol(row);
    const refCount = db
      .select({ id: codeReferences.id })
      .from(codeReferences)
      .where(eq(codeReferences.symbolId, row.id))
      .all().length;
    return {
      symbol: { ...symbol, referenceCount: refCount },
      references: [],
      referenceCount: refCount,
    };
  });
}

/**
 * List all references (call sites) for a symbol.
 */
export function listReferences(
  symbolId: string,
): { symbol: CodeSymbol | null; references: CodeReference[] } {
  const sqlite = getDb();
  const db = drizzle(sqlite);

  const symbolRow = db.select().from(codeSymbols).where(eq(codeSymbols.id, symbolId)).get();
  if (!symbolRow) return { symbol: null, references: [] };

  const symbol = rowToSymbol(symbolRow);
  const refRows = db
    .select()
    .from(codeReferences)
    .where(eq(codeReferences.symbolId, symbolId))
    .all();

  return {
    symbol,
    references: refRows.map((r) => rowToReference(r, symbol.name)),
  };
}

/**
 * Find the definition of a symbol by name.
 * Returns all matching definitions (there may be multiple across files).
 */
export function listDefinitions(
  name: string,
  opts: { resourceIds?: string[] } = {},
): CodeSymbol[] {
  const sqlite = getDb();
  const db = drizzle(sqlite);

  const rows = db
    .select()
    .from(codeSymbols)
    .where(eq(codeSymbols.name, name))
    .all()
    .filter((r) => !opts.resourceIds || opts.resourceIds.includes(r.resourceId));

  return rows.map(rowToSymbol);
}

/**
 * Find files that import a given file.
 * Returns references where kind = 'import' and the filePath matches.
 */
export function listImporters(
  filePath: string,
  opts: { resourceIds?: string[] } = {},
): CodeReference[] {
  const sqlite = getDb();
  const db = drizzle(sqlite);

  // Find symbols defined in the given file
  const symbolsInFile = db
    .select()
    .from(codeSymbols)
    .where(eq(codeSymbols.filePath, filePath))
    .all()
    .filter((r) => !opts.resourceIds || opts.resourceIds.includes(r.resourceId));

  const symbolIds = symbolsInFile.map((s) => s.id);
  if (symbolIds.length === 0) return [];

  // Find import references to those symbols
  const refs: CodeReference[] = [];
  for (const sym of symbolsInFile) {
    const refRows = db
      .select()
      .from(codeReferences)
      .where(and(eq(codeReferences.symbolId, sym.id), eq(codeReferences.kind, "import")))
      .all();
    refs.push(...refRows.map((r) => rowToReference(r, sym.name)));
  }

  return refs;
}

/**
 * List all symbols in a specific file.
 */
export function listFileSymbols(
  filePath: string,
  opts: { resourceIds?: string[] } = {},
): CodeSymbol[] {
  const sqlite = getDb();
  const db = drizzle(sqlite);

  const rows = db
    .select()
    .from(codeSymbols)
    .where(eq(codeSymbols.filePath, filePath))
    .all()
    .filter((r) => !opts.resourceIds || opts.resourceIds.includes(r.resourceId));

  return rows.map(rowToSymbol);
}
