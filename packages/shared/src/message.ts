/**
 * Chat message — see docs/ARCHITECTURE.md § 5.1.
 *
 * v3 uses role 'companion' instead of v2's 'assistant' to match the identity
 * model in § 9.3 (Lia is a companion, not an "assistant" service). The DB
 * column accepts both for forward compatibility, but the chat pipeline always
 * writes 'companion'.
 */

export type MessageRole = "user" | "companion" | "tool" | "system" | "assistant";

export interface MessageAttachment {
  id: string;
  name: string;
  mimeType: string;
  kind: "image" | "text" | "pdf" | "docx";
  sizeBytes: number;
}

export interface Message {
  id: string;
  episodeId: string;
  role: MessageRole;
  content: string;
  attachments: MessageAttachment[] | null;
  emotionJson: unknown | null;
  tokensIn: number | null;
  tokensOut: number | null;
  durationMs: number | null;
  createdAt: number; // unix seconds
}
