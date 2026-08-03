import { RUN_COMMAND_ALLOWED } from '../tools/run-command';

export type ParsedScript =
  | { ok: true; command: string; args: string[] }
  | { ok: false; error: string };

/** Split "npx --yes serve -l 5173" into allowlisted exec args. */
export function parseRuntimeScript(script: string): ParsedScript {
  const trimmed = script.trim();
  if (!trimmed) return { ok: false, error: 'script is empty' };
  if (/[|;&`$<>]/.test(trimmed)) {
    return { ok: false, error: 'shell metacharacters not allowed in runtime scripts' };
  }
  const parts = trimmed.match(/(?:[^\s"]+|"[^"]*")+/g)?.map(p => p.replace(/^"|"$/g, '')) ?? [];
  if (parts.length === 0) return { ok: false, error: 'script is empty' };
  const command = parts[0]!;
  if (command.includes('/') || command.includes('\\') || command.includes('\0')) {
    return { ok: false, error: 'command must be a bare binary name' };
  }
  if (!RUN_COMMAND_ALLOWED.has(command)) {
    return {
      ok: false,
      error: `command "${command}" not allowed. Allowed: ${[...RUN_COMMAND_ALLOWED].sort().join(', ')}`,
    };
  }
  return { ok: true, command, args: parts.slice(1) };
}
