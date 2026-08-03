import { describe, it, expect } from 'vitest';
import {
  createEmptyPartsState,
  reduceAgentParts,
  replayAgentPartEvents,
  partsToPlainText,
  type AgentPartEvent,
} from '@/lib/agent/message-parts';

function ev<T extends AgentPartEvent>(partial: T): T {
  return partial;
}

describe('reduceAgentParts', () => {
  it('replays a typical turn without duplicating on reconnect', () => {
    const events: AgentPartEvent[] = [
      ev({ type: 'task_started', taskId: 't1', goal: 'fix loop', ts: 1, eventId: 'e1' }),
      ev({ type: 'task_planning', taskId: 't1', ts: 2, eventId: 'e2' }),
      ev({
        type: 'task_plan_ready',
        taskId: 't1',
        plan: { goal: 'fix loop', steps: ['read', 'edit', 'test'], complexity: 'moderate' },
        ts: 3,
        eventId: 'e3',
      }),
      ev({
        type: 'tool_start',
        taskId: 't1',
        step: 1,
        tool: 'read_file',
        input: { path: 'a.ts' },
        ts: 4,
        eventId: 'e4',
      }),
      ev({
        type: 'tool_end',
        taskId: 't1',
        step: 1,
        tool: 'read_file',
        success: true,
        output: 'ok content',
        ts: 5,
        eventId: 'e5',
      }),
      ev({
        type: 'file_changed',
        taskId: 't1',
        step: 2,
        changeId: 'c1',
        path: 'a.ts',
        tool: 'edit_file',
        diff: '-a\n+b',
        canUndo: true,
        pending: true,
        ts: 6,
        eventId: 'e6',
      }),
      ev({
        type: 'edit_applied',
        taskId: 't1',
        changeId: 'c1',
        path: 'a.ts',
        tool: 'edit_file',
        diff: '-a\n+b',
        canUndo: true,
        step: 2,
        ts: 7,
        eventId: 'e7',
      }),
      ev({
        type: 'task_done',
        taskId: 't1',
        resultSummary: 'Готово: loop fixed.',
        ts: 8,
        eventId: 'e8',
      }),
    ];

    const once = replayAgentPartEvents(events);
    expect(once.parts.some(p => p.type === 'plan')).toBe(true);
    expect(once.parts.some(p => p.type === 'tool_call' && p.collapsed)).toBe(true);
    expect(once.parts.some(p => p.type === 'edit_applied')).toBe(true);
    expect(once.parts.some(p => p.type === 'edit_proposed')).toBe(false);
    expect(partsToPlainText(once.parts)).toContain('Готово');
    expect(once.metrics.toolStarts).toBe(1);
    expect(once.metrics.toolSuccesses).toBe(1);
    expect(once.metrics.applyAccepts).toBe(1);

    // Reconnect: replay again from empty via same events twice through reducer
    let state = createEmptyPartsState();
    for (const e of events) state = reduceAgentParts(state, e);
    for (const e of events) state = reduceAgentParts(state, e); // duplicates
    expect(state.parts.filter(p => p.type === 'tool_call')).toHaveLength(1);
    expect(state.parts.filter(p => p.type === 'edit_applied')).toHaveLength(1);
    expect(state.seenEventIds.size).toBe(events.length);
  });

  it('accumulates assistant_delta into one text part', () => {
    let state = createEmptyPartsState();
    state = reduceAgentParts(state, {
      type: 'assistant_delta', taskId: 't', text: 'Hello ', ts: 1, eventId: 'd1',
    });
    state = reduceAgentParts(state, {
      type: 'assistant_delta', taskId: 't', text: 'world', ts: 2, eventId: 'd2',
    });
    const textParts = state.parts.filter(p => p.type === 'text');
    expect(textParts).toHaveLength(1);
    if (textParts[0].type === 'text') {
      expect(textParts[0].text).toBe('Hello world');
    }
    expect(state.metrics.firstTextAt).toBe(1);
  });

  it('records ask and permission_request parts', () => {
    let state = createEmptyPartsState();
    state = reduceAgentParts(state, {
      type: 'task_waiting_input', taskId: 't', question: 'Which port?', ts: 1, eventId: 'a1',
    });
    state = reduceAgentParts(state, {
      type: 'permission_request',
      taskId: 't',
      requestId: 'p1',
      kind: 'shell',
      detail: 'run bun test',
      ts: 2,
      eventId: 'p1',
    });
    expect(state.parts.some(p => p.type === 'ask')).toBe(true);
    expect(state.parts.some(p => p.type === 'permission_request')).toBe(true);
  });
});
