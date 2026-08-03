/**
 * Typed API client — thin wrappers over fetch for each backend endpoint.
 *
 * All paths go through Vite's /api proxy in dev (see vite.config.ts) and
 * through Tauri's http://127.0.0.1:8787 in production (Tauri sidecar).
 */

import type {
  CapabilityProfile,
  ChatRequest,
  EnsureDefaultResponse,
  Episode,
  EpisodeListItem,
  Message,
  ModelSlots,
  MountResourceRequest,
  Resource,
  ResourceReadResponse,
  AgentTask,
  AgentEvent,
  AgentFileChangeDTO,
  DecisionDTO,
} from "@lia/shared";

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: unknown,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(res.status, body, `HTTP ${res.status}: ${JSON.stringify(body)}`);
  }
  return body as T;
}

// ─── Health ───────────────────────────────────────────────────────────
export async function getHealth() {
  const res = await fetch("/api/health");
  return jsonOrThrow<{
    status: string;
    runtime: string;
    sqliteVec: boolean;
    vecVersion: string | null;
    schemaVersion: string | null;
  }>(res);
}

// ─── Episodes ─────────────────────────────────────────────────────────
export async function listEpisodes(): Promise<EpisodeListItem[]> {
  const res = await fetch("/api/episodes");
  const body = await jsonOrThrow<{ episodes: EpisodeListItem[] }>(res);
  return body.episodes;
}

export async function createEpisode(opts?: { title?: string | null; mode?: "chat" | "agent" | "research" }): Promise<Episode> {
  const res = await fetch("/api/episodes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(opts ?? {}),
  });
  const body = await jsonOrThrow<{ episode: Episode }>(res);
  return body.episode;
}

export async function ensureDefaultEpisode(): Promise<EnsureDefaultResponse> {
  const res = await fetch("/api/episodes/ensure-default", { method: "POST" });
  return jsonOrThrow<EnsureDefaultResponse>(res);
}

export async function deleteEpisode(id: string): Promise<void> {
  const res = await fetch(`/api/episodes/${id}`, { method: "DELETE" });
  await jsonOrThrow<{ ok: boolean }>(res);
}

export async function clearEpisodes(keepId?: string | null): Promise<{
  deleted: number;
  keepId: string | null;
  episodes: EpisodeListItem[];
}> {
  const res = await fetch("/api/episodes/clear", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ keepId: keepId ?? undefined }),
  });
  return jsonOrThrow(res);
}

