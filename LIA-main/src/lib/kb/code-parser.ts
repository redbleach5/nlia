import 'server-only';

// ============================================================================
// Code Parser — извлечение символов из исходного кода (v1: regex-based).
// ============================================================================
//
// Это v1 реализация. Regex покрывает ~80% случаев для TS/JS/Python:
//   - function declarations (named + arrow + async)
//   - class declarations + methods
//   - interface / type declarations (TS)
//   - export statements
//   - import statements
//
// Ограничения regex-подхода (принимаем для v1):
//   - Не парсит nested generics в сигнатурах (теряет часть типов)
//   - Не отличает overloads (первый wins)
//   - Decorators игнорируются
//   - Conditional exports (`export { X } if condition`) не поддерживаются
//
// v2 план: переход на tree-sitter (native bindings или web-tree-sitter WASM).
// Интерфейс CodeSymbolExtractor не поменяется — только реализация.
//
// Поддерживаемые языки: typescript, javascript, python.
// Добавить новый язык: реализовать extractSymbols_{lang}(code, filePath).
// ============================================================================

import { logger } from '@/lib/logger';

// ============================================================================
// Types
// ============================================================================

export type SupportedLanguage = 'typescript' | 'javascript' | 'python';

export interface CodeSymbol {
  /** 'function' | 'method' | 'class' | 'interface' | 'type' | 'const' | 'file' */
  type: string;
  /** Имя символа, например 'runAgentTask' или 'AgentRunner' */
  name: string;
  /** Полный текст символа (включая сигнатуру + тело) */
  body: string;
  /** JSDoc/docstring если удалось извлечь (обрезано до 500 chars) */
  docstring?: string;
  /** 1-indexed строка начала (сигнатура) */
  lineStart: number;
  /** 1-indexed строка конца (последняя строка тела) */
  lineEnd: number;
  /** Экспортирован? (TS/JS: export, export default; Python: нет понятия) */
  isExported: boolean;
  /** Imports внутри символа — для v1 пусто, заполняется на уровне файла */
  imports: string[];
}

export interface ParsedFile {
  /** relativePath от projectPath */
  filePath: string;
  language: SupportedLanguage;
  /** Все символы в файле (functions, classes, methods, interfaces, types) */
  symbols: CodeSymbol[];
  /** Все import'ы файла (для metadata) */
  fileImports: string[];
  /** Полный текст файла (для file-level chunk если символов нет) */
  fullContent: string;
  /** SHA-256 от fullContent (для incremental reindex) */
  contentHash: string;
}

// ============================================================================
// Language detection
// ============================================================================

const EXT_TO_LANG: Record<string, SupportedLanguage> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
};

export function detectLanguage(filePath: string): SupportedLanguage | null {
  const lower = filePath.toLowerCase();
  for (const [ext, lang] of Object.entries(EXT_TO_LANG)) {
    if (lower.endsWith(ext)) return lang;
  }
  return null;
}

// ============================================================================
// SHA-256 (reuse встроенный crypto)
// ============================================================================

import { createHash } from 'node:crypto';

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// ============================================================================
// Helper: line offset map (для быстрого поиска line number по char offset)
// ============================================================================

function buildLineOffsets(text: string): number[] {
  const offsets = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') offsets.push(i + 1);
  }
  return offsets;
}

function offsetToLine(offsets: number[], offset: number): number {
  // Binary search для последнего offsets[i] <= offset
  let lo = 0, hi = offsets.length - 1, result = 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid] <= offset) {
      result = mid + 1; // 1-indexed
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return result;
}

// ============================================================================
// TS/JS symbol extraction (regex-based)
// ============================================================================

