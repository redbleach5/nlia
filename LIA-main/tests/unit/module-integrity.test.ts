import { describe, it, expect } from 'vitest';
import type { AgentTask } from '@/lib/agent/task';

function agentTaskFixture(): AgentTask {
  return {
    id: 'test',
    episodeId: 'episode-test',
    goal: 'test',
    status: 'pending',
    planJson: null,
    stepsJson: '[]',
    currentStep: 0,
    maxSteps: 1,
    maxDurationSec: 60,
    resultSummary: null,
    error: null,
    toolsWhitelist: null,
    fsScope: null,
    checkpointJson: null,
    artifactsJson: '[]',
    startedAt: null,
    completedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

/**
 * Regression test: detect broken imports / parse errors / type errors
 * in agent tool modules BEFORE they ship.
 *
 * Background (2026-07-08): the project shipped with a syntax error in
 * `src/lib/agent/tools/search-codebase.ts` (multiline single-quoted string).
 * `tools.ts` imported it directly, so `bun run build` was broken end-to-end
 * — yet the vitest suite stayed green because no test imported `tools.ts`
 * without mocks. `peripheral-smoke.test.ts` mocked `@/lib/ollama` wholesale,
 * which short-circuited the import chain.
 *
 * This test imports the real `tools.ts` (no mocks) and verifies that
 * `buildAgentTools` and codebase/KB tool factories are exported
 * and callable. If any upstream module has a parse error or a missing
 * export, this test fails — even if no other test exercises that path.
 *
 * The test does NOT actually build a real AgentTask or call the tool
 * `execute` functions (those need a DB and would belong in tests/core/).
 * It only checks that the module graph compiles and the factories are
 * shaped correctly.
 */

describe('module integrity — agent tools importable without mocks', () => {
  it('buildAgentTools is exported and is a function', async () => {
    const mod = await import('@/lib/agent/tools');
    expect(typeof mod.buildAgentTools).toBe('function');
    expect(typeof mod.describeTools).toBe('function');
  });

  it('search-codebase tool factories are exported and callable', async () => {
    // This is the file that was broken — direct import to catch any
    // future regression in its parse/compile step.
    const mod = await import('@/lib/agent/tools/search-codebase');
    expect(typeof mod.makeSearchCodebaseTool).toBe('function');
    expect(typeof mod.makeListCodebaseSymbolsTool).toBe('function');

    // Calling the factory must not throw. The returned tool has the
    // AI SDK shape: { description, inputSchema, execute }.
    const t1 = mod.makeSearchCodebaseTool();
    expect(t1).toBeDefined();
    expect(typeof t1.execute).toBe('function');

    const t2 = mod.makeListCodebaseSymbolsTool();
    expect(t2).toBeDefined();
    expect(typeof t2.execute).toBe('function');
  });

  it('kb tool factories are exported and callable', async () => {
    const kb = await import('@/lib/kb/tools');
    expect(typeof kb.makeSearchSourcesTool).toBe('function');
    expect(typeof kb.makeGetSourceTool).toBe('function');
    expect(typeof kb.makeListSourcesTool).toBe('function');
  });

  it('grep tool factory is exported and callable', async () => {
    const mod = await import('@/lib/agent/tools/grep');
    expect(typeof mod.makeGrepTool).toBe('function');
    const t = mod.makeGrepTool(agentTaskFixture());
    expect(t).toBeDefined();
    expect(typeof t.execute).toBe('function');
  });

  it('run_command tool factory is exported and callable', async () => {
    const mod = await import('@/lib/agent/tools/run-command');
    expect(typeof mod.makeRunCommandTool).toBe('function');
    expect(typeof mod.validateRunCommand).toBe('function');
    const t = mod.makeRunCommandTool(agentTaskFixture());
    expect(t).toBeDefined();
    expect(typeof t.execute).toBe('function');
  });

  it('code-seed module exports buildCodeExplorationSeed', async () => {
    const mod = await import('@/lib/agent/code-seed');
    expect(typeof mod.buildCodeExplorationSeed).toBe('function');
  });
});
