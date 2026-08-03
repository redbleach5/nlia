// ============================================================================
// Types — shared across all store slices.
// ============================================================================

import { LIA_PERSONALITY, type EmotionVector } from '@/lib/personality';
import type { MessagePart, PartsReduceState } from '@/lib/agent/message-parts';

export type ChatMessage = {
  id: string;
  role: 'user' | 'companion';
  content: string;
  attachments?: ChatAttachmentMeta[];
  emotion?: EmotionVector;
  createdAt: number;
  streaming?: boolean;
  /** Agent turn: inline parts are the UI source of truth. */
  parts?: MessagePart[];
  /** Links message to AgentTask for SSE → parts reducer. */
  agentTaskId?: string;
  /** Opaque reducer bookkeeping (seen ids / metrics) — not persisted. */
  partsState?: PartsReduceState;
};

/** Episode sticky: ask before write vs auto-apply. */
export type AgentApplyMode = 'ask' | 'auto';


export type ChatAttachmentMeta = {
  id: string;
  name: string;
  mimeType: string;
  kind: 'image' | 'text' | 'pdf' | 'docx';
  sizeBytes: number;
};

export type Episode = {
  id: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  /** Preview of the latest message (for sidebar). */
  preview?: string | null;
};

// Строгий union для статусов задачи — раньше был string.
export type AgentTaskStatus =
  | 'pending'
  | 'planning'
  | 'executing'
  | 'waiting_input'
  | 'synthesizing'
  | 'done'
  | 'failed'
  | 'cancelled';

export type AgentTask = {
  id: string;
  episodeId: string;
  goal: string;
  status: AgentTaskStatus;
  currentStep: number;
  maxSteps: number;
  /** 0 = unbounded duration. Soft budget + wall watchdog skipped. */
  maxDurationSec: number;
  error: string | null;
  resultSummary: string | null;
  createdAt: string;
  /** Absolute workspace path when set (project root or sandbox). */
  fsScope?: string | null;
};

// Real-time step data for the active task (from SSE)
export type AgentStepLive = {
  step: number;
  thought: string;
  action: string;
  observation: string;
  durationMs?: number;
  tools?: Array<{ name: string; input: unknown; success: boolean; output: unknown }>;
  ts: number;
};

export type AgentPlanLive = {
  goal: string;
  steps: string[];
  complexity: string;
  targetFiles?: string[];
};

export type ProjectDesignLive = {
  name: string;
  kind: string;
  stack: string[];
  tree: Array<{ path: string; role: string }>;
  scripts: Record<string, string | undefined>;
  preview: { type: string; port?: number; url?: string };
  entry?: string;
  acceptance: string;
  createdBy?: string;
};

export type RuntimeLogLive = {
  stream: 'stdout' | 'stderr' | 'system';
  text: string;
  ts: number;
};

export type RuntimeStatusLive = {
  status: string;
  port?: number | null;
  previewUrl?: string | null;
  pid?: number | null;
  restartCount?: number;
  lastError?: string | null;
  scriptKey?: string | null;
};

export type ChatMode = 'auto' | 'agent';

/** Agent workspace mode — orthogonal to ChatMode (Диалог | Агент). */
export type AgentWorkspaceModeInput = 'auto' | 'read' | 'explore' | 'edit';

export const INITIAL_EMOTION: EmotionVector = { ...LIA_PERSONALITY.baselineEmotion };
