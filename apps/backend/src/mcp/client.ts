/**
 * MCP Client — Lia as MCP client (calls external MCP servers' tools).
 *
 * Per docs/ARCHITECTURE.md § 8A.6.
 * Users register external MCP servers in Settings → Integrations.
 * On connection, Lia fetches tool list via MCP tools/list.
 * Tools become available in agent tool registry with prefix <serverName>.<toolName>.
 *
 * Privacy: external MCP tools only in agent mode (not chat), unless allowedInChat=true.
 * Rate limit: max 10 external MCP tool calls per agent task.
 * All calls logged in decision log for transparency.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { getDb } from "../db/client.js";
import { settings as settingsTable } from "../db/schema.js";
import { logger } from "../util/logger.js";

export interface McpServerConfig {
  name: string;
  url: string;
  transport: "streamable-http";
  enabled: boolean;
  allowedInChat: boolean;
  allowedInAgent: boolean;
}

interface ConnectedServer {
  config: McpServerConfig;
  client: Client;
  tools: Array<{ name: string; description: string; inputSchema: unknown }>;
  status: "connected" | "disconnected" | "error";
  errorMessage?: string;
}

const connectedServers = new Map<string, ConnectedServer>();
const MAX_EXTERNAL_CALLS_PER_TASK = 10;
const taskCallCounts = new Map<string, number>();

/** Load registered MCP servers from settings table. */
function loadRegisteredServers(): McpServerConfig[] {
  const sqlite = getDb();
  const db = drizzle(sqlite);
  const row = db
    .select()
    .from(settingsTable)
    .where(eq(settingsTable.key, "mcp_servers"))
    .get();
  if (!row?.value) return [];
  try {
    return JSON.parse(row.value) as McpServerConfig[];
  } catch {
    return [];
  }
}

/** Save MCP servers config to settings table. */
export function saveRegisteredServers(servers: McpServerConfig[]): void {
  const sqlite = getDb();
  const db = drizzle(sqlite);
  const now = Math.floor(Date.now() / 1000);
  const existing = db
    .select()
    .from(settingsTable)
    .where(eq(settingsTable.key, "mcp_servers"))
    .get();

  if (existing) {
    db.update(settingsTable)
      .set({ value: JSON.stringify(servers), updatedAt: now })
      .where(eq(settingsTable.key, "mcp_servers"))
      .run();
  } else {
    db.insert(settingsTable)
      .values({ key: "mcp_servers", value: JSON.stringify(servers), updatedAt: now })
      .run();
  }
}

/** Register a new external MCP server. */
export async function registerMcpServer(config: McpServerConfig): Promise<void> {
  const servers = loadRegisteredServers();
  const idx = servers.findIndex((s) => s.name === config.name);
  if (idx >= 0) {
    servers[idx] = config;
  } else {
    servers.push(config);
  }
  saveRegisteredServers(servers);

  if (config.enabled) {
    await connectMcpServer(config);
  }
}

/** Unregister an external MCP server. */
export async function unregisterMcpServer(name: string): Promise<void> {
  const servers = loadRegisteredServers().filter((s) => s.name !== name);
  saveRegisteredServers(servers);
  await disconnectMcpServer(name);
}

/** Connect to an external MCP server and fetch its tool list. */
export async function connectMcpServer(config: McpServerConfig): Promise<void> {
  try {
    const transport = new StreamableHTTPClientTransport(new URL(config.url));
    const client = new Client(
      { name: "lia-mcp-client", version: "1.0.0" },
      { capabilities: {} },
    );

    await client.connect(transport);

    // Fetch tool list
    const toolsResult = await client.listTools();
    const tools = toolsResult.tools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: t.inputSchema,
    }));

    connectedServers.set(config.name, {
      config,
      client,
      tools,
      status: "connected",
    });

    logger.info(
      { server: config.name, url: config.url, toolCount: tools.length },
      "MCP server connected",
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error({ err: e, server: config.name, url: config.url }, "MCP server connection failed");
    connectedServers.set(config.name, {
      config,
      client: null as never,
      tools: [],
      status: "error",
      errorMessage: msg,
    });
  }
}

/** Disconnect from an external MCP server. */
export async function disconnectMcpServer(name: string): Promise<void> {
  const entry = connectedServers.get(name);
  if (!entry) return;
  try {
    await entry.client.close();
  } catch {
    // ignore
  }
  connectedServers.delete(name);
  logger.info({ server: name }, "MCP server disconnected");
}

/** Connect to all enabled registered servers (on startup). */
export async function connectAllMcpServers(): Promise<void> {
  const servers = loadRegisteredServers();
  for (const config of servers.filter((s) => s.enabled)) {
    await connectMcpServer(config);
  }
}

/** Disconnect from all servers (on shutdown). */
export async function disconnectAllMcpServers(): Promise<void> {
  const names = Array.from(connectedServers.keys());
  await Promise.all(names.map((n) => disconnectMcpServer(n)));
}

/**
 * Get all available external tools (for agent tool registry).
 * Returns tools with namespaced names: <serverName>.<toolName>
 */
export function getExternalTools(): Array<{
  namespacedName: string;
  serverName: string;
  toolName: string;
  description: string;
  inputSchema: unknown;
  allowedInChat: boolean;
  allowedInAgent: boolean;
}> {
  const result: Array<{
    namespacedName: string;
    serverName: string;
    toolName: string;
    description: string;
    inputSchema: unknown;
    allowedInChat: boolean;
    allowedInAgent: boolean;
  }> = [];

  for (const [serverName, entry] of connectedServers) {
    if (entry.status !== "connected") continue;
    for (const tool of entry.tools) {
      result.push({
        namespacedName: `${serverName}.${tool.name}`,
        serverName,
        toolName: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        allowedInChat: entry.config.allowedInChat,
        allowedInAgent: entry.config.allowedInAgent,
      });
    }
  }

  return result;
}

/**
 * Call an external MCP tool.
 * Enforces rate limit (max 10 calls per task).
 * Returns the tool result.
 */
export async function callExternalTool(
  serverName: string,
  toolName: string,
  args: unknown,
  taskId?: string,
): Promise<unknown> {
  // Rate limit check
  if (taskId) {
    const count = taskCallCounts.get(taskId) ?? 0;
    if (count >= MAX_EXTERNAL_CALLS_PER_TASK) {
      throw new Error(`Rate limit: max ${MAX_EXTERNAL_CALLS_PER_TASK} external MCP calls per task`);
    }
    taskCallCounts.set(taskId, count + 1);
  }

  const entry = connectedServers.get(serverName);
  if (!entry || entry.status !== "connected") {
    throw new Error(`MCP server ${serverName} not connected`);
  }

  try {
    const result = await entry.client.callTool({
      name: toolName,
      arguments: args as Record<string, unknown>,
    });

    logger.info(
      { serverName, toolName, taskId, hasResult: !!result },
      "external MCP tool called",
    );

    return result;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error({ err: e, serverName, toolName }, "external MCP tool call failed");
    throw new Error(`External tool ${serverName}.${toolName} failed: ${msg}`);
  }
}

/** Get connection status of all registered servers. */
export function getMcpServerStatus(): Array<{
  name: string;
  url: string;
  status: string;
  toolCount: number;
  errorMessage?: string;
}> {
  return Array.from(connectedServers.values()).map((entry) => ({
    name: entry.config.name,
    url: entry.config.url,
    status: entry.status,
    toolCount: entry.tools.length,
    errorMessage: entry.errorMessage,
  }));
}

/** Reset call count for a task (called when task completes). */
export function resetTaskCallCount(taskId: string): void {
  taskCallCounts.delete(taskId);
}