// Импорты: `import X from '...'`, `import { X, Y } from '...'`, `import '...'`
const TS_IMPORT_RE = /^\s*import\s+(?:[^'"]+\s+from\s+)?['"]([^'"]+)['"]/gm;

// JSDoc: /** ... */ (non-greedy, multiline)
const JSDOC_RE = /\/\*\*[\s\S]*?\*\//;

// function declarations (named, async, generator)
// Группа 1: optional 'export ' / 'export default '
// Группа 2: optional 'async ' / 'function*'
// Группа 3: function name
const TS_FUNCTION_RE =
  /^(?:[ \t]*(?:export(?:\s+default)?\s+))?(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/gm;

// const/let arrow functions: `export const foo = (...) => {` или `const foo = async () =>`
// Группа 1: optional export
// Группа 2: const|let|var
// Группа 3: name
const TS_ARROW_RE =
  /^(?:[ \t]*(?:export(?:\s+default)?\s+))?(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=]+)?=\s*(?:async\s*)?\([^)]*\)\s*=>/gm;

// class declarations
// Группа 1: optional export
// Группа 2: class name
const TS_CLASS_RE =
  /^(?:[ \t]*(?:export(?:\s+default)?\s+))?(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/gm;

// methods внутри class: `methodName(args) {` или `async methodName(args) {`
// Группа 1: optional async/static/get/set
// Группа 2: method name
const TS_METHOD_RE =
  /^\s*(?:public\s+|private\s+|protected\s+|static\s+|async\s+|get\s+|set\s+|readonly\s+)*(?:get\s+|set\s+)?([A-Za-z_$][\w$]*|"[^"]+"|'[^']+')(?:<[^>]*>)?\s*\([^)]*\)\s*(?::\s*[^{]+)?\s*\{/gm;

// interface declarations (TS)
const TS_INTERFACE_RE =
  /^(?:[ \t]*(?:export\s+))?(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/gm;

// type aliases (TS)
const TS_TYPE_RE =
  /^(?:[ \t]*(?:export\s+))?(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*[=<]/gm;

/**
 * Найти конец блока, начиная с позиции открывающей скобки `{`.
 * Учитывает строки, комментарии, вложенные скобки.
 * Возвращает индекс символа ПОСЛЕ закрывающей скобки, или -1 если не найдено.
 */
function findBlockEnd(text: string, bracePos: number): number {
  if (text[bracePos] !== '{') return -1;
  let depth = 0;
  let i = bracePos;
  let inString: '"' | "'" | '`' | null = null;
  let inLineComment = false;
  let inBlockComment = false;

  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];

    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      i++;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') { inBlockComment = false; i += 2; continue; }
      i++;
      continue;
    }
    if (inString) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === inString) inString = null;
      i++;
      continue;
    }
    // Не в строке/комментарии
    if (ch === '/' && next === '/') { inLineComment = true; i += 2; continue; }
    if (ch === '/' && next === '*') { inBlockComment = true; i += 2; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { inString = ch; i++; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return -1;
}

/**
 * Найти конец statement'а без фигурных скобок (например, type alias, const arrow без тела).
 * Идём до ; или конца строки (последний non-whitespace).
 */
function findStatementEnd(text: string, startPos: number): number {
  let i = startPos;
  let inString: '"' | "'" | '`' | null = null;
  let depth = 0; // для () [] {}

  while (i < text.length) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === inString) inString = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inString = ch; i++; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ';' && depth === 0) return i + 1;
    else if (ch === '\n' && depth === 0) {
      // Проверим, заканчивается ли строка на что-то кроме оператора продолжения
      const lineEnd = text.slice(startPos, i).trimEnd();
      if (lineEnd && !lineEnd.match(/[,+\-*/&|<>?.=({[]$/)) {
        // Возможно конец statement'а, но без ; (AS1)
        // Пропустим пробелы и проверим следующую строку
        let j = i + 1;
        while (j < text.length && /\s/.test(text[j])) j++;
        // Если следующая строка не continuation — это конец
        if (j >= text.length || !text[j].match(/[.,;)]/)) {
          return i;
        }
      }
    }
    i++;
  }
  return text.length;
}

/**
 * Извлечь docstring (JSDoc) ПЕРЕД позицией символа.
 */
