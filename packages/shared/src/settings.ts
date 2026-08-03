/**
 * Model slots + capability profile.
 *
 * Per docs/ARCHITECTURE.md § 11.5 — Settings → Model tab exposes 4 slots:
 *   - chat    : model used for companion chat
 *   - agent   : model for agent tasks (empty = same as chat)
 *   - heavy   : model for escalate (empty = no escalate)
 *   - embed   : model for embeddings (empty = auto-detect)
 *
 * Plus ollama.baseUrl for remote Ollama instances (see v2 REMOTE-OLLAMA.md).
 */

export interface ModelSlots {
  baseUrl: string;
  chat: string;
  /** Empty string = "same as chat". */
  agent: string;
  /** Empty string = escalate no-ops. */
  heavy: string;
  /** Empty string = "auto" (auto-detect from Ollama /api/tags). */
  embed: string;
}

export interface CapabilityProfile {
  /** Is Ollama reachable right now? */
  ollamaOk: boolean;
  /** Error message if ollamaOk is false. */
  error?: string;
  /** All models currently pulled in Ollama (from /api/tags). */
  models: string[];
  /** Non-embed models suitable for chat/agent/heavy slots. */
  chatModels: string[];
  /** Embed-pattern models suitable for the embed slot. */
  embedModels: string[];
  /** Effective model names after applying slot resolution + fallbacks. */
  effective: {
    chat: string;
    agent: string;
    heavy: string;
    embed: string;
  };
  /** Whether the configured embed model is explicitly set (vs auto). */
  embedExplicit: boolean;
  /** True when configured chat model was missing and a fallback was used. */
  chatFallback?: boolean;
}
