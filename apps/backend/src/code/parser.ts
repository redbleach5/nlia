/**
 * Code parser — symbol extraction from source files.
 *
 * Per docs/ARCHITECTURE.md § 7.2. M6 uses regex-based extraction (ported
 * from v2 code-parser.ts). M6.5 will migrate to Tree-sitter.
 *
 * Supported: TypeScript, JavaScript, Python.
 * Go/Rust/Java deferred to M6.5 per risk mitigation (§ 13.8).
 *
 * Extracts:
 *   - function declarations (named + arrow + async)
 *   - class declarations + methods
 *   - interface / type declarations (TS)
 *   - export statements
 *   - import statements (for reference extraction)
 */

import { createHash } from "node:crypto";

export type SupportedLanguage = "typescript" | "javascript" | "python";

export interface CodeSymbol {
  type: string; // 'function' | 'method' | 'class' | 'interface' | 'type' | 'const'
  name: string;
  body: string;
  lineStart: number;
  lineEnd: number;
  isExported: boolean;
  signature: string;
  contentHash: string;
}

export interface CodeReference {
  symbolName: string;
  filePath: string;
  line: number;
  column: number;
  kind: "call" | "import" | "type_annotation";
}

export interface ParsedFile {
  filePath: string;
  language: SupportedLanguage;
  symbols: CodeSymbol[];
  imports: string[];
  fullContent: string;
  contentHash: string;
}

const EXT_TO_LANG: Record<string, SupportedLanguage> = {
  ".ts": "typescript", ".tsx": "typescript", ".mts": "typescript", ".cts": "typescript",
  ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
  ".py": "python",
};

export function detectLanguage(filePath: string): SupportedLanguage | null {
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  return EXT_TO_LANG[ext] ?? null;
}

export function parseFile(filePath: string, content: string): ParsedFile {
  const language = detectLanguage(filePath);
  if (!language) {
    return { filePath, language: "javascript", symbols: [], imports: [], fullContent: content, contentHash: sha256(content) };
  }

  let symbols: CodeSymbol[] = [];
  let imports: string[] = [];

  if (language === "typescript" || language === "javascript") {
    const result = parseTsJs(content, filePath);
    symbols = result.symbols;
    imports = result.imports;
  } else if (language === "python") {
    const result = parsePython(content, filePath);
    symbols = result.symbols;
    imports = result.imports;
  }

  return {
    filePath,
    language,
    symbols,
    imports,
    fullContent: content,
    contentHash: sha256(content),
  };
}

// ─── TypeScript / JavaScript parser ───────────────────────────────────

