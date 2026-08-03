/**
 * @lia/shared — types shared between Hono backend and React frontend.
 *
 * M1 surface: Health, Resource (stub), Episode, Message, Chat (events + request),
 * Settings (ModelSlots, CapabilityProfile).
 * M2+ expands: StreamingChatEvent, ToolCall, Decision, CodeSymbol, etc.
 */

export * from "./health.js";
export * from "./resource.js";
export * from "./episode.js";
export * from "./message.js";
export * from "./chat.js";
export * from "./settings.js";
export * from "./kb.js";
export * from "./agent.js";
export * from "./code.js";
