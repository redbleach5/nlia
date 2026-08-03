import { describe, expect, it } from 'vitest';
import { classifyAgentRoute } from '@/lib/agent/route-intent';

/**
 * Documents the server intent-gate contract used by POST /api/agent:
 * without forceAgent, chat-route goals must not create a task.
 * (Full HTTP route test needs DB; this locks the classification contract.)
 */
describe('agent intent gate contract', () => {
  it('greeting without forceAgent would defer_to_chat', () => {
    expect(classifyAgentRoute('привет')).toBe('chat');
  });

  it('ambiguous without forceAgent would ask confirm', () => {
    expect(classifyAgentRoute('помоги')).toBe('ask');
  });

  it('real agent goal proceeds', () => {
    expect(classifyAgentRoute('напиши игру тетрис на canvas')).toBe('agent');
  });
});
