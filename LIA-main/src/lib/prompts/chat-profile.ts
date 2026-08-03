// Chat system-prompt profile — companion vs assistant vs minimal (no tools).

export type ChatPromptProfile = 'minimal' | 'companion' | 'assistant';

export type ChatProfileInput = {
  toolsEnabled: boolean;
  isTrivial: boolean;
  isAgent: boolean;
  /** Proactive KB block or heuristic KB question */
  isKbQuestion: boolean;
  hasKbContext: boolean;
  hasWebContext: boolean;
  isCodeTask: boolean;
  complexity: string;
};

/**
 * Pick prompt profile for this turn.
 * - minimal: model without tools (Gemma etc.) — no tool playbooks
 * - companion: small talk, emotions, simple chat — no tool manuals
 * - assistant: facts, KB, web, code, agent — full playbooks when adaptive/full
 */
export function resolveChatPromptProfile(input: ChatProfileInput): ChatPromptProfile {
  // Prefer companion for light chat even when toolsSupported — playbooks stay off.
  // Only force minimal when the model literally cannot use tools AND we disabled them.
  const lightComplexity = input.complexity === 'trivial'
    || input.complexity === 'simple'
    || input.isTrivial;

  const needsAssistant = input.isAgent
    || input.hasKbContext
    || input.hasWebContext
    || input.isKbQuestion
    || input.isCodeTask
    || input.complexity === 'complex'
    || input.complexity === 'research'
    || input.complexity === 'moderate';

  if (needsAssistant) {
    return input.toolsEnabled ? 'assistant' : 'minimal';
  }

  if (!input.toolsEnabled && !lightComplexity) return 'minimal';

  return 'companion';
}
