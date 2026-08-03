import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { applySchemaPatchesTo } from '../../scripts/lib/apply-schema-patches.mjs';

describe('applySchemaPatchesTo (chat attachments)', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lia-schema-patch-'));
    dbPath = join(dir, 'custom.db');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE Episode (
        id TEXT PRIMARY KEY NOT NULL
      );
      CREATE TABLE Message (
        id TEXT PRIMARY KEY NOT NULL,
        episodeId TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        emotionJson TEXT,
        toolCallsJson TEXT,
        tokensIn INTEGER,
        tokensOut INTEGER,
        durationMs INTEGER,
        createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (episodeId) REFERENCES Episode(id)
      );
    `);
    db.close();
  });

  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('adds attachmentsJson + ChatAttachment once, then no-ops', () => {
    const first = applySchemaPatchesTo(dbPath);
    expect(first.applied).toContain('Message.attachmentsJson');
    expect(first.applied).toContain('ChatAttachment');

    const second = applySchemaPatchesTo(dbPath);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toContain('Message.attachmentsJson');
    expect(second.skipped).toContain('ChatAttachment');

    const db = new Database(dbPath);
    const cols = db.prepare('PRAGMA table_info(Message)').all() as Array<{ name: string }>;
    expect(cols.map(c => c.name)).toContain('attachmentsJson');
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='ChatAttachment'`).all();
    expect(tables.length).toBe(1);
    db.close();
  });

  it('drops legacy Ticket and lia_activity tables', () => {
    const setup = new Database(dbPath);
    setup.exec(`
      CREATE TABLE Ticket (id TEXT PRIMARY KEY, sourceId TEXT NOT NULL);
      CREATE TABLE lia_activity (id TEXT PRIMARY KEY, type TEXT NOT NULL, timestamp INTEGER, summary TEXT);
    `);
    setup.close();

    const r = applySchemaPatchesTo(dbPath);
    expect(r.applied).toContain('drop.Ticket');
    expect(r.applied).toContain('drop.lia_activity');

    const db = new Database(dbPath);
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='Ticket'`).all()).toEqual([]);
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='lia_activity'`).all()).toEqual([]);
    db.close();
  });

  it('reports db-missing when path absent', () => {
    const r = applySchemaPatchesTo(join(dir, 'nope.db'));
    expect(r.skipped).toContain('db-missing');
    expect(r.applied).toEqual([]);
  });
});
