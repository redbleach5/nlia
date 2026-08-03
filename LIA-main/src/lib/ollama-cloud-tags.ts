/**
 * Pure helpers for Ollama cloud model tags (safe for client + server).
 */

/** Normalize library name → Claude Code / ollama pull tag with :cloud. */
export function toCloudModelTag(name: string): string {
  const n = name.trim();
  if (!n) return n;
  if (/:cloud\b/i.test(n) || /-cloud\b/i.test(n)) return n;
  if (/cloud$/i.test(n)) return n;
  return `${n}:cloud`;
}

export function isCloudModelTag(name: string): boolean {
  return /:cloud\b/i.test(name) || /-cloud\b/i.test(name);
}
