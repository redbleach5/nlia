// Pure helpers for updating key=value lines in .env files (no I/O).

/**
 * Set or replace KEY=value in .env text. Preserves comments and unrelated keys.
 */
export function upsertEnvVar(content: string, key: string, value: string): string {
  const line = `${key}=${formatEnvValue(value)}`;
  const re = new RegExp(`^${escapeRegExp(key)}=.*$`, 'm');
  if (re.test(content)) {
    return content.replace(re, line);
  }
  const suffix = content.endsWith('\n') || content.length === 0 ? '' : '\n';
  return `${content}${suffix}${line}\n`;
}

/** Remove KEY=... line if present. */
export function removeEnvVar(content: string, key: string): string {
  const re = new RegExp(`^${escapeRegExp(key)}=.*\n?`, 'm');
  return content.replace(re, '');
}

function formatEnvValue(value: string): string {
  if (/[\s#"'\\]/.test(value)) {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return value;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
