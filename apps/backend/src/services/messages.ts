/**
 * Messages service — list, create, delete for a single episode.
 *
 * Per docs/ARCHITECTURE.md § 5.1. All roles in one table; v3 writes 'companion'
 * (not 'assistant') to match the identity model in § 9.3.
 */

import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { getDb } from "../db/client.js";
import { messages } from "../db/schema.js";
import type { Message, MessageRole } from "@lia/shared";

function makeId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `${ts}${rand}`;
}

function parseRow(row: typeof messages.$inferSelect): Message {
  return {
    id: row.id,
    episodeId: row.episodeId,
    role: row.role as MessageRole,
    content: row.content,
    attachments: row.attachmentsJson ? JSON.parse(row.attachmentsJson) : null,
    emotionJson: row.emotionJson ? JSON.parse(row.emotionJson) : null,
    tokensIn: row.tokensIn,
    tokensOut: row.tokensOut,
    durationMs: row.durationMs,
    createdAt: row.createdAt,
  };
}

/** List all messages in an episode, oldest first. */
export function listMessages(episodeId: string, limit = 200): Message[] {
  const sqlite = getDb();
  const db = drizzle(sqlite);
  const rows = db
    .select()
    .from(messages)
    .where(eq(messages.episodeId, episodeId))
    .orderBy(asc(messages.createdAt), asc(messages.id))
    .limit(limit)
    .all();
  return rows.map(parseRow);
}

/** Insert a message. Returns the parsed Message. */
export function insertMessage(opts: {
  episodeId: string;
  role: MessageRole;
  content: string;
  attachments?: Message["attachments"];
  emotionJson?: unknown;
  tokensIn?: number;
  tokensOut?: number;
  durationMs?: number;
}): Message {
  const sqlite = getDb();
  const db = drizzle(sqlite);
  const id = makeId();
  const now = Math.floor(Date.now() / 1000);
  db.insert(messages)
    .values({
      id,
      episodeId: opts.episodeId,
      role: opts.role,
      content: opts.content,
      attachmentsJson: opts.attachments ? JSON.stringify(opts.attachments) : null,
      emotionJson: opts.emotionJson ? JSON.stringify(opts.emotionJson) : null,
      tokensIn: opts.tokensIn,
      tokensOut: opts.tokensOut,
      durationMs: opts.durationMs,
      createdAt: now,
    })
    .run();
  const row = db.select().from(messages).where(eq(messages.id, id)).get();
  return parseRow(row!);
}

/** Build the AI-SDK message array for streamText. */
export interface AiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

/**
 * Build the messages array for streamText from DB history.
 * Excludes system messages (those go into the `system` param, not messages).
 * Maps v3 'companion' role → AI SDK 'assistant'.
 *
 * Returns a properly-typed array compatible with AI SDK v5's ModelMessage union.
 */
export function buildAiMessages(history: Message[], newUserText: string): AiMessage[] {
  const out: AiMessage[] = [];
  for (const m of history) {
    if (m.role === "system") continue;
    if (m.role === "user") {
      out.push({ role: "user", content: m.content });
    } else if (m.role === "companion" || m.role === "assistant") {
      out.push({ role: "assistant", content: m.content });
    } else if (m.role === "tool") {
      // M5+ tool messages land here. For M1 chat (no tools), skip.
    }
  }
  out.push({ role: "user", content: newUserText });
  return out;
}
