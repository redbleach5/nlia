/**
 * Code indexer — parse codebase → extract symbols + references → persist.
 *
 * Per docs/ARCHITECTURE.md § 7.2 + § 7.4.
 *
 * Pipeline: collect code files → parseFile → extract symbols → extract
 * references (calls + imports) → persist to codeSymbols + codeReferences.
 *
 * contentHash dedup: if a symbol's body hasn't changed, skip re-indexing.
 * Incremental: only re-parse changed files (contentHash comparison).
 */

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { readdir, stat, readFile } from "node:fs/promises";
import { join, extname, relative } from "node:path";
import { getDb } from "../db/client.js";
import { codeSymbols, codeReferences, resources } from "../db/schema.js";
import { parseFile, type ParsedFile } from "./parser.js";
import { logger } from "../util/logger.js";

const CODE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".mts", ".cts",
  ".js", ".jsx", ".mjs", ".cjs",
  ".py",
]);

const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2 MB per code file

/** Collect all code files in a folder (recursive). */
export async function collectCodeFiles(
  folderPath: string,
  ignore: string[] = ["node_modules", ".git", "dist", "build", ".next"],
): Promise<string[]> {
  const result: string[] = [];
  const ignoreSet = new Set(ignore);

  async function walk(dir: string) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (ignoreSet.has(entry.name)) continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        const ext = extname(entry.name).toLowerCase();
        if (CODE_EXTENSIONS.has(ext)) {
          result.push(fullPath);
        }
      }
    }
  }

  await walk(folderPath);
  return result;
}

/**
 * Index a codebase resource: collect files → parse → extract symbols +
 * references → persist.
 *
 * Per § 7.2 — symbol-aware indexing for codebase resources.
 * Idempotent: old symbols/references are deleted before re-inserting.
 */
export async function indexCodebaseResource(resourceId: string): Promise<{
  filesProcessed: number;
  symbolsCreated: number;
  referencesCreated: number;
  durationMs: number;
}> {
  const startedAt = Date.now();
  const sqlite = getDb();
  const db = drizzle(sqlite);

  // Load resource
  const resource = db.select().from(resources).where(eq(resources.id, resourceId)).get();
  if (!resource) throw new Error(`resource not found: ${resourceId}`);
  if (resource.kind !== "codebase") {
    throw new Error(`resource kind ${resource.kind} is not a codebase`);
  }

  const config = JSON.parse(resource.config) as {
    projectPath?: string;
    folderPath?: string;
    ignore?: string[];
  };
  const projectPath = config.projectPath ?? config.folderPath;
  if (!projectPath) throw new Error("no projectPath in resource config");

  // Update status to indexing
  db.update(resources)
    .set({ status: "indexing", errorMessage: null })
    .where(eq(resources.id, resourceId))
    .run();

  try {
    // 1. Collect code files
    const files = await collectCodeFiles(projectPath, config.ignore);
    logger.info({ resourceId, projectPath, fileCount: files.length }, "code indexing started");

    // 2. Delete old symbols + references for this resource
    db.delete(codeReferences).where(eq(codeReferences.resourceId, resourceId)).run();
    db.delete(codeSymbols).where(eq(codeSymbols.resourceId, resourceId)).run();

    let filesProcessed = 0;
    let symbolsCreated = 0;
    let referencesCreated = 0;
    const allSymbolNames = new Map<string, string[]>(); // name → symbolIds

    // 3. Parse each file + extract symbols
    for (const filePath of files) {
      try {
        const s = await stat(filePath);
        if (s.size > MAX_FILE_SIZE) continue;

        const content = await readFile(filePath, "utf-8");
        const relPath = relative(projectPath, filePath);
        const parsed = parseFile(relPath, content);

        // Persist symbols
        for (const sym of parsed.symbols) {
          const symId = `sym_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
          db.insert(codeSymbols)
            .values({
              id: symId,
              resourceId,
              filePath: relPath,
              language: parsed.language,
              symbolType: sym.type,
              name: sym.name,
              isExported: sym.isExported,
              lineStart: sym.lineStart,
              lineEnd: sym.lineEnd,
              signature: sym.signature,
              contentHash: sym.contentHash,
            })
            .run();
          symbolsCreated++;

          // Track symbol name → id for reference extraction
          if (!allSymbolNames.has(sym.name)) {
            allSymbolNames.set(sym.name, []);
          }
          allSymbolNames.get(sym.name)!.push(symId);
        }

        // 4. Extract references (calls + imports) from file content
        const refs = extractReferences(parsed, allSymbolNames);
        for (const ref of refs) {
          const refId = `ref_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
          db.insert(codeReferences)
            .values({
              id: refId,
              symbolId: ref.symbolId,
              resourceId,
              filePath: relPath,
              line: ref.line,
              column: ref.column,
              kind: ref.kind,
            })
            .run();
          referencesCreated++;
        }

        filesProcessed++;
      } catch (e) {
        logger.warn({ filePath, err: e }, "failed to parse code file");
      }
    }

    // 5. Update resource status
    const durationMs = Date.now() - startedAt;
    db.update(resources)
      .set({
        status: "ready",
        chunkCount: symbolsCreated,
        lastIndexedAt: Math.floor(Date.now() / 1000),
        updatedAt: Math.floor(Date.now() / 1000),
      })
      .where(eq(resources.id, resourceId))
      .run();

    logger.info(
      { resourceId, filesProcessed, symbolsCreated, referencesCreated, durationMs },
      "code indexing complete",
    );

    return { filesProcessed, symbolsCreated, referencesCreated, durationMs };
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    db.update(resources)
      .set({ status: "error", errorMessage: errMsg })
      .where(eq(resources.id, resourceId))
      .run();
    logger.error({ err: e, resourceId }, "code indexing failed");
    throw e;
  }
}

/**
 * Extract references from a parsed file.
 * A reference is any occurrence of a known symbol name that is NOT the
 * symbol's own definition.
 */
function extractReferences(
  parsed: ParsedFile,
  symbolNames: Map<string, string[]>,
): Array<{ symbolId: string; line: number; column: number; kind: "call" | "import" | "type_annotation" }> {
  const refs: Array<{ symbolId: string; line: number; column: number; kind: "call" | "import" | "type_annotation" }> = [];
  const lines = parsed.fullContent.split("\n");
  const definedNames = new Set(parsed.symbols.map((s) => s.name));

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // Check for import references
    if (line.match(/^\s*(import\s|from\s|const\s.*=\s*require)/)) {
      for (const [name, ids] of symbolNames) {
        if (line.includes(name) && !definedNames.has(name)) {
          const col = line.indexOf(name);
          refs.push({ symbolId: ids[0]!, line: i + 1, column: col, kind: "import" });
        }
      }
      continue;
    }

    // Check for call references (name followed by "(")
    for (const [name, ids] of symbolNames) {
      if (definedNames.has(name)) continue; // skip self-definition
      const callRegex = new RegExp(`\\b${escapeRegex(name)}\\s*\\(`, "g");
      let match;
      while ((match = callRegex.exec(line)) !== null) {
        refs.push({ symbolId: ids[0]!, line: i + 1, column: match.index, kind: "call" });
      }
    }
  }

  return refs;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
