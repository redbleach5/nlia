/**
 * Code symbol tests — parser, indexer, service, API routes.
 *
 * Tests the M6 code search stack:
 *   - Code parser: TS/JS/Python symbol extraction
 *   - Code indexer: parse + persist symbols + references
 *   - Code service: searchSymbols, listReferences, listDefinitions, listImporters
 *   - API routes: symbol search, references, definitions, importers
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { app } from "../src/index.js";
import { closeDb, getDb } from "../src/db/client.js";
import { pushSchema } from "../src/db/push.js";
import { createEpisode } from "../src/services/episodes.js";
import { mount } from "../src/workspace/service.js";
import { indexCodebaseResource } from "../src/code/indexer.js";
import { parseFile, detectLanguage } from "../src/code/parser.js";
import {
  searchSymbols,
  listReferences,
  listDefinitions,
  listImporters,
  listFileSymbols,
} from "../src/code/service.js";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CodeSymbol, CodeReference } from "@lia/shared";

describe("Code parser", () => {
  it("detects language from file extension", () => {
    expect(detectLanguage("file.ts")).toBe("typescript");
    expect(detectLanguage("file.tsx")).toBe("typescript");
    expect(detectLanguage("file.js")).toBe("javascript");
    expect(detectLanguage("file.py")).toBe("python");
    expect(detectLanguage("file.txt")).toBeNull();
  });

  it("extracts TypeScript functions", () => {
    const code = `
export function authenticateUser(token: string): boolean {
  return token.length > 0;
}

function helper(): void {
  console.log("helper");
}
`;
    const parsed = parseFile("auth.ts", code);
    expect(parsed.language).toBe("typescript");
    expect(parsed.symbols.length).toBeGreaterThanOrEqual(2);
    const authFunc = parsed.symbols.find((s) => s.name === "authenticateUser");
    expect(authFunc).toBeDefined();
    expect(authFunc!.type).toBe("function");
    expect(authFunc!.isExported).toBe(true);
    expect(authFunc!.lineStart).toBe(2);
  });

  it("extracts TypeScript classes + methods", () => {
    const code = `
export class UserService {
  private db: any;

  constructor(db: any) {
    this.db = db;
  }

  public async getUser(id: string): Promise<User> {
    return this.db.find(id);
  }
}
`;
    const parsed = parseFile("service.ts", code);
    const cls = parsed.symbols.find((s) => s.name === "UserService" && s.type === "class");
    expect(cls).toBeDefined();
    expect(cls!.isExported).toBe(true);

    const method = parsed.symbols.find((s) => s.name === "getUser" && s.type === "method");
    expect(method).toBeDefined();
  });

  it("extracts TypeScript interfaces + types", () => {
    const code = `
export interface User {
  id: string;
  name: string;
}

export type UserStatus = 'active' | 'inactive';
`;
    const parsed = parseFile("types.ts", code);
    const iface = parsed.symbols.find((s) => s.name === "User" && s.type === "interface");
    expect(iface).toBeDefined();
    expect(iface!.isExported).toBe(true);

    const type = parsed.symbols.find((s) => s.name === "UserStatus" && s.type === "type");
    expect(type).toBeDefined();
  });

  it("extracts imports", () => {
    const code = `
import { readFile } from 'fs/promises';
import path from 'path';
const crypto = require('crypto');
`;
    const parsed = parseFile("imports.ts", code);
    expect(parsed.imports).toContain("fs/promises");
    expect(parsed.imports).toContain("path");
    expect(parsed.imports).toContain("crypto");
  });

  it("extracts Python functions + classes", () => {
    const code = `
def authenticate_user(token):
    return len(token) > 0

class UserService:
    def __init__(self, db):
        self.db = db

    def get_user(self, id):
        return self.db.find(id)
`;
    const parsed = parseFile("service.py", code);
    expect(parsed.language).toBe("python");

    const func = parsed.symbols.find((s) => s.name === "authenticate_user" && s.type === "function");
    expect(func).toBeDefined();

    const cls = parsed.symbols.find((s) => s.name === "UserService" && s.type === "class");
    expect(cls).toBeDefined();

    const method = parsed.symbols.find((s) => s.name === "get_user" && s.type === "method");
    expect(method).toBeDefined();
  });

  it("computes contentHash for dedup", () => {
    const code = "export function foo() { return 1; }";
    const parsed = parseFile("foo.ts", code);
    expect(parsed.symbols[0]!.contentHash).toHaveLength(64);
    expect(parsed.contentHash).toHaveLength(64);
  });
});

describe("Code indexer + service", () => {
  let episodeId: string;
  let tempFolder: string;
  let resourceId: string;

  beforeAll(async () => {
    getDb();
    pushSchema();
    const ep = createEpisode({ title: "Code indexer test" });
    episodeId = ep.id;

    // Create temp codebase with TS files
    tempFolder = mkdtempSync(join(tmpdir(), "lia-code-"));
    mkdirSync(join(tempFolder, "src"));

    writeFileSync(
      join(tempFolder, "src", "auth.ts"),
      `export function authenticateUser(token: string): boolean {
  return token.length > 0;
}

export function logout(): void {
  console.log("logged out");
}
`,
    );

    writeFileSync(
      join(tempFolder, "src", "service.ts"),
      `import { authenticateUser } from './auth';

export class UserService {
  private token: string;

  constructor(token: string) {
    this.token = token;
  }

  public validate(): boolean {
    return authenticateUser(this.token);
  }
}
`,
    );

    // Mock Ollama (not needed for code indexing, but mount may trigger KB indexing)
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/api/tags")) {
          return new Response(
            JSON.stringify({ models: [{ name: "qwen3:8b" }] }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("not found", { status: 404 });
      }),
    );

    // Mount codebase + index
    const resource = await mount(episodeId, {
      kind: "codebase",
      path: tempFolder,
      name: "Test codebase",
      languages: ["typescript"],
    });
    resourceId = resource.id;
    await indexCodebaseResource(resourceId);
  });

  afterAll(() => {
    closeDb();
    vi.restoreAllMocks();
  });

  it("indexed symbols from codebase", () => {
    const results = searchSymbols("authenticate", { resourceIds: [resourceId] });
    expect(results.length).toBeGreaterThan(0);
    const authSymbol = results.find((r) => r.symbol.name === "authenticateUser");
    expect(authSymbol).toBeDefined();
    expect(authSymbol!.symbol.symbolType).toBe("function");
    expect(authSymbol!.symbol.filePath).toBe("src/auth.ts");
  });

  it("finds references to a symbol", () => {
    // First find the authenticateUser symbol
    const results = searchSymbols("authenticateUser", { resourceIds: [resourceId] });
    expect(results.length).toBeGreaterThan(0);
    const symbolId = results[0]!.symbol.id;

    // List references
    const { symbol, references } = listReferences(symbolId);
    expect(symbol).not.toBeNull();
    expect(symbol!.name).toBe("authenticateUser");
    // Should have at least 1 reference (the call in service.ts)
    expect(references.length).toBeGreaterThanOrEqual(1);
    const callRef = references.find((r) => r.kind === "call");
    expect(callRef).toBeDefined();
    expect(callRef!.filePath).toBe("src/service.ts");
  });

  it("finds definitions by name", () => {
    const defs = listDefinitions("authenticateUser", { resourceIds: [resourceId] });
    expect(defs.length).toBeGreaterThan(0);
    expect(defs[0]!.name).toBe("authenticateUser");
    expect(defs[0]!.symbolType).toBe("function");
    expect(defs[0]!.filePath).toBe("src/auth.ts");
  });

  it("finds importers of a file", () => {
    const importers = listImporters("src/auth.ts", { resourceIds: [resourceId] });
    // service.ts imports from auth.ts
    expect(importers.length).toBeGreaterThan(0);
    const serviceImporter = importers.find((r) => r.filePath === "src/service.ts");
    expect(serviceImporter).toBeDefined();
    expect(serviceImporter!.kind).toBe("import");
  });

  it("lists symbols in a specific file", () => {
    const symbols = listFileSymbols("src/auth.ts", { resourceIds: [resourceId] });
    expect(symbols.length).toBeGreaterThanOrEqual(2); // authenticateUser + logout
    const names = symbols.map((s) => s.name);
    expect(names).toContain("authenticateUser");
    expect(names).toContain("logout");
  });
});

describe("Code API routes", () => {
  let episodeId: string;
  let tempFolder: string;
  let resourceId: string;

  beforeAll(async () => {
    getDb();
    pushSchema();
    const ep = createEpisode({ title: "Code API test" });
    episodeId = ep.id;

    // Create temp codebase
    tempFolder = mkdtempSync(join(tmpdir(), "lia-code-api-"));
    writeFileSync(
      join(tempFolder, "utils.ts"),
      `export function formatDate(d: Date): string {
  return d.toISOString();
}

export function parseDate(s: string): Date {
  return new Date(s);
}
`,
    );

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/api/tags")) {
          return new Response(
            JSON.stringify({ models: [{ name: "qwen3:8b" }] }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("not found", { status: 404 });
      }),
    );

    const resource = await mount(episodeId, {
      kind: "codebase",
      path: tempFolder,
      name: "API test codebase",
    });
    resourceId = resource.id;
    await indexCodebaseResource(resourceId);
  });

  afterAll(() => {
    closeDb();
    vi.restoreAllMocks();
  });

  it("GET /api/resources/:id/symbols/search?q=format returns symbols", async () => {
    const res = await app.request(`/api/resources/${resourceId}/symbols/search?q=format`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results.length).toBeGreaterThan(0);
    expect(body.results[0].symbol.name).toBe("formatDate");
  });

  it("GET /api/resources/:id/symbols returns all symbols", async () => {
    const res = await app.request(`/api/resources/${resourceId}/symbols`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.symbols.length).toBeGreaterThanOrEqual(2);
  });

  it("GET /api/resources/:id/definitions/:name returns definition", async () => {
    const res = await app.request(`/api/resources/${resourceId}/definitions/formatDate`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.definitions.length).toBeGreaterThan(0);
    expect(body.definitions[0].name).toBe("formatDate");
  });

  it("GET /api/resources/:id/symbols returns 400 without query for search", async () => {
    const res = await app.request(`/api/resources/${resourceId}/symbols/search`);
    expect(res.status).toBe(400);
  });
});
