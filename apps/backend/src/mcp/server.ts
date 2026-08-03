/**
 * MCP Server — Lia as MCP server (external clients call Lia tools).
 *
 * Per docs/ARCHITECTURE.md § 8A.3 — 8 tools in 4 groups:
 *   Episode management: episode.list, episode.create
 *   Workspace access:   workspace.search, workspace.read
 *   Agent invocation:   agent.invoke
 *   Memory & introspection: memory.recall, decisions.list, lia.status
 *
 * Transport: HTTP + SSE (Streamable HTTP, MCP spec 2025-03-26)
 * Endpoint: http://127.0.0.1:47832/mcp
 * SDK: @modelcontextprotocol/sdk
 *
 * Install: npm install @modelcontextprotocol/sdk
 * Start: the server starts automatically alongside Hono backend (see index.ts patch).
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "node:http";
import { listEpisodes, createEpisode } from "../services/episodes.js";
import { hybridSearch } from "../kb/search.js";
import { read as readResource } from "../workspace/service.js";
import { recall } from "../memory/vector.js";
import { listDecisions } from "../memory/decisions.js";
import { createTask, listTasks } from "../agent/service.js";
import { getOllamaSettings, checkOllamaHealth } from "../llm/ollama.js";
import { logger } from "../util/logger.js";

const MCP_PORT = Number(process.env.LIA_MCP_PORT ?? 47832);
const MCP_PROTOCOL_VERSION = "2025-03-26";

let serverInstance: ReturnType<typeof createServer> | null = null;

/**
 * Create and start the MCP server.
 * Should be called after Hono backend is ready.
 */
