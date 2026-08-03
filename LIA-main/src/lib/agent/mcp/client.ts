/**
 * Minimal MCP client + in-process mock server (P6 bonus).
 * Not a DoD blocker — enable via LIA_MCP_ENABLED=1 or Settings.
 */

export type McpToolDef = {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
};

export type McpCallResult = {
  ok: boolean;
  content?: string;
  error?: string;
};

type McpServer = {
  id: string;
  name: string;
  enabled: boolean;
  tools: McpToolDef[];
  call: (tool: string, args: Record<string, unknown>) => Promise<McpCallResult>;
};

const globalKey = '__lia_mcp_registry__';

function registry(): Map<string, McpServer> {
  const g = globalThis as unknown as { [k: string]: Map<string, McpServer> | undefined };
  if (!g[globalKey]) {
    g[globalKey] = new Map();
    // Built-in mock server for debug
    g[globalKey].set('mock', {
      id: 'mock',
      name: 'Mock File MCP',
      enabled: process.env.LIA_MCP_ENABLED === '1',
      tools: [
        {
          name: 'mock_echo',
          description: 'Echo args as JSON (debug MCP).',
        },
        {
          name: 'mock_time',
          description: 'Return current ISO timestamp.',
        },
      ],
      call: async (tool, args) => {
        if (tool === 'mock_echo') {
          return { ok: true, content: JSON.stringify(args) };
        }
        if (tool === 'mock_time') {
          return { ok: true, content: new Date().toISOString() };
        }
        return { ok: false, error: `unknown mock tool: ${tool}` };
      },
    });
  }
  return g[globalKey]!;
}

export function listMcpServers(): Array<{ id: string; name: string; enabled: boolean; tools: McpToolDef[] }> {
  return [...registry().values()].map(({ id, name, enabled, tools }) => ({
    id, name, enabled, tools,
  }));
}

export function setMcpServerEnabled(id: string, enabled: boolean): boolean {
  const s = registry().get(id);
  if (!s) return false;
  s.enabled = enabled;
  return true;
}

export function listEnabledMcpTools(): Array<McpToolDef & { serverId: string }> {
  const out: Array<McpToolDef & { serverId: string }> = [];
  for (const s of registry().values()) {
    if (!s.enabled) continue;
    for (const t of s.tools) out.push({ ...t, serverId: s.id });
  }
  return out;
}

export async function callMcpTool(
  serverId: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<McpCallResult> {
  const s = registry().get(serverId);
  if (!s) return { ok: false, error: 'server not found' };
  if (!s.enabled) return { ok: false, error: 'server disabled' };
  return s.call(tool, args);
}

export function isMcpGloballyEnabled(): boolean {
  return process.env.LIA_MCP_ENABLED === '1'
    || [...registry().values()].some((s) => s.enabled);
}
