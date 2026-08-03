/**
 * Chat pipeline types — shared between backend (emitter) and frontend (consumer).
 *
 * Per docs/ARCHITECTURE.md § 9.2 — SSE event stream carries not just LLM tokens
 * but also progress events so the user sees "Ищу в вебе…" / "Загружаю страницу…"
 * instead of a silent "думаю…" spinner.
 *
 * The frontend ChatPanel renders transient status badges from `status` events
 * and final text from `text_delta` events; `tool_start`/`tool_end` become
 * collapsible cards (M5 lands real tools; M1 chat has none).
 */

export type ChatMode = "chat" | "agent" | "research";

export interface ChatRequest {
  text: string;
  episodeId: string;
  mode?: ChatMode;
  /** Inline resource ids to attach to this message (M2 — WorkspaceService.attachInline results). */
  attachmentIds?: string[];
}

export type ChatEvent =
  | { type: "status"; label: string; ts: number }
  | { type: "tool_start"; tool: string; input: unknown; ts: number }
  | { type: "tool_end"; tool: string; success: boolean; summary: string; ts: number }
  | { type: "text_delta"; text: string; ts: number }
  | { type: "done"; ts: number; tokensIn?: number; tokensOut?: number; durationMs?: number }
  | { type: "error"; message: string; ts: number };

/** Helper: build a ChatEvent with the current timestamp. */
export function chatEvent(ev: Omit<ChatEvent, "ts">): ChatEvent {
  return { ...(ev as object), ts: Date.now() } as ChatEvent;
}
