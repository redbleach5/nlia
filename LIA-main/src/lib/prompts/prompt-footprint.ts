// Dev-oriented prompt size metrics (char-based token estimate).

import { estimateTokens } from '@/lib/chat/context-budget';
import type { ChatPromptProfile } from '@/lib/prompts/chat-profile';

export type SystemPromptFootprint = {
  prompt: string;
  profile: ChatPromptProfile;
  promptMode: 'full' | 'adaptive' | 'minimal';
  chars: number;
  estTokens: number;
  /** True when assistant tool playbook block is present */
  hasToolPlaybook: boolean;
};

export function footprintFromPrompt(
  prompt: string,
  meta: Pick<SystemPromptFootprint, 'profile' | 'promptMode'>,
): SystemPromptFootprint {
  return {
    prompt,
    profile: meta.profile,
    promptMode: meta.promptMode,
    chars: prompt.length,
    estTokens: estimateTokens(prompt),
    hasToolPlaybook: prompt.includes('Tools: search_sources'),
  };
}
