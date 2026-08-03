/**
 * Tool registry — single source of truth for agent tools.
 *
 * Per docs/ARCHITECTURE.md § 8.2 — each tool declares an availability predicate.
 * Before streamText, the orchestrator calls registry.filter(workspace, task) to
 * build the active tool set.
 *
 * Tool categories:
 *   A. Filesystem: list_tree, read_file, write_file, grep
 *   B. KB: search_sources, list_sources
 *   C. Web: web_search, fetch_page
 *   D. Orchestration: make_plan, finalize, ask_user
 *   E. Execution: run_command (opt-in via LIA_ALLOW_SHELL)
 *   F. Symbol: search_codebase, list_references (M6)
 *   G. External MCP (client connected; agent wiring deferred)
 */

import { tool, type Tool } from "ai";
import { z } from "zod";
import type { Resource } from "@lia/shared";

export interface ToolContext {
  episodeId: string;
  taskId: string;
  fsScope: string | null;
  /** Emit an event to the SSE stream + persist to eventsJson */
  emit: (event: import("@lia/shared").AgentEvent) => void;
}

export interface ToolRegistryEntry {
  name: string;
  description: string;
  /** Zod schema for input validation */
  inputSchema: z.ZodType;
  /** Availability predicate — filtered before streamText */
  available: (resources: Resource[], task: { fsScope: string | null }) => boolean;
  /** Execute the tool */
  execute: (input: unknown, ctx: ToolContext) => Promise<unknown>;
}

// ─── Registry ─────────────────────────────────────────────────────────
const registry = new Map<string, ToolRegistryEntry>();

export function registerTool(entry: ToolRegistryEntry): void {
  registry.set(entry.name, entry);
}

export function getTool(name: string): ToolRegistryEntry | undefined {
  return registry.get(name);
}

export function listAllTools(): ToolRegistryEntry[] {
  return Array.from(registry.values());
}

/**
 * Filter the registry by availability for a given workspace + task.
 * Returns AI SDK tool objects ready for streamText.
 */
export function buildActiveTools(
  resources: Resource[],
  task: { fsScope: string | null; toolsWhitelist: string[] | null },
  ctx: ToolContext,
): Record<string, Tool> {
  const active = listAllTools().filter((entry) => {
    // Check whitelist
    if (task.toolsWhitelist && !task.toolsWhitelist.includes(entry.name)) {
      return false;
    }
    // Check availability predicate
    return entry.available(resources, { fsScope: task.fsScope });
  });

  const tools: Record<string, Tool> = {};
  for (const entry of active) {
    // AI SDK v7 tool() has strict typing on execute — cast to satisfy TS
    const toolDef = {
      description: entry.description,
      parameters: entry.inputSchema,
      execute: async (input: unknown) => {
        ctx.emit({ type: "tool_start", tool: entry.name, input, ts: Date.now() });
        try {
          const output = await entry.execute(input, ctx);
          const summary = summarizeOutput(output);
          ctx.emit({
            type: "tool_end",
            tool: entry.name,
            success: true,
            summary,
            output,
            ts: Date.now(),
          });
          return output;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          ctx.emit({
            type: "tool_end",
            tool: entry.name,
            success: false,
            summary: `error: ${msg}`,
            ts: Date.now(),
          });
          throw e;
        }
      },
    };
    tools[entry.name] = tool(toolDef as never);
  }
  return tools;
}

function summarizeOutput(output: unknown): string {
  if (output === null || output === undefined) return "(no output)";
  if (typeof output === "string") return output.slice(0, 200);
  if (Array.isArray(output)) return `${output.length} items`;
  if (typeof output === "object") {
    const keys = Object.keys(output as object);
    return `{${keys.slice(0, 5).join(", ")}${keys.length > 5 ? "..." : ""}}`;
  }
  return String(output).slice(0, 200);
}