function extractJsdoc(text: string, symbolStart: number): string | undefined {
  // Идём назад, пропускаем whitespace
  let i = symbolStart - 1;
  while (i >= 0 && /\s/.test(text[i])) i--;

  // Ищем */
  if (i < 1 || text[i] !== '/' || text[i - 1] !== '*') return undefined;
  // Находим начало /**
  let end = i + 1;
  let j = i - 1;
  while (j > 0 && !(text[j] === '/' && text[j + 1] === '*')) j--;
  if (j <= 0) return undefined;
  const doc = text.slice(j, end);
  const match = doc.match(JSDOC_RE);
  if (!match) return undefined;
  // Очистка от /** ... */ и *
  const cleaned = doc
    .replace(/^\/\*\*/, '')
    .replace(/\*\/$/, '')
    .replace(/^\s*\*\s?/gm, '')
    .trim();
  return cleaned.slice(0, 500) || undefined;
}

interface RawMatch {
  type: string;
  name: string;
  /** Позиция в тексте, где начинается match (до export keyword) */
  startOffset: number;
  /** Позиция, где находится само ключевое слово (function/class/etc) */
  keywordOffset: number;
  isExported: boolean;
}

function extractTsJsSymbols(code: string): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];
  const lineOffsets = buildLineOffsets(code);
  const used: Array<{ start: number; end: number }> = [];

  const overlaps = (start: number, end: number) =>
    used.some(u => start < u.end && end > u.start);

  const tryAdd = (m: RawMatch) => {
    // Найти открывающую скобку после сигнатуры
    const afterKeyword = code.indexOf('{', m.keywordOffset);
    let bodyEnd: number;
    if (afterKeyword !== -1 && afterKeyword < m.keywordOffset + 500) {
      bodyEnd = findBlockEnd(code, afterKeyword);
    } else {
      // Нет тела с { } — type alias, const arrow без тела, interface без тела
      bodyEnd = findStatementEnd(code, m.keywordOffset);
    }
    if (bodyEnd === -1 || bodyEnd <= m.startOffset) return;

    if (overlaps(m.startOffset, bodyEnd)) return;
    used.push({ start: m.startOffset, end: bodyEnd });

    const body = code.slice(m.startOffset, bodyEnd);
    const lineStart = offsetToLine(lineOffsets, m.startOffset);
    const lineEnd = offsetToLine(lineOffsets, bodyEnd - 1);
    const docstring = extractJsdoc(code, m.startOffset);

    symbols.push({
      type: m.type,
      name: m.name,
      body,
      docstring,
      lineStart,
      lineEnd,
      isExported: m.isExported,
      imports: [], // заполняется на уровне файла
    });
  };

  // Functions
  for (const m of matchAll(TS_FUNCTION_RE, code)) {
    const isExported = /export/.test(m[0]);
    tryAdd({
      type: 'function',
      name: m[1],
      startOffset: m.index,
      keywordOffset: m.index + m[0].indexOf('function'),
      isExported,
    });
  }

  // Arrow functions (const x = () => {})
  for (const m of matchAll(TS_ARROW_RE, code)) {
    const isExported = /export/.test(m[0]);
    tryAdd({
      type: 'function',
      name: m[1],
      startOffset: m.index,
      keywordOffset: m.index + m[0].indexOf('='),
      isExported,
    });
  }

  // Classes
  for (const m of matchAll(TS_CLASS_RE, code)) {
    const isExported = /export/.test(m[0]);
    const classStart = m.index;
    const classBodyStart = code.indexOf('{', classStart);
    if (classBodyStart === -1) continue;
    const classBodyEnd = findBlockEnd(code, classBodyStart);
    if (classBodyEnd === -1) continue;

    if (overlaps(classStart, classBodyEnd)) continue;
    // ВАЖНО: не добавляем class в used ДО поиска methods — иначе
    // overlap check (methodStart, methodEnd) вернёт true и пропустит все methods.

    const classBody = code.slice(classStart, classBodyEnd);
    const docstring = extractJsdoc(code, classStart);
    symbols.push({
      type: 'class',
      name: m[1],
      body: classBody,
      docstring,
      lineStart: offsetToLine(lineOffsets, classStart),
      lineEnd: offsetToLine(lineOffsets, classBodyEnd - 1),
      isExported,
      imports: [],
    });

    // Methods внутри класса — ищем в диапазоне между { и }
    const bodyInner = code.slice(classBodyStart + 1, classBodyEnd - 1);
    const innerLineOffset = classBodyStart + 1;
    for (const mm of matchAll(TS_METHOD_RE, bodyInner)) {
      const methodStart = innerLineOffset + mm.index;
      // Пропускаем if/for/while/switch — у них тоже `(...) {`
      const firstWord = mm[1];
      if (['if', 'for', 'while', 'switch', 'catch', 'constructor'].includes(firstWord) && mm[0].match(/^\s*(?:if|for|while|switch|catch)\b/)) {
        continue;
      }
      // Пропускаем control flow keywords
      const sigStart = mm[0].search(/\S/);
      const firstToken = mm[0].slice(sigStart).split(/[\s(]/)[0];
      if (['if', 'for', 'while', 'switch', 'catch', 'do'].includes(firstToken)) continue;

      const bracePos = bodyInner.indexOf('{', mm.index + mm[0].length);
      if (bracePos === -1) continue;
      const methodEnd = findBlockEnd(code, innerLineOffset + bracePos);
      if (methodEnd === -1) continue;
      if (overlaps(methodStart, methodEnd)) continue;
      used.push({ start: methodStart, end: methodEnd });

      const methodBody = code.slice(methodStart, methodEnd);
      symbols.push({
        type: 'method',
        name: firstWord === 'constructor' ? 'constructor' : mm[1],
        body: methodBody,
        docstring: extractJsdoc(code, methodStart),
        lineStart: offsetToLine(lineOffsets, methodStart),
        lineEnd: offsetToLine(lineOffsets, methodEnd - 1),
        isExported: false, // methods не экспортируются напрямую
        imports: [],
      });
    }

    // NOW add class to used — после methods
    used.push({ start: classStart, end: classBodyEnd });
  }

  // Interfaces
  for (const m of matchAll(TS_INTERFACE_RE, code)) {
    const isExported = /export/.test(m[0]);
    const ifaceStart = m.index;
    const ifaceBodyStart = code.indexOf('{', ifaceStart);
    let ifaceEnd: number;
    if (ifaceBodyStart !== -1 && ifaceBodyStart < ifaceStart + 300) {
      ifaceEnd = findBlockEnd(code, ifaceBodyStart);
    } else {
      ifaceEnd = findStatementEnd(code, ifaceStart);
    }
    if (ifaceEnd === -1) continue;
    if (overlaps(ifaceStart, ifaceEnd)) continue;
    used.push({ start: ifaceStart, end: ifaceEnd });

    symbols.push({
      type: 'interface',
      name: m[1],
      body: code.slice(ifaceStart, ifaceEnd),
      docstring: extractJsdoc(code, ifaceStart),
      lineStart: offsetToLine(lineOffsets, ifaceStart),
      lineEnd: offsetToLine(lineOffsets, ifaceEnd - 1),
      isExported,
      imports: [],
    });
  }

  // Type aliases
  for (const m of matchAll(TS_TYPE_RE, code)) {
    const isExported = /export/.test(m[0]);
    const typeStart = m.index;
    const typeEnd = findStatementEnd(code, typeStart);
    if (typeEnd === -1) continue;
    if (overlaps(typeStart, typeEnd)) continue;
    used.push({ start: typeStart, end: typeEnd });

    symbols.push({
      type: 'type',
      name: m[1],
      body: code.slice(typeStart, typeEnd),
      docstring: extractJsdoc(code, typeStart),
      lineStart: offsetToLine(lineOffsets, typeStart),
      lineEnd: offsetToLine(lineOffsets, typeEnd - 1),
      isExported,
      imports: [],
    });
  }

  return symbols.sort((a, b) => a.lineStart - b.lineStart);
}