function parseTsJs(content: string, _filePath: string): { symbols: CodeSymbol[]; imports: string[] } {
  const symbols: CodeSymbol[] = [];
  const imports: string[] = [];
  const lines = content.split("\n");

  // Extract imports
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const importMatch = line.match(/^\s*(?:import\s+.*?from\s+['"]([^'"]+)['"]|import\s+['"]([^'"]+)['"]|const\s+\w+\s*=\s*require\(['"]([^'"]+)['"]\))/);
    if (importMatch) {
      imports.push(importMatch[1] ?? importMatch[2] ?? importMatch[3] ?? "");
    }
  }

  // Extract symbols: functions, classes, interfaces, types, consts
  // Patterns (export-aware):
  //   export function name() / function name() / async function name()
  //   export class Name / class Name
  //   export interface Name / interface Name
  //   export type Name / type Name
  //   export const name = / const name =

  const patterns: Array<{ regex: RegExp; type: string }> = [
    { regex: /^\s*(export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/, type: "function" },
    { regex: /^\s*(export\s+)?class\s+(\w+)/, type: "class" },
    { regex: /^\s*(export\s+)?interface\s+(\w+)/, type: "interface" },
    { regex: /^\s*(export\s+)?type\s+(\w+)\s*=/, type: "type" },
    { regex: /^\s*(export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\(?\s*(?:async\s*)?\(?/i, type: "const" },
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    for (const { regex, type } of patterns) {
      const match = line.match(regex);
      if (match) {
        const isExported = /export/.test(match[0]!);
        const name = match[2]!;
        const lineStart = i + 1;
        const lineEnd = findSymbolEnd(lines, i, type);
        const body = lines.slice(i, lineEnd).join("\n");
        const signature = line.trim();

        symbols.push({
          type,
          name,
          body,
          lineStart,
          lineEnd,
          isExported,
          signature,
          contentHash: sha256(body),
        });
        break;
      }
    }

    // Extract methods inside classes (simplified — indentation-based)
    const methodMatch = line.match(/^\s+(?:public\s+|private\s+|protected\s+|static\s+|async\s+)*(\w+)\s*\(/);
    if (methodMatch && !line.includes("function") && !line.match(/^\s*(if|for|while|switch|catch)\s*\(/)) {
      const name = methodMatch[1]!;
      if (name !== "constructor" && !["if", "for", "while", "switch", "catch", "return"].includes(name)) {
        const lineStart = i + 1;
        const lineEnd = findMethodEnd(lines, i);
        const body = lines.slice(i, lineEnd).join("\n");
        symbols.push({
          type: "method",
          name,
          body,
          lineStart,
          lineEnd,
          isExported: false,
          signature: line.trim(),
          contentHash: sha256(body),
        });
      }
    }
  }

  return { symbols, imports };
}

// ─── Python parser ────────────────────────────────────────────────────

function parsePython(content: string, _filePath: string): { symbols: CodeSymbol[]; imports: string[] } {
  const symbols: CodeSymbol[] = [];
  const imports: string[] = [];
  const lines = content.split("\n");

  // Extract imports
  for (const line of lines) {
    const importMatch = line.match(/^\s*(?:from\s+(\S+)\s+import\s+(.+)|import\s+(\S+))/);
    if (importMatch) {
      imports.push(importMatch[1] ?? importMatch[3] ?? "");
    }
  }

  // Extract functions + classes (indentation-based)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // Function: def name(
    const funcMatch = line.match(/^(async\s+)?def\s+(\w+)\s*\(/);
    if (funcMatch) {
      const name = funcMatch[2]!;
      const lineStart = i + 1;
      const lineEnd = findPythonBlockEnd(lines, i);
      const body = lines.slice(i, lineEnd).join("\n");
      symbols.push({
        type: "function",
        name,
        body,
        lineStart,
        lineEnd,
        isExported: true, // Python has no export keyword — all top-level is "exported"
        signature: line.trim(),
        contentHash: sha256(body),
      });
      continue;
    }

    // Class: class Name(
    const classMatch = line.match(/^class\s+(\w+)/);
    if (classMatch) {
      const name = classMatch[1]!;
      const lineStart = i + 1;
      const lineEnd = findPythonBlockEnd(lines, i);
      const body = lines.slice(i, lineEnd).join("\n");

      // Extract methods inside the class
      const methodLines = lines.slice(i + 1, lineEnd);
      for (let j = 0; j < methodLines.length; j++) {
        const methodLine = methodLines[j]!;
        const methodMatch = methodLine.match(/^\s+def\s+(\w+)\s*\(/);
        if (methodMatch) {
          const methodName = methodMatch[1]!;
          const methodLineStart = i + 1 + j + 1;
          const methodLineEnd = findPythonBlockEnd(methodLines, j);
          const methodBody = methodLines.slice(j, methodLineEnd).join("\n");
          symbols.push({
            type: "method",
            name: methodName,
            body: methodBody,
            lineStart: methodLineStart,
            lineEnd: methodLineStart + methodLineEnd - j - 1,
            isExported: false,
            signature: methodLine.trim(),
            contentHash: sha256(methodBody),
          });
        }
      }

      symbols.push({
        type: "class",
        name,
        body,
        lineStart,
        lineEnd,
        isExported: true,
        signature: line.trim(),
        contentHash: sha256(body),
      });
    }
  }

  return { symbols, imports };
}

// ─── Helpers ──────────────────────────────────────────────────────────

function findSymbolEnd(lines: string[], startIdx: number, type: string): number {
  // For classes/functions: find closing brace
  if (type === "class" || type === "function" || type === "interface" || type === "type") {
    let braceCount = 0;
    let foundOpen = false;
    for (let i = startIdx; i < lines.length; i++) {
      for (const ch of lines[i]!) {
        if (ch === "{") { braceCount++; foundOpen = true; }
        if (ch === "}") braceCount--;
      }
      if (foundOpen && braceCount === 0) return i + 1;
    }
  }
  // For const: single line (usually)
  if (type === "const") {
    // Check if it's a multi-line const (e.g. arrow function)
    const line = lines[startIdx]!;
    if (line.includes("{")) {
      let braceCount = 0;
      let foundOpen = false;
      for (let i = startIdx; i < lines.length; i++) {
        for (const ch of lines[i]!) {
          if (ch === "{") { braceCount++; foundOpen = true; }
          if (ch === "}") braceCount--;
        }
        if (foundOpen && braceCount === 0) return i + 1;
      }
    }
    return startIdx + 1;
  }
  return startIdx + 1;
}

function findMethodEnd(lines: string[], startIdx: number): number {
  let braceCount = 0;
  let foundOpen = false;
  for (let i = startIdx; i < lines.length; i++) {
    for (const ch of lines[i]!) {
      if (ch === "{") { braceCount++; foundOpen = true; }
      if (ch === "}") braceCount--;
    }
    if (foundOpen && braceCount === 0) return i + 1;
    // If no brace found and next line is at same/lower indent, end
    if (i > startIdx && !foundOpen && lines[i]!.trim().length > 0 && !lines[i]!.startsWith("  ")) {
      return i;
    }
  }
  return startIdx + 1;
}

function findPythonBlockEnd(lines: string[], startIdx: number): number {
  // Python: block ends when indentation returns to the same or lesser level
  const startIndent = lines[startIdx]!.match(/^(\s*)/)?.[1].length ?? 0;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim().length === 0) continue; // skip blank lines
    const indent = line.match(/^(\s*)/)?.[1].length ?? 0;
    if (indent <= startIndent) return i;
  }
  return lines.length;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
