/**
 * Code symbol tools — agent tools for symbol-aware code search.
 *
 * Per docs/ARCHITECTURE.md § 7.2 + § 8.2 (category B: Symbol tools).
 * Availability: workspace.resources.some(r => r.kind === 'codebase')
 *
 * Tools:
 *   - search_codebase: search symbols by name (enriched with reference count)
 *   - list_references: find all call sites of a symbol
 *   - list_definitions: find definition of a symbol name
 *   - list_importers: find files that import a given file
 *   - list_codebase_symbols: list all symbols in a file
 */

import { z } from "zod";
import { registerTool } from "../tool-registry.js";
import {
  searchSymbols,
  listReferences,
  listDefinitions,
  listImporters,
  listFileSymbols,
} from "../../code/service.js";

// search_codebase — search symbols by name
registerTool({
  name: "search_codebase",
  description: "Search for code symbols (functions, classes, methods) by name. Returns enriched results with reference counts.",
  inputSchema: z.object({
    query: z.string().describe("Symbol name or partial name to search for"),
    limit: z.number().optional(),
  }),
  available: (resources) => resources.some((r) => r.kind === "codebase"),
  execute: async (input) => {
    const { query, limit } = input as { query: string; limit?: number };
    const results = searchSymbols(query, { limit: limit ?? 10 });
    return {
      results: results.map((r) => ({
        name: r.symbol.name,
        type: r.symbol.symbolType,
        filePath: r.symbol.filePath,
        lineStart: r.symbol.lineStart,
        lineEnd: r.symbol.lineEnd,
        signature: r.symbol.signature,
        isExported: r.symbol.isExported,
        referenceCount: r.referenceCount,
      })),
      total: results.length,
    };
  },
});

// list_references — find all call sites of a symbol
registerTool({
  name: "list_references",
  description: "Find all places where a symbol is called or referenced. Use after search_codebase to find call sites.",
  inputSchema: z.object({
    symbolId: z.string().describe("Symbol ID from search_codebase results"),
  }),
  available: (resources) => resources.some((r) => r.kind === "codebase"),
  execute: async (input) => {
    const { symbolId } = input as { symbolId: string };
    const { symbol, references } = listReferences(symbolId);
    if (!symbol) {
      return { error: "symbol not found", symbolId };
    }
    return {
      symbol: {
        name: symbol.name,
        type: symbol.symbolType,
        filePath: symbol.filePath,
        lineStart: symbol.lineStart,
      },
      references: references.map((r) => ({
        filePath: r.filePath,
        line: r.line,
        column: r.column,
        kind: r.kind,
      })),
      referenceCount: references.length,
    };
  },
});

// list_definitions — find definition of a symbol name
registerTool({
  name: "list_definitions",
  description: "Find the definition(s) of a symbol by exact name. Returns file + line range.",
  inputSchema: z.object({
    name: z.string().describe("Exact symbol name"),
  }),
  available: (resources) => resources.some((r) => r.kind === "codebase"),
  execute: async (input) => {
    const { name } = input as { name: string };
    const definitions = listDefinitions(name);
    return {
      definitions: definitions.map((d) => ({
        name: d.name,
        type: d.symbolType,
        filePath: d.filePath,
        lineStart: d.lineStart,
        lineEnd: d.lineEnd,
        signature: d.signature,
        isExported: d.isExported,
      })),
      total: definitions.length,
    };
  },
});

// list_importers — find files that import a given file
registerTool({
  name: "list_importers",
  description: "Find all files that import symbols from a given file. Useful for impact analysis.",
  inputSchema: z.object({
    filePath: z.string().describe("File path to find importers for"),
  }),
  available: (resources) => resources.some((r) => r.kind === "codebase"),
  execute: async (input) => {
    const { filePath } = input as { filePath: string };
    const importers = listImporters(filePath);
    return {
      importers: importers.map((r) => ({
        filePath: r.filePath,
        line: r.line,
        symbolName: r.symbolName,
      })),
      total: importers.length,
    };
  },
});

// list_codebase_symbols — list all symbols in a file
registerTool({
  name: "list_codebase_symbols",
  description: "List all symbols (functions, classes, methods) defined in a specific file.",
  inputSchema: z.object({
    filePath: z.string().describe("File path to list symbols for"),
  }),
  available: (resources) => resources.some((r) => r.kind === "codebase"),
  execute: async (input) => {
    const { filePath } = input as { filePath: string };
    const symbols = listFileSymbols(filePath);
    return {
      symbols: symbols.map((s) => ({
        name: s.name,
        type: s.symbolType,
        lineStart: s.lineStart,
        lineEnd: s.lineEnd,
        signature: s.signature,
        isExported: s.isExported,
      })),
      total: symbols.length,
    };
  },
});