// ============================================================================
// Python symbol extraction (regex-based)
// ============================================================================

const PY_IMPORT_RE = /^\s*(?:from\s+([\w.]+)\s+import\s+\([^)]*\)|from\s+([\w.]+)\s+import\s+(.+)|import\s+([\w.]+))/gm;

// Python docstring: """...""" или '''...''' в начале function/class/module
const PY_DOCSTRING_RE = /\s*("""[\s\S]*?"""|'''[\s\S]*?''')/;

// def name(args): — поддерживает async def (PEP 492)
const PY_FUNCTION_RE = /^(?:[ \t]*)(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/gm;

// class Name(Base):
const PY_CLASS_RE = /^(?:[ \t]*)class\s+([A-Za-z_][\w]*)\s*[\(:]/gm;

/**
 * Python indentation-based block end.
 * Блок заканчивается, когда встречаем строку с indentation <= baseIndentation
 * (и строка не пустая/не комментарий).
 */
function findPythonBlockEnd(text: string, defLineStart: number): number {
  const lineStart = text.lastIndexOf('\n', defLineStart) + 1;
  // Найти конец строки def
  let pos = text.indexOf('\n', defLineStart);
  if (pos === -1) return text.length;
  // Первая строка после def должна быть с отступом — это начало блока
  // Если следующая строка без отступа → это stub (pass/... в той же строке)
  // Идём по строкам, пока indentation >= bodyIndentation
  let bodyIndentation: number | null = null;
  let i = pos + 1;
  while (i < text.length) {
    const lineEnd = text.indexOf('\n', i);
    const line = text.slice(i, lineEnd === -1 ? text.length : lineEnd);
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      if (lineEnd === -1) return text.length;
      i = lineEnd + 1;
      continue;
    }
    const indent = line.match(/^[ \t]*/)?.[0].length ?? 0;
    if (bodyIndentation === null) {
      if (indent === 0) {
        // Нет body — это oneliner def или stub в той же строке
        return lineEnd === -1 ? text.length : lineEnd;
      }
      bodyIndentation = indent;
    }
    if (indent < bodyIndentation) {
      // Конец блока
      return i;
    }
    if (lineEnd === -1) return text.length;
    i = lineEnd + 1;
  }
  return text.length;
}

function extractPythonDocstring(text: string, afterDefLine: number): string | undefined {
  // Пропускаем пустые строки после def
  let i = afterDefLine;
  while (i < text.length && /\s/.test(text[i])) i++;
  // Ищем """ или '''
  if (text[i] !== '"' || text[i + 1] !== '"' || text[i + 2] !== '"') {
    if (text[i] !== "'" || text[i + 1] !== "'" || text[i + 2] !== "'") return undefined;
  }
  const quote = text.slice(i, i + 3);
  const end = text.indexOf(quote, i + 3);
  if (end === -1) return undefined;
  const raw = text.slice(i + 3, end);
  return raw.trim().slice(0, 500) || undefined;
}

function extractPythonSymbols(code: string): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];
  const lineOffsets = buildLineOffsets(code);
  const used: Array<{ start: number; end: number }> = [];

  const overlaps = (s: number, e: number) => used.some(u => s < u.end && e > u.start);

  // Classes FIRST — иначе top-level functions inside class body
  // "съедают" класс через overlap check (regression found in standalone test).
  // После классов methods внутри класса ищутся отдельно.
  for (const m of matchAll(PY_CLASS_RE, code)) {
    const classStart = m.index;
    if (overlaps(classStart, classStart + 1)) continue;
    const blockEnd = findPythonBlockEnd(code, classStart);
    if (overlaps(classStart, blockEnd)) continue;
    // ВАЖНО: не добавляем class в used ДО поиска methods — иначе
    // overlap check (methodStart, methodEnd) вернёт true и пропустит все methods.

    const body = code.slice(classStart, blockEnd);
    const classLineEnd = code.indexOf('\n', classStart);
    const docstring = extractPythonDocstring(code, classLineEnd === -1 ? blockEnd : classLineEnd + 1);

    symbols.push({
      type: 'class',
      name: m[1],
      body,
      docstring,
      lineStart: offsetToLine(lineOffsets, classStart),
      lineEnd: offsetToLine(lineOffsets, Math.min(blockEnd - 1, code.length - 1)),
      isExported: true,
      imports: [],
    });

    // Methods внутри класса (def внутри блока класса)
    const classBody = code.slice(classStart, blockEnd);
    const classBodyOffset = classStart;
    for (const mm of matchAll(PY_FUNCTION_RE, classBody)) {
      const methodStart = classBodyOffset + mm.index;
      if (overlaps(methodStart, methodStart + 1)) continue;
      const methodEnd = findPythonBlockEnd(code, methodStart);
      if (overlaps(methodStart, methodEnd)) continue;
      used.push({ start: methodStart, end: methodEnd });

      const methodBody = code.slice(methodStart, methodEnd);
      const methodDefLineEnd = code.indexOf('\n', methodStart);
      const methodDoc = extractPythonDocstring(
        code,
        methodDefLineEnd === -1 ? methodEnd : methodDefLineEnd + 1,
      );

      symbols.push({
        type: 'method',
        name: mm[1],
        body: methodBody,
        docstring: methodDoc,
        lineStart: offsetToLine(lineOffsets, methodStart),
        lineEnd: offsetToLine(lineOffsets, Math.min(methodEnd - 1, code.length - 1)),
        isExported: false,
        imports: [],
      });
    }

    // NOW add class to used — после methods (чтобы top-level functions
    // с overlap check пропускали те, что внутри class body)
    used.push({ start: classStart, end: blockEnd });
  }

  // Top-level functions (после классов — overlap check пропустит те,
  // что внутри class body, потому что они уже в used)
  for (const m of matchAll(PY_FUNCTION_RE, code)) {
    const defStart = m.index;
    if (overlaps(defStart, defStart + 1)) continue;
    const blockEnd = findPythonBlockEnd(code, defStart);
    if (overlaps(defStart, blockEnd)) continue;
    used.push({ start: defStart, end: blockEnd });

    const body = code.slice(defStart, blockEnd);
    const defLineEnd = code.indexOf('\n', defStart);
    const docstring = extractPythonDocstring(code, defLineEnd === -1 ? blockEnd : defLineEnd + 1);

    symbols.push({
      type: 'function',
      name: m[1],
      body,
      docstring,
      lineStart: offsetToLine(lineOffsets, defStart),
      lineEnd: offsetToLine(lineOffsets, Math.min(blockEnd - 1, code.length - 1)),
      isExported: true, // В Python всё public по умолчанию
      imports: [],
    });
  }

  return symbols.sort((a, b) => a.lineStart - b.lineStart);
}