export async function renameEpisode(id: string, title: string): Promise<Episode> {
  const res = await fetch(`/api/episodes/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  const body = await jsonOrThrow<{ episode: Episode }>(res);
  return body.episode;
}

// ─── Messages ─────────────────────────────────────────────────────────
export async function listMessages(episodeId: string): Promise<Message[]> {
  const res = await fetch(`/api/episodes/${episodeId}/messages`);
  const body = await jsonOrThrow<{ messages: Message[] }>(res);
  return body.messages;
}

// ─── Chat (SSE) ───────────────────────────────────────────────────────
export interface ChatStreamCallbacks {
  onEvent: (ev: import("@lia/shared").ChatEvent) => void;
  onError?: (err: Error) => void;
}

/**
 * POST /api/chat and stream ChatEvents via SSE.
 *
 * Returns an AbortController — call .abort() to stop the stream (also
 * signals the backend to abort the LLM call via req.signal).
 */
export function streamChat(req: ChatRequest, callbacks: ChatStreamCallbacks): AbortController {
  const controller = new AbortController();
  void (async () => {
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify(req),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new ApiError(res.status, body, `chat HTTP ${res.status}`);
      }
      if (!res.body) throw new Error("no response body");

      // Parse SSE stream manually (EventSource doesn't support POST).
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE events are separated by \n\n
        let sepIdx: number;
        while ((sepIdx = buffer.indexOf("\n\n")) !== -1) {
          const rawEvent = buffer.slice(0, sepIdx);
          buffer = buffer.slice(sepIdx + 2);

          // Parse "data: <json>\n" lines
          const dataLines = rawEvent
            .split("\n")
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trim());
          if (dataLines.length === 0) continue;
          const dataStr = dataLines.join("\n");
          try {
            const ev = JSON.parse(dataStr) as import("@lia/shared").ChatEvent;
            callbacks.onEvent(ev);
          } catch (e) {
            // Malformed SSE event — log and continue
            console.warn("malformed SSE event:", dataStr, e);
          }
        }
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      callbacks.onError?.(err as Error);
    }
  })();
  return controller;
}

// ─── Settings ─────────────────────────────────────────────────────────
export async function getSettings(): Promise<ModelSlots> {
  const res = await fetch("/api/settings");
  return jsonOrThrow<ModelSlots>(res);
}

export async function updateSettings(patch: Partial<ModelSlots>): Promise<ModelSlots> {
  const res = await fetch("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  return jsonOrThrow<ModelSlots>(res);
}

// ─── Capability ───────────────────────────────────────────────────────
export async function getCapability(): Promise<CapabilityProfile> {
  const res = await fetch("/api/capability");
  return jsonOrThrow<CapabilityProfile>(res);
}

// ─── Resources (WorkspaceService) ─────────────────────────────────────
export async function listResources(
  episodeId: string,
  opts?: { kind?: string[]; includeGlobal?: boolean },
): Promise<Resource[]> {
  const params = new URLSearchParams();
  if (opts?.kind && opts.kind.length > 0) params.set("kind", opts.kind.join(","));
  if (opts?.includeGlobal === false) params.set("includeGlobal", "false");
  const qs = params.toString() ? `?${params.toString()}` : "";
  const res = await fetch(`/api/episodes/${episodeId}/resources${qs}`);
  const body = await jsonOrThrow<{ resources: Resource[] }>(res);
  return body.resources;
}

export async function mountResource(
  episodeId: string,
  req: MountResourceRequest,
): Promise<Resource> {
  const res = await fetch(`/api/episodes/${episodeId}/resources`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  const body = await jsonOrThrow<{ resource: Resource }>(res);
  return body.resource;
}

export async function attachInlineResource(
  episodeId: string,
  file: File,
): Promise<Resource> {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("episodeId", episodeId);
  const res = await fetch(`/api/episodes/${episodeId}/resources/inline`, {
    method: "POST",
    body: formData,
  });
  const body = await jsonOrThrow<{ resource: Resource }>(res);
  return body.resource;
}

export async function getResource(id: string): Promise<Resource> {
  const res = await fetch(`/api/resources/${id}`);
  const body = await jsonOrThrow<{ resource: Resource }>(res);
  return body.resource;
}

export async function deleteResource(id: string): Promise<void> {
  const res = await fetch(`/api/resources/${id}`, { method: "DELETE" });
  await jsonOrThrow<{ ok: boolean }>(res);
}

export async function readResource(
  id: string,
  opts?: { maxChars?: number },
): Promise<ResourceReadResponse> {
  const qs = opts?.maxChars ? `?maxChars=${opts.maxChars}` : "";
  const res = await fetch(`/api/resources/${id}/read${qs}`);
  return jsonOrThrow<ResourceReadResponse>(res);
}

// ─── Agent ────────────────────────────────────────────────────────────
export async function createAgentTask(req: {
  episodeId: string;
  goal: string;
  template?: string;
  autoStart?: boolean;
}): Promise<AgentTask> {
  const res = await fetch("/api/agent", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  const body = await jsonOrThrow<{ task: AgentTask }>(res);
  return body.task;
}

export async function listAgentTasks(episodeId?: string): Promise<AgentTask[]> {
  const qs = episodeId ? `?episodeId=${episodeId}` : "";
  const res = await fetch(`/api/agent${qs}`);
  const body = await jsonOrThrow<{ tasks: AgentTask[] }>(res);
  return body.tasks;
}

export interface CodingReadiness {
  path: string | null;
  verify: { ready: boolean; commands: string[]; sources: string[] };
  deploy: {
    ready: boolean;
    presets: string[];
    allowed: boolean;
    hint?: string;
  };
  ssh: {
    ready: boolean;
    hosts: number;
    allowed: boolean;
    sources: string[];
    hint?: string;
  };
  flow: string;
}

/** Checklist for Code/Agent UI — verify/deploy/ssh for a mounted path. */
export async function getCodingReadiness(path?: string | null): Promise<CodingReadiness> {
  const qs = path ? `?path=${encodeURIComponent(path)}` : "";
  const res = await fetch(`/api/agent/coding-readiness${qs}`);
  return jsonOrThrow<CodingReadiness>(res);
}

export async function getAgentTask(id: string): Promise<AgentTask> {
  const res = await fetch(`/api/agent/${id}`);
  const body = await jsonOrThrow<{ task: AgentTask }>(res);
  return body.task;
}

export async function cancelAgentTask(id: string): Promise<void> {
  const res = await fetch(`/api/agent/${id}/cancel`, { method: "POST" });
  await jsonOrThrow<{ ok: boolean }>(res);
}

export async function submitAgentInput(id: string, answer: string): Promise<void> {
  const res = await fetch(`/api/agent/${id}/input`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ answer }),
  });
  await jsonOrThrow<{ ok: boolean }>(res);
}

export async function listAgentFileChanges(id: string): Promise<AgentFileChangeDTO[]> {
  const res = await fetch(`/api/agent/${id}/file-changes`);
  const body = await jsonOrThrow<{ changes: AgentFileChangeDTO[] }>(res);
  return body.changes;
}

export async function applyAgentFileChange(id: string, changeId: string): Promise<void> {
  const res = await fetch(`/api/agent/${id}/file-apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ changeId }),
  });
  await jsonOrThrow<{ ok: boolean }>(res);
}

