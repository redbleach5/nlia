/**
 * Map Claude Code stream-json NDJSON lines → AgentEvent-shaped payloads.
 * Best-effort: CC formats evolve; we only need tool/text signals for UI.
 */

export type ParsedCcEvent =
  | { kind: 'assistant_delta'; text: string }
  | { kind: 'tool_start'; tool: string; input: unknown }
  | { kind: 'tool_end'; tool: string; success: boolean; output: unknown }
  | { kind: 'result'; text: string; success: boolean; sessionId?: string }
  | { kind: 'ignore' };

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function toolNameFromBlock(block: Record<string, unknown>): string {
  if (typeof block.name === 'string') return block.name;
  if (typeof block.toolName === 'string') return block.toolName;
  return 'tool';
}

export function parseClaudeCodeStreamLine(line: string): ParsedCcEvent {
  const trimmed = line.trim();
  if (!trimmed || trimmed[0] !== '{') return { kind: 'ignore' };

  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return { kind: 'ignore' };
  }

  const obj = asRecord(raw);
  if (!obj) return { kind: 'ignore' };

  const type = typeof obj.type === 'string' ? obj.type : '';

  if (type === 'assistant' || type === 'message') {
    const message = asRecord(obj.message) ?? obj;
    const content = message.content;
    if (typeof content === 'string' && content.trim()) {
      return { kind: 'assistant_delta', text: content };
    }
    if (Array.isArray(content)) {
      for (const item of content) {
        const block = asRecord(item);
        if (!block) continue;
        const bType = typeof block.type === 'string' ? block.type : '';
        if (bType === 'text' && typeof block.text === 'string' && block.text.trim()) {
          return { kind: 'assistant_delta', text: block.text };
        }
        if (bType === 'tool_use' || bType === 'tool_call') {
          return {
            kind: 'tool_start',
            tool: toolNameFromBlock(block),
            input: block.input ?? block.arguments ?? {},
          };
        }
      }
    }
  }

  if (type === 'tool_result' || type === 'user') {
    const message = asRecord(obj.message) ?? obj;
    const content = message.content;
    if (Array.isArray(content)) {
      for (const item of content) {
        const block = asRecord(item);
        if (!block) continue;
        if (block.type === 'tool_result') {
          const isError = block.is_error === true;
          return {
            kind: 'tool_end',
            tool: typeof block.tool_use_id === 'string' ? block.tool_use_id : 'tool',
            success: !isError,
            output: block.content ?? block,
          };
        }
      }
    }
  }

  if (type === 'result') {
    const text =
      (typeof obj.result === 'string' && obj.result)
      || (typeof obj.text === 'string' && obj.text)
      || '';
    const success = obj.is_error !== true && obj.subtype !== 'error';
    const sessionId =
      (typeof obj.session_id === 'string' && obj.session_id)
      || (typeof obj.sessionId === 'string' && obj.sessionId)
      || undefined;
    return {
      kind: 'result',
      text: String(text),
      success,
      ...(sessionId ? { sessionId } : {}),
    };
  }

  // Fallback: plain text field
  if (typeof obj.text === 'string' && obj.text.trim() && !type) {
    return { kind: 'assistant_delta', text: obj.text };
  }

  return { kind: 'ignore' };
}

export function parseClaudeCodeStreamChunk(chunk: string): ParsedCcEvent[] {
  return chunk
    .split('\n')
    .map((line) => parseClaudeCodeStreamLine(line))
    .filter((e) => e.kind !== 'ignore');
}
