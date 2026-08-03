/**
 * KB search tests — chunker, BM25, RRF, MMR, hybrid search.
 *
 * Tests the M4 KB stack:
 *   - Document chunker (headings, paragraphs, overlap, contentHash)
 *   - BM25 (tokenizer, stemmer, scoring)
 *   - RRF fusion (combine ranked lists)
 *   - MMR diversification (dedupe same-file chunks)
 *   - Hybrid search (vector + BM25 + RRF + MMR) — with mocked embeddings
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { chunkDocument, sha256 } from "../src/kb/chunker.js";
import { rrf, mmrDiversify } from "../src/kb/rrf.js";
import { bm25Search, invalidateBm25Cache } from "../src/kb/bm25.js";
import { invalidateVectorCache } from "../src/kb/vector-search.js";
import { hybridSearch } from "../src/kb/search.js";
import { indexFolderResource } from "../src/kb/indexer.js";
import { app } from "../src/index.js";
import { closeDb, getDb } from "../src/db/client.js";
import { pushSchema } from "../src/db/push.js";
import { createEpisode } from "../src/services/episodes.js";
import { mount } from "../src/workspace/service.js";
import type { SearchResult } from "@lia/shared";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("Document chunker", () => {
  it("chunks plain text by paragraphs", () => {
    const text = "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.";
    const chunks = chunkDocument(text);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(chunks[0]!.content).toContain("First paragraph");
  });

  it("splits by markdown headings", () => {
    const text = "# Title\n\nThis is the introduction paragraph with enough content to not be merged.\n\n## Section 1\n\nContent for section one with sufficient length to remain separate.\n\n## Section 2\n\nContent for section two with sufficient length to remain separate.";
    const chunks = chunkDocument(text);
    expect(chunks.length).toBe(3); // Title, Section 1, Section 2
    expect(chunks[0]!.metadata.heading).toBe("Title");
    expect(chunks[1]!.metadata.heading).toBe("Section 1");
    expect(chunks[2]!.metadata.heading).toBe("Section 2");
  });

  it("preserves heading path hierarchy", () => {
    const text = "# Chapter\n\nThis is the chapter intro with enough content to avoid merging into nothing.\n\n## Section\n\nThis is the section content with enough text to remain a separate chunk.";
    const chunks = chunkDocument(text);
    const sectionChunk = chunks.find((c) => c.metadata.heading === "Section");
    expect(sectionChunk?.metadata.path).toBe("Chapter > Section");
  });

  it("merges short chunks with previous", () => {
    const text = "# Heading\n\nLong enough content here.\n\nx.";
    const chunks = chunkDocument(text);
    // The "x." chunk (< 50 chars) should be merged into the previous chunk
    expect(chunks.length).toBe(1);
  });

  it("computes contentHash (SHA-256)", () => {
    const text = "Test content";
    const chunks = chunkDocument(text);
    expect(chunks[0]!.contentHash).toBe(sha256(chunks[0]!.content));
    expect(chunks[0]!.contentHash).toHaveLength(64); // SHA-256 hex
  });

  it("returns empty array for empty input", () => {
    expect(chunkDocument("")).toEqual([]);
    expect(chunkDocument("   ")).toEqual([]);
  });

  it("splits long sections with overlap", () => {
    // Create content with multiple paragraphs totaling > 2000 chars
    const para1 = "First paragraph with substantial content. ".repeat(30); // ~1500 chars
    const para2 = "Second paragraph with different content. ".repeat(30); // ~1500 chars
    const text = `# Big\n\n${para1}\n\n${para2}`;
    const chunks = chunkDocument(text);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("includes mimeType and filePath in metadata", () => {
    const chunks = chunkDocument("Test", {
      mimeType: "text/markdown",
      filePath: "docs/readme.md",
    });
    expect(chunks[0]!.metadata.mimeType).toBe("text/markdown");
    expect(chunks[0]!.metadata.filePath).toBe("docs/readme.md");
  });
});

describe("RRF fusion", () => {
  it("combines two ranked lists", () => {
    const listA: SearchResult[] = [
      { chunkId: "a", resourceId: "r1", content: "a", metadata: {}, score: 0.9, matchType: "vector", resourceName: "R1", resourceKind: "folder" },
      { chunkId: "b", resourceId: "r1", content: "b", metadata: {}, score: 0.8, matchType: "vector", resourceName: "R1", resourceKind: "folder" },
    ];
    const listB: SearchResult[] = [
      { chunkId: "b", resourceId: "r1", content: "b", metadata: {}, score: 5, matchType: "bm25", resourceName: "R1", resourceKind: "folder" },
      { chunkId: "c", resourceId: "r1", content: "c", metadata: {}, score: 3, matchType: "bm25", resourceName: "R1", resourceKind: "folder" },
    ];

    const fused = rrf([listA, listB]);
    // 'b' appears in both lists → should rank highest
    expect(fused[0]!.chunkId).toBe("b");
    expect(fused[0]!.matchType).toBe("fused");
  });

  it("handles empty lists", () => {
    expect(rrf([])).toEqual([]);
    expect(rrf([[]])).toEqual([]);
  });
});

describe("MMR diversification", () => {
  it("deduplicates chunks from same file", () => {
    const results: SearchResult[] = [
      { chunkId: "1", resourceId: "r1", content: "a", metadata: { filePath: "file.md" }, score: 0.9, matchType: "fused", resourceName: "R1", resourceKind: "folder" },
      { chunkId: "2", resourceId: "r1", content: "b", metadata: { filePath: "file.md" }, score: 0.85, matchType: "fused", resourceName: "R1", resourceKind: "folder" },
      { chunkId: "3", resourceId: "r1", content: "c", metadata: { filePath: "other.md" }, score: 0.7, matchType: "fused", resourceName: "R1", resourceKind: "folder" },
    ];

    const diversified = mmrDiversify(results, 0.7, 3);
    // Should prefer diverse results: 1 from file.md + 1 from other.md
    const filePaths = new Set(diversified.map((r) => r.metadata.filePath));
    expect(filePaths.size).toBeGreaterThan(1);
  });

  it("returns single result unchanged", () => {
    const results: SearchResult[] = [
      { chunkId: "1", resourceId: "r1", content: "a", metadata: {}, score: 0.9, matchType: "fused", resourceName: "R1", resourceKind: "folder" },
    ];
    expect(mmrDiversify(results)).toEqual(results);
  });
});

describe("BM25 search", () => {
  let episodeId: string;
  let tempFolder: string;
  let resourceId: string;

  beforeAll(() => {
    getDb();
    pushSchema();
    const ep = createEpisode({ title: "BM25 test" });
    episodeId = ep.id;

    // Create temp folder with test files
    tempFolder = mkdtempSync(join(tmpdir(), "lia-bm25-"));
    writeFileSync(
      join(tempFolder, "python-guide.txt"),
      "Python is a programming language. Python is great for data science and machine learning.",
    );
    writeFileSync(
      join(tempFolder, "rust-guide.txt"),
      "Rust is a systems programming language focused on safety and performance.",
    );
  });

  afterAll(() => {
    closeDb();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    invalidateBm25Cache();
  });

  it("finds chunks by keyword after indexing", async () => {
    // Mount folder + index it
    const resource = await mount(episodeId, {
      kind: "folder",
      path: tempFolder,
      name: "BM25 test folder",
    });
    resourceId = resource.id;

    // Mock Ollama for embedding
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/api/tags")) {
          return new Response(
            JSON.stringify({ models: [{ name: "qwen3:8b" }, { name: "nomic-embed-text" }] }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.endsWith("/api/embed")) {
          const embedding = new Array(768).fill(0).map((_, i) => i / 768);
          return new Response(
            JSON.stringify({ embeddings: [embedding] }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("not found", { status: 404 });
      }),
    );

    await indexFolderResource(resourceId);
    invalidateBm25Cache();

    const results = bm25Search("Python programming", { limit: 5 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.content).toContain("Python");
  });

  it("returns empty for no matches", () => {
    invalidateBm25Cache();
    const results = bm25Search("xyznonexistent");
    expect(results).toEqual([]);
  });
});

describe("Hybrid search API", () => {
  let episodeId: string;
  let tempFolder: string;
  let resourceId: string;

  beforeAll(async () => {
    getDb();
    pushSchema();
    const ep = createEpisode({ title: "Hybrid search test" });
    episodeId = ep.id;

    // Create temp folder with searchable content
    tempFolder = mkdtempSync(join(tmpdir(), "lia-hybrid-"));
    writeFileSync(
      join(tempFolder, "ai-doc.txt"),
      "This document discusses artificial intelligence and neural networks in detail. Machine learning is a subset of AI.",
    );

    // Mock Ollama
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/api/tags")) {
          return new Response(
            JSON.stringify({ models: [{ name: "qwen3:8b" }, { name: "nomic-embed-text" }] }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.endsWith("/api/embed")) {
          const embedding = new Array(768).fill(0).map((_, i) => i / 768);
          return new Response(
            JSON.stringify({ embeddings: [embedding] }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("not found", { status: 404 });
      }),
    );

    // Mount + index
    const resource = await mount(episodeId, {
      kind: "folder",
      path: tempFolder,
      name: "Hybrid search folder",
    });
    resourceId = resource.id;
    await indexFolderResource(resourceId);
    invalidateBm25Cache();
    invalidateVectorCache();
  });

  afterAll(() => {
    closeDb();
    vi.restoreAllMocks();
  });

  it("GET /api/episodes/:episodeId/search returns 400 without query", async () => {
    const res = await app.request(`/api/episodes/${episodeId}/search`);
    expect(res.status).toBe(400);
  });

  it("GET /api/episodes/:episodeId/search?q=... returns SearchResponse", async () => {
    const res = await app.request(`/api/episodes/${episodeId}/search?q=artificial+intelligence`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results).toBeInstanceOf(Array);
    expect(body.totalChunks).toBeGreaterThan(0);
    expect(body.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("returns 404 for unknown episode", async () => {
    const res = await app.request(`/api/episodes/nonexistent/search?q=test`);
    expect(res.status).toBe(404);
  });
});
