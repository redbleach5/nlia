// ============================================================================
// Shared types for settings tabs.
// ============================================================================

import type { AvatarConfig } from '@/lib/avatar-config';

export type Settings = {
  baseUrl: string;
  model: string;
  /** Configured agent model; empty = same as chat. */
  agentModel: string;
  /** Effective model the agent will use. */
  agentModelEffective?: string;
  /** Secondary (trivial); empty = unset. */
  secondaryModel?: string;
  /** Heavy (escalate); empty = unset. */
  heavyModel?: string;
  heavyModelEffective?: string;
  embedModel: string;
  /** Claude Code coding backend (Ollama Anthropic API). */
  claudeCodeEnabled?: boolean;
  claudeCodeModel?: string;
  claudeBinaryOk?: boolean;
  claudeBinaryError?: string;
  ollamaOk: boolean;
  ollamaError?: string;
  availableModels: string[];
  /** Cloud tags from ollama.com catalog (+ local :cloud). */
  availableCloudModels?: string[];
  /** True if DB or env has OLLAMA_API_KEY (value never returned). */
  ollamaApiKeyConfigured?: boolean;
  availableEmbedModels: string[];
  vrmFiles: string[];
  activeVrm: string | null;
  avatarConfig: AvatarConfig;
  /** user.name / default person — как Лия обращается к вам */
  userDisplayName: string | null;
  /** Up to 3 remembered people */
  people?: SettingsPerson[];
  maxPeople?: number;
};

export type SettingsPerson = {
  id: string;
  displayName: string;
  aliases: string[];
  isDefault: boolean;
  lastSeenAt: string | null;
};
