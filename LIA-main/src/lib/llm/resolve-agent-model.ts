/**
 * Resolve which model name the agent runner should use.
 * Empty / null agentModelConfigured → same as chat model.
 */
export function resolveAgentModelName(
  chatModel: string,
  agentModelConfigured: string | null | undefined,
): string {
  const configured = agentModelConfigured?.trim();
  return configured || chatModel;
}
