/**
 * Agent types — shared between backend (orchestrator) and frontend (agent workbench).
 *
 * Per docs/ARCHITECTURE.md § 8.1 + § 9.2 — agent SSE stream carries the same
 * ChatEvent types as chat, plus agent-specific events (ask_user, finalize).
 */

export type AgentTaskStatus =
  | "pending"
  | "executing"
  | "waiting_input"
  | "done"
  | "failed"
  | "cancelled";

export type AgentTemplate = "general" | "researcher" | "coder";

export interface AgentTask {
  id: string;
  episodeId: string;
  goal: string;
  templateName: AgentTemplate | null;
  status: AgentTaskStatus;
  toolsWhitelist: string[] | null;
  fsScope: string | null;
  maxSteps: number;
  maxDurationSec: number;
  currentStep: number;
  events: AgentEvent[];
  decisionIds: string[];
  resultSummary: string | null;
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
}

/** Streaming event persisted in eventsJson + emitted via SSE. */
export type AgentEvent =
  | { type: "status"; label: string; ts: number }
  | { type: "text_delta"; text: string; ts: number }
  | { type: "tool_start"; tool: string; input: unknown; ts: number }
  | { type: "tool_end"; tool: string; success: boolean; summary: string; output?: unknown; ts: number }
  | { type: "ask_user"; question: string; ts: number }
  | { type: "user_answer"; answer: string; ts: number }
  | { type: "finalize"; summary: string; ts: number }
  | {
      type: "file_propose";
      changeId: string;
      path: string;
      tool: "write_file" | "apply_patch" | "write_files";
      created: boolean;
      diff?: string;
      ts: number;
    }
  | {
      type: "file_applied";
      changeId: string;
      path: string;
      ts: number;
    }
  | {
      type: "file_rejected";
      changeId: string;
      path: string;
      ts: number;
    }
  | {
      type: "file_undone";
      changeId: string;
      path: string;
      ts: number;
    }
  | {
      type: "git_propose_commit";
      actionId: string;
      message: string;
      summary: string;
      files: string[];
      branch: string | null;
      ts: number;
    }
  | {
      type: "git_propose_push";
      actionId: string;
      remote: string;
      branch: string | null;
      summary: string;
      ts: number;
    }
  | {
      type: "git_committed";
      actionId: string;
      sha: string;
      message: string;
      ts: number;
    }
  | {
      type: "git_pushed";
      actionId: string;
      remote: string;
      branch: string;
      ts: number;
    }
  | {
      type: "git_rejected";
      actionId: string;
      kind: "commit" | "push";
      ts: number;
    }
  | {
      type: "deploy_propose";
      actionId: string;
      preset: string;
      command: string;
      summary: string;
      ts: number;
    }
  | {
      type: "deploy_done";
      actionId: string;
      preset: string;
      ok: boolean;
      summary: string;
      ts: number;
    }
  | {
      type: "deploy_rejected";
      actionId: string;
      preset: string;
      ts: number;
    }
  | {
      type: "ssh_propose";
      actionId: string;
      host: string;
      command: string;
      summary: string;
      ts: number;
    }
  | {
      type: "ssh_done";
      actionId: string;
      host: string;
      ok: boolean;
      summary: string;
      ts: number;
    }
  | {
      type: "ssh_rejected";
      actionId: string;
      host: string;
      ts: number;
    }
  | {
      type: "verify_start";
      names: string[];
      ts: number;
    }
  | {
      type: "verify_done";
      ok: boolean;
      failed: string | null;
      summary: string;
      results: Array<{ name: string; ok: boolean; code: number; durationMs: number }>;
      ts: number;
    }
  | { type: "error"; message: string; ts: number }
  | { type: "done"; ts: number; durationMs?: number };

/** Pending/applied file edit proposed by the agent (ask mode). */
export interface AgentFileChangeDTO {
  id: string;
  taskId: string;
  path: string;
  tool: "write_file" | "apply_patch" | "write_files";
  status: "pending" | "applied" | "rejected" | "undone";
  created: boolean;
  canUndo: boolean;
  diff?: string;
  createdAt: number;
}

export interface CreateAgentTaskRequest {
  episodeId: string;
  goal: string;
  template?: AgentTemplate;
  fsScope?: string;
  toolsWhitelist?: string[];
  maxSteps?: number;
  maxDurationSec?: number;
  autoStart?: boolean;
}

/** Decision log entry (mirrors backend DecisionDTO). */
export type DecisionModelRole = "day" | "heavy" | "agent";

export interface DecisionDTO {
  id: string;
  taskId: string | null;
  episodeId: string;
  ts: number;
  situation: string;
  options: string[];
  chosen: string;
  rationale: string;
  outcome: string | null;
  modelRole: DecisionModelRole;
}
