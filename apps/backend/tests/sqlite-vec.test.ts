/**
 * Smoke test: sqlite-vec extension is loaded and kb_vec_virtual works.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { closeDb, getDb, EMBEDDING_DIMENSION } from "../src/db/client.js";

describe("sqlite-vec", () => {
  beforeAll(() => {
    getDb();
  });

  afterAll(() => {
    closeDb();
  });

  it("exposes vec_version()", () => {
    const db = getDb();
    const row = db.prepare("SELECT vec_version() AS v").get() as { v: string };
    expect(row.v).toBeTruthy();
  });

  it("kb_vec_virtual table exists", () => {
    const db = getDb();
    const row = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='kb_vec_virtual'",
      )
      .get() as { name: string } | undefined;
    expect(row?.name).toBe("kb_vec_virtual");
  });

  it("can insert and KNN-search a vector", () => {
    const db = getDb();
    // Make a deterministic test vector
    const vec = new Float32Array(EMBEDDING_DIMENSION).fill(0);
    vec[0] = 1.0;

    // vec0 uses implicit rowid — let it auto-assign, then clean up by rowid.
    const insert = db.prepare(
      "INSERT INTO kb_vec_virtual (embedding) VALUES (?)",
    );
    const del = db.prepare("DELETE FROM kb_vec_virtual WHERE rowid = ?");

    const tx = db.transaction(() => {
      insert.run(vec);
    });
    tx();

    // Read back the rowid we just inserted
    const inserted = db
      .prepare("SELECT rowid FROM kb_vec_virtual ORDER BY rowid DESC LIMIT 1")
      .get() as { rowid: number | bigint } | undefined;
    expect(inserted).toBeDefined();
    const rowid =
      typeof inserted!.rowid === "bigint"
        ? Number(inserted!.rowid)
        : inserted!.rowid;

    // KNN search: find nearest 1 to the same vector
    const result = db
      .prepare(
        "SELECT rowid, distance FROM kb_vec_virtual WHERE embedding MATCH ? ORDER BY distance LIMIT 1",
      )
      .get(vec) as { rowid: number | bigint; distance: number } | undefined;

    expect(result).toBeDefined();
    const resultRowid =
      typeof result!.rowid === "bigint"
        ? Number(result!.rowid)
        : result!.rowid;
    expect(resultRowid).toBe(rowid);
    expect(result!.distance).toBeLessThan(1e-6);

    // Cleanup
    del.run(rowid);
  });
});