export async function rejectAgentFileChange(id: string, changeId: string): Promise<void> {
  const res = await fetch(`/api/agent/${id}/file-reject`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ changeId }),
  });
  await jsonOrThrow<{ ok: boolean }>(res);
}

export async function undoAgentFileChange(id: string, changeId: string): Promise<void> {
  const res = await fetch(`/api/agent/${id}/file-undo`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ changeId }),
  });
  await jsonOrThrow<{ ok: boolean }>(res);
}

export async function applyAllAgentFileChanges(id: string): Promise<void> {
  const res = await fetch(`/api/agent/${id}/file-apply-all`, { method: "POST" });
  await jsonOrThrow<{ ok: boolean }>(res);
}

export async function rejectAllAgentFileChanges(id: string): Promise<void> {
  const res = await fetch(`/api/agent/${id}/file-reject-all`, { method: "POST" });
  await jsonOrThrow<{ ok: boolean }>(res);
}

export async function undoAllAgentFileChanges(id: string): Promise<void> {
  const res = await fetch(`/api/agent/${id}/file-undo-all`, { method: "POST" });
  await jsonOrThrow<{ ok: boolean }>(res);
}

export async function confirmAgentGit(
  id: string,
  body: { actionId: string; decision: "confirm" | "reject"; message?: string },
): Promise<void> {
  const res = await fetch(`/api/agent/${id}/git-confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  await jsonOrThrow<{ ok: boolean }>(res);
}

/** SSE stream for agent events. Returns an AbortController. */
export function streamAgentEvents(
  taskId: string,
  callbacks: { onEvent: (ev: AgentEvent) => void; onDone: () => void },
): AbortController {
  const controller = new AbortController();
  void (async () => {
    try {
      const res = await fetch(`/api/agent/${taskId}/stream`, {
        headers: { Accept: "text/event-stream" },
        signal: controller.signal,
      });
      if (!res.body) return;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sepIdx: number;
        while ((sepIdx = buffer.indexOf("\n\n")) !== -1) {
          const rawEvent = buffer.slice(0, sepIdx);
          buffer = buffer.slice(sepIdx + 2);
          const dataLines = rawEvent.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim());
          if (dataLines.length === 0) continue;
          try {
            const ev = JSON.parse(dataLines.join("\n")) as AgentEvent;
            callbacks.onEvent(ev);
            if (ev.type === "done") callbacks.onDone();
          } catch {
            // skip
          }
        }
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") console.error("agent SSE error:", e);
    }
  })();
  return controller;
}

// ─── Decisions ────────────────────────────────────────────────────────
export async function listDecisions(
  episodeId: string,
  opts?: { limit?: number },
): Promise<DecisionDTO[]> {
  const qs = opts?.limit ? `?limit=${opts.limit}` : "";
  const res = await fetch(`/api/episodes/${episodeId}/decisions${qs}`);
  const body = await jsonOrThrow<{ decisions: DecisionDTO[] }>(res);
  return body.decisions;
}

// ─── VRM avatar ───────────────────────────────────────────────────────
export async function checkVrmExists(): Promise<{ exists: boolean; size?: number }> {
  const res = await fetch("/api/settings/vrm/exists");
  return jsonOrThrow<{ exists: boolean; size?: number }>(res);
}

export async function uploadVrm(file: File): Promise<void> {
  const formData = new FormData();
  formData.append("file", file);
  const res = await fetch("/api/settings/vrm", { method: "POST", body: formData });
  await jsonOrThrow<{ ok: boolean }>(res);
}

export async function deleteVrm(): Promise<void> {
  const res = await fetch("/api/settings/vrm", { method: "DELETE" });
  await jsonOrThrow<{ ok: boolean }>(res);
}

// ─── Code symbols ─────────────────────────────────────────────────────
export async function searchCodeSymbols(
  resourceId: string,
  query: string,
): Promise<import("@lia/shared").SymbolSearchResult[]> {
  const res = await fetch(`/api/resources/${resourceId}/symbols/search?q=${encodeURIComponent(query)}`);
  const body = await jsonOrThrow<{ results: import("@lia/shared").SymbolSearchResult[] }>(res);
  return body.results;
}
