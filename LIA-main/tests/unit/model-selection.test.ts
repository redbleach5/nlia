import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests for src/lib/chat/model-selection.ts
 */

vi.mock('@/lib/logger', () => ({
  logger: {
    context: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  },
}));

const mockOllamaSettings = {
  baseUrl: 'http://127.0.0.1:11434',
  model: 'qwen2.5:7b',
  agentModel: '',
  secondaryModel: '',
  heavyModel: '',
  embedModel: 'nomic-embed-text',
};

const mockHealth = {
  ok: true,
  models: ['qwen2.5:7b', 'qwen2.5:1.5b', 'nomic-embed-text', 'big:70b'],
  error: undefined as string | undefined,
};

vi.mock('@/lib/ollama', () => ({
  getOllamaSettings: vi.fn(async () => ({ ...mockOllamaSettings })),
  setOllamaSettings: vi.fn(async (params: { secondaryModel?: string; heavyModel?: string }) => {
    if (params.secondaryModel !== undefined) {
      mockOllamaSettings.secondaryModel = params.secondaryModel.trim();
    }
    if (params.heavyModel !== undefined) {
      mockOllamaSettings.heavyModel = params.heavyModel.trim();
    }
  }),
  checkOllamaHealth: vi.fn(async () => ({ ...mockHealth })),
}));

describe('chat/model-selection: getSecondaryModelName + setSecondaryModelName', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOllamaSettings.secondaryModel = '';
    mockOllamaSettings.heavyModel = '';
    mockOllamaSettings.model = 'qwen2.5:7b';
  });

  it('returns null when no secondary model is set', async () => {
    const { getSecondaryModelName } = await import('@/lib/chat/model-selection');
    expect(await getSecondaryModelName()).toBeNull();
  });

  it('persists and retrieves secondary model name', async () => {
    const { setSecondaryModelName, getSecondaryModelName } = await import('@/lib/chat/model-selection');
    await setSecondaryModelName('qwen2.5:1.5b');
    expect(await getSecondaryModelName()).toBe('qwen2.5:1.5b');
  });

  it('clears secondary model when passed null', async () => {
    const { setSecondaryModelName, getSecondaryModelName } = await import('@/lib/chat/model-selection');
    await setSecondaryModelName('qwen2.5:1.5b');
    await setSecondaryModelName(null);
    expect(await getSecondaryModelName()).toBeNull();
  });
});

describe('chat/model-selection: chooseModelForQuery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOllamaSettings.secondaryModel = '';
    mockOllamaSettings.heavyModel = '';
    mockOllamaSettings.model = 'qwen2.5:7b';
    mockHealth.ok = true;
    mockHealth.models = ['qwen2.5:7b', 'qwen2.5:1.5b', 'big:70b'];
  });

  it('uses secondary for trivial complexity when configured and available', async () => {
    const { setSecondaryModelName, chooseModelForQuery } = await import('@/lib/chat/model-selection');
    await setSecondaryModelName('qwen2.5:1.5b');

    const choice = await chooseModelForQuery('trivial', 'standard');
    expect(choice.usedSecondary).toBe(true);
    expect(choice.modelName).toBe('qwen2.5:1.5b');
    expect(choice.reason).toBe('trivial-use-secondary');
  });

  it('uses primary for simple complexity', async () => {
    const { setSecondaryModelName, chooseModelForQuery } = await import('@/lib/chat/model-selection');
    await setSecondaryModelName('qwen2.5:1.5b');

    const choice = await chooseModelForQuery('simple', 'standard');
    expect(choice.usedSecondary).toBe(false);
    expect(choice.usedHeavy).toBe(false);
    expect(choice.modelName).toBe('qwen2.5:7b');
    expect(choice.reason).toBe('primary');
  });

  it('research stays on day companion (heavy is agent-only)', async () => {
    mockOllamaSettings.heavyModel = 'big:70b';
    const { chooseModelForQuery } = await import('@/lib/chat/model-selection');
    const choice = await chooseModelForQuery('research', 'plus');
    expect(choice.usedHeavy).toBe(false);
    expect(choice.modelName).toBe('qwen2.5:7b');
    expect(choice.reason).toBe('primary');
    expect(choice.heavyModelName).toBe('big:70b');
  });

  it('research without heavy stays primary', async () => {
    const { chooseModelForQuery } = await import('@/lib/chat/model-selection');
    const choice = await chooseModelForQuery('research', 'plus');
    expect(choice.usedHeavy).toBe(false);
    expect(choice.reason).toBe('primary');
  });

  it('returns no-secondary-configured when secondary is not set', async () => {
    const { chooseModelForQuery } = await import('@/lib/chat/model-selection');
    const choice = await chooseModelForQuery('trivial', 'standard');
    expect(choice.reason).toBe('no-secondary-configured');
  });

  it('skips secondary for micro tier', async () => {
    const { setSecondaryModelName, chooseModelForQuery } = await import('@/lib/chat/model-selection');
    await setSecondaryModelName('qwen2.5:0.5b');
    const choice = await chooseModelForQuery('trivial', 'micro');
    expect(choice.reason).toBe('tier-too-small');
  });

  it('falls back when secondary model is not pulled', async () => {
    const { setSecondaryModelName, chooseModelForQuery } = await import('@/lib/chat/model-selection');
    await setSecondaryModelName('nonexistent:1b');
    mockHealth.models = ['qwen2.5:7b'];
    const choice = await chooseModelForQuery('trivial', 'standard');
    expect(choice.reason).toBe('secondary-not-pulled');
  });
});