export async function startMcpServer(): Promise<void> {
  if (serverInstance) {
    logger.warn("MCP server already running");
    return;
  }

  const server = new Server(
    { name: "lia-mcp-server", version: "1.0.0" },
    { capabilities: { tools: {}, logging: {} } },
  );

  // ─── List tools ──────────────────────────────────────────────────
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: "episode.list",
          description: "List user's episodes, most recent first",
          inputSchema: {
            type: "object",
            properties: {
              limit: { type: "integer", default: 50, maximum: 200 },
            },
          },
        },
        {
          name: "episode.create",
          description: "Create a new episode. Optional initialMessage starts chat immediately.",
          inputSchema: {
            type: "object",
            properties: {
              title: { type: "string", maxLength: 200 },
            },
          },
        },
        {
          name: "workspace.search",
          description: "Semantic search across all resources in the specified episode.",
          inputSchema: {
            type: "object",
            required: ["episodeId", "query"],
            properties: {
              episodeId: { type: "string" },
              query: { type: "string", maxLength: 1000 },
              limit: { type: "integer", default: 10, maximum: 50 },
            },
          },
        },
        {
          name: "workspace.read",
          description: "Read content of a specific resource.",
          inputSchema: {
            type: "object",
            required: ["resourceId"],
            properties: {
              resourceId: { type: "string" },
              maxChars: { type: "integer", default: 50000, maximum: 500000 },
            },
          },
        },
        {
          name: "agent.invoke",
          description: "Start an agent task with a goal. Returns taskId.",
          inputSchema: {
            type: "object",
            required: ["episodeId", "goal"],
            properties: {
              episodeId: { type: "string" },
              goal: { type: "string", maxLength: 32000 },
              template: { type: "string", enum: ["general", "researcher", "coder"] },
            },
          },
        },
        {
          name: "memory.recall",
          description: "Vector recall from Lia's memory layers.",
          inputSchema: {
            type: "object",
            required: ["query"],
            properties: {
              query: { type: "string", maxLength: 1000 },
              episodeId: { type: "string" },
              limit: { type: "integer", default: 5, maximum: 20 },
            },
          },
        },
        {
          name: "decisions.list",
          description: "Read Lia's recent decision log entries for introspection.",
          inputSchema: {
            type: "object",
            properties: {
              episodeId: { type: "string" },
              limit: { type: "integer", default: 10, maximum: 50 },
            },
          },
        },
        {
          name: "lia.status",
          description: "Read Lia's current operational status. No side effects.",
          inputSchema: { type: "object" },
        },
      ],
    };
  });

  // ─── Call tool ───────────────────────────────────────────────────
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        // ─── Episode management ───────────────────────────────────
        case "episode.list": {
          const limit = (args?.limit as number) ?? 50;
          const episodes = listEpisodes(limit);
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                episodes: episodes.map((e) => ({
                  id: e.id,
                  title: e.title,
                  createdAt: e.createdAt,
                  updatedAt: e.updatedAt,
                  messageCount: e.messageCount,
                })),
              }, null, 2),
            }],
          };
        }

        case "episode.create": {
          const title = args?.title as string | undefined;
          const episode = createEpisode({ title: title ?? null });
          return {
            content: [{
              type: "text",
              text: JSON.stringify({ episodeId: episode.id }),
            }],
          };
        }

        // ─── Workspace access ─────────────────────────────────────
        case "workspace.search": {
          const episodeId = args?.episodeId as string;
          const query = args?.query as string;
          const limit = (args?.limit as number) ?? 10;
          const result = await hybridSearch(episodeId, query, { limit });
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                results: result.results.map((r) => ({
                  resourceId: r.resourceId,
                  resourceName: r.resourceName,
                  resourceKind: r.resourceKind,
                  chunkId: r.chunkId,
                  content: r.content.slice(0, 500),
                  score: r.score,
                })),
                totalFound: result.totalChunks,
              }, null, 2),
            }],
          };
        }

        case "workspace.read": {
          const resourceId = args?.resourceId as string;
          const maxChars = (args?.maxChars as number) ?? 50000;
          const result = await readResource(resourceId, { maxChars });
          if (!result) {
            return mcpError("RESOURCE_NOT_FOUND", `Resource ${resourceId} not found`);
          }
          return {
            content: [{
              type: "text",
              text: JSON.stringify(result),
            }],
          };
        }

        // ─── Agent invocation ─────────────────────────────────────
        case "agent.invoke": {
          const episodeId = args?.episodeId as string;
          const goal = args?.goal as string;
          const template = args?.template as string | undefined;
          const task = createTask({
            episodeId,
            goal,
            templateName: template ?? null,
          });
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                taskId: task.id,
                eventsStreamUrl: `/api/agent/${task.id}/stream`,
              }),
            }],
          };
        }

        // ─── Memory & introspection ───────────────────────────────
        case "memory.recall": {
          const query = args?.query as string;
          const episodeId = args?.episodeId as string | undefined;
          const limit = (args?.limit as number) ?? 5;
          if (!episodeId) {
            return mcpError("EPISODE_NOT_FOUND", "episodeId is required for memory.recall");
          }
          const hits = await recall({ episodeId, query, limit });
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                memories: hits.map((h) => ({
                  type: h.sourceType,
                  content: h.text.slice(0, 500),
                  score: h.similarity,
                })),
              }, null, 2),
            }],
          };
        }

        case "decisions.list": {
          const episodeId = args?.episodeId as string | undefined;
          const limit = (args?.limit as number) ?? 10;
          const decisions = episodeId
            ? listDecisions(episodeId, { limit })
            : [];
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                decisions: decisions.map((d) => ({
                  id: d.id,
                  ts: d.ts,
                  situation: d.situation,
                  chosen: d.chosen,
                  rationale: d.rationale,
                  outcome: d.outcome,
                  modelRole: d.modelRole,
                })),
              }, null, 2),
            }],
          };
        }

        case "lia.status": {
          const settings = await getOllamaSettings();
          const health = await checkOllamaHealth();
          const tasks = listTasks(undefined, 100);
          const activeTasks = tasks.filter(
            (t) => t.status === "executing" || t.status === "pending",
          ).length;
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                version: "3.0.0",
                chatModel: settings.chat,
                agentModel: settings.agent || settings.chat,
                ollamaHealth: health.ok,
                activeTasks,
                mcpServers: [], // M5.5: populate from MCP client registry
              }, null, 2),
            }],
          };
        }

        default:
          return mcpError("METHOD_NOT_FOUND", `Unknown tool: ${name}`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.error({ err: e, tool: name }, "MCP tool execution error");
      return mcpError("INTERNAL", msg);
    }
  });

  // ─── HTTP server with StreamableHTTP transport ──────────────────
  const httpServer = createServer(async (req, res) => {
    // Only handle /mcp endpoint
    const url = new URL(req.url ?? "", `http://127.0.0.1:${MCP_PORT}`);
    if (url.pathname !== "/mcp") {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    if (req.method === "POST") {
      // Handle tool calls. StreamableHTTP transport writes directly to res.
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless mode
      });
      await server.connect(transport);
      res.on("close", () => transport.close());

      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", async () => {
        try {
          await transport.handleRequest(req, res, JSON.parse(body));
        } catch (e) {
          logger.error({ err: e }, "MCP request handling failed");
          if (!res.headersSent) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32700, message: "Parse error" },
              id: null,
            }));
          }
        }
      });
    } else if (req.method === "GET") {
      // SSE stream for notifications (M5.5)
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      });
      res.write(": connected\n\n");
      // Keep alive
      const interval = setInterval(() => res.write(": ping\n\n"), 30000);
      req.on("close", () => clearInterval(interval));
    } else {
      res.writeHead(405);
      res.end("Method not allowed");
    }
  });

  httpServer.listen(MCP_PORT, "127.0.0.1", () => {
    logger.info({ port: MCP_PORT, protocol: MCP_PROTOCOL_VERSION }, "MCP server listening");
  });

  serverInstance = httpServer;
}

/** Stop the MCP server (on app shutdown). */
export function stopMcpServer(): void {
  if (serverInstance) {
    serverInstance.close();
    serverInstance = null;
    logger.info("MCP server stopped");
  }
}

// ─── Helper: MCP error response ───────────────────────────────────────
function mcpError(code: string, message: string) {
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({ error: code, message }),
    }],
    isError: true,
  };
}
