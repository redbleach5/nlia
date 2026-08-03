// GET/POST /api/agent/mcp — list / toggle MCP servers (P6 bonus).

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  listMcpServers,
  setMcpServerEnabled,
} from '@/lib/agent/mcp/client';
import { parseBody } from '@/lib/infra/api-validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({
    servers: listMcpServers(),
    envEnabled: process.env.LIA_MCP_ENABLED === '1',
  });
}

const patchSchema = z.object({
  id: z.string().min(1).max(64),
  enabled: z.boolean(),
});

export async function POST(req: NextRequest) {
  const parsed = await parseBody(req, patchSchema);
  if (!parsed.success) return parsed.response;
  const ok = setMcpServerEnabled(parsed.data.id, parsed.data.enabled);
  if (!ok) {
    return NextResponse.json({ error: 'server not found' }, { status: 404 });
  }
  return NextResponse.json({ ok: true, servers: listMcpServers() });
}