// ============================================================================
// Helper: matchAll (Iterator → Array)
// ============================================================================

function matchAll(re: RegExp, text: string): RegExpExecArray[] {
  const results: RegExpExecArray[] = [];
  // Защита от infinite loop — клонируем regex с g flag
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  let m: RegExpExecArray | null;
  while ((m = g.exec(text)) !== null) {
    results.push(m);
  }
  return results;
}

// ============================================================================
// Imports extraction (для metadata)
// ============================================================================

function extractImports(code: string, language: SupportedLanguage): string[] {
  const imports: string[] = [];
  if (language === 'python') {
    for (const m of matchAll(PY_IMPORT_RE, code)) {
      const moduleName = m[1] || m[3] || m[4];
      if (moduleName) imports.push(moduleName);
    }
  } else {
    for (const m of matchAll(TS_IMPORT_RE, code)) {
      imports.push(m[1]);
    }
  }
  return [...new Set(imports)]; // dedup
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Распарсить файл исходного кода и извлечь символы.
 *
 * Если язык не поддерживается или файл пустой — возвращает null.
 * Не бросает исключения (errors логируются, возвращается null).
 *
 * @param filePath relativePath от projectPath
 * @param content текст файла
 */
export function parseCodeFile(
  filePath: string,
  content: string,
): ParsedFile | null {
  const language = detectLanguage(filePath);
  if (!language) return null;

  if (!content || content.trim().length === 0) return null;

  try {
    let symbols: CodeSymbol[];
    switch (language) {
      case 'typescript':
      case 'javascript':
        symbols = extractTsJsSymbols(content);
        break;
      case 'python':
        symbols = extractPythonSymbols(content);
        break;
    }

    const fileImports = extractImports(content, language);
    const contentHash = sha256(content);

    return {
      filePath,
      language,
      symbols,
      fileImports,
      fullContent: content,
      contentHash,
    };
  } catch (e) {
    logger.warn('kb', 'Failed to parse code file', { filePath }, e);
    return null;
  }
}
