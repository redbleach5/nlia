import 'server-only';

import type { ChatPromptProfile } from '@/lib/prompts/chat-profile';

/**
 * Whether chat-mode streamText should expose tool definitions.
 *
 * Proactive web search and KB answer-lock inject context into the system
 * prompt — enabling tools again causes redundant multi-turn loops and empty
 * responses (prod regression, 2026-07).
 *
 * Latency pass: trivial/simple and companion/minimal profiles never attach
 * tool schemas (~800 tok + tool-round risk before first token).
 */
export function decideChatTools(params: {
  planToolsEnabled: boolean;
  toolsSupported: boolean;
  kbAnswerLocked: boolean;
  webSearchContext: string | undefined;
  /** When set, light turns skip tools even if plan.toolsEnabled. */
  complexity?: string;
  chatProfile?: ChatPromptProfile;
}): boolean {
  const {
    planToolsEnabled,
    toolsSupported,
    kbAnswerLocked,
    webSearchContext,
    complexity,
    chatProfile,
  } = params;

  if (chatProfile === 'companion' || chatProfile === 'minimal') return false;
  if (complexity === 'trivial' || complexity === 'simple') return false;

  return planToolsEnabled && toolsSupported && !kbAnswerLocked && !webSearchContext;
}
