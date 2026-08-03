/**
 * Resolve Ollama model name for an explicit role.
 *
 * Empty heavy → callers should use agent (then chat) fallback — documented
 * here so escalate / Settings stay consistent.
 */

export type ModelRoleName = 'chat' | 'agent' | 'secondary' | 'heavy';

export type RoleModelSnapshot = {
  chat: string;
  /** Configured agent override; empty = same as chat. */
  agentConfigured: string;
  secondary: string | null;
  heavy: string | null;
};

/**
 * Resolve the model name for a role.
 *
 * - chat: always chat
 * - agent: agentConfigured || chat
 * - secondary: secondary || null (caller falls back to chat)
 * - heavy: heavy || agentConfigured || chat (empty heavy ⇒ day/agent fallback)
 */
export function resolveModelForRole(
  role: ModelRoleName,
  snap: RoleModelSnapshot,
): string {
  const chat = snap.chat.trim();
  const agent = snap.agentConfigured.trim() || chat;
  const secondary = snap.secondary?.trim() || null;
  const heavy = snap.heavy?.trim() || null;

  switch (role) {
    case 'chat':
      return chat;
    case 'agent':
      return agent;
    case 'secondary':
      return secondary || chat;
    case 'heavy':
      // Empty heavy ⇒ agent/chat fallback (no silent invent of a bigger model).
      return heavy || agent;
    default: {
      const _exhaustive: never = role;
      return _exhaustive;
    }
  }
}

/**
 * Configured heavy name only — null when unset (escalate should no-op).
 */
export function configuredHeavyModelName(snap: RoleModelSnapshot): string | null {
  const h = snap.heavy?.trim();
  return h || null;
}
