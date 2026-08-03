/**
 * Mentions parser — @file:path / @folder:path (and bare @path).
 * Shared client+server.
 */

export type AgentMention =
  | { kind: 'file'; path: string; lineStart?: number; lineEnd?: number }
  | { kind: 'folder'; path: string };

/** Path chars until whitespace / punctuation that ends a mention (not `.` — needed for extensions). */
const MENTION_RE =
  /@(?:(file|folder):)?([^\s@#]+?)(?:#L(\d+)(?:-(\d+))?)?(?=[\s,;!?]|$)/gi;

export function parseMentions(text: string): AgentMention[] {
  const out: AgentMention[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  const re = new RegExp(MENTION_RE.source, MENTION_RE.flags);
  while ((m = re.exec(text)) !== null) {
    const kindToken = (m[1] || '').toLowerCase();
    let path = m[2];
    if (!path) continue;
    // Trim trailing period that was sentence punctuation (e.g. `@file:a.ts.`)
    path = path.replace(/[.,]+$/, '');
    if (!path || seen.has(path.toLowerCase())) continue;
    seen.add(path.toLowerCase());
    const isFolder = kindToken === 'folder' || /[/\\]$/.test(path);
    const lineStart = m[3] ? parseInt(m[3], 10) : undefined;
    const lineEnd = m[4] ? parseInt(m[4], 10) : undefined;
    if (isFolder) out.push({ kind: 'folder', path: path.replace(/[/\\]$/, '') });
    else out.push({ kind: 'file', path, lineStart, lineEnd });
  }
  return out;
}

/** Strip mention tokens for display / goal cleanup (optional). */
export function stripMentionTokens(text: string): string {
  return text.replace(MENTION_RE, ' ').replace(/\s+/g, ' ').trim();
}
