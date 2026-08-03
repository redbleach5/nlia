import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logger', () => ({
  logger: {
    context: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  },
}));

const mockSettings = new Map<string, string>();

const mockDb = {
  setting: {
    findUnique: vi.fn(async ({ where }: { where: { key: string } }) => {
      const value = mockSettings.get(where.key);
      return value !== undefined ? { key: where.key, value } : null;
    }),
    upsert: vi.fn(async ({ where, update }: {
      where: { key: string }; create: { key: string; value: string }; update: { value: string };
    }) => {
      mockSettings.set(where.key, update.value);
      return { key: where.key, value: update.value };
    }),
    deleteMany: vi.fn(async ({ where }: { where: { key: string } }) => {
      mockSettings.delete(where.key);
      return { count: 1 };
    }),
  },
};
vi.mock('@/lib/db', () => ({ db: mockDb }));

const writeFileSync = vi.fn();
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    writeFileSync,
    existsSync: vi.fn(() => true),
    readFileSync: vi.fn(() => 'OLLAMA_MODEL=stale-from-file\n'),
  };
});

describe('ollama-env-sync reconcile', () => {
  beforeEach(async () => {
    mockSettings.clear();
    writeFileSync.mockClear();
    vi.clearAllMocks();
    delete process.env.OLLAMA_BASE_URL;
    delete process.env.OLLAMA_MODEL;
    delete process.env.OLLAMA_AGENT_MODEL;
    delete process.env.OLLAMA_EMBED_MODEL;

    const { resetOllamaEnvReconcileForTests } = await import('@/lib/infra/ollama-env-sync');
    resetOllamaEnvReconcileForTests();
  });

  it('seeds DB from bootstrap snapshot when ollama_model is missing', async () => {
    const { reconcileOllamaEnvAndDb } = await import('@/lib/infra/ollama-env-sync');

    await reconcileOllamaEnvAndDb({
      baseUrl: 'http://192.168.1.50:11434',
      model: 'qwen3:14b',
      agentModel: '',
      embedModel: 'nomic-embed-text-v2-moe',
    });

    expect(mockSettings.get('ollama_model')).toBe('qwen3:14b');
    expect(mockSettings.get('ollama_base_url')).toBe('http://192.168.1.50:11434');
    expect(mockSettings.get('ollama_embed_model')).toBe('nomic-embed-text-v2-moe');
    expect(process.env.OLLAMA_MODEL).toBe('qwen3:14b');
    expect(process.env.OLLAMA_BASE_URL).toBe('http://192.168.1.50:11434');
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it('does not rewrite .env when DB already has a model', async () => {
    mockSettings.set('ollama_model', 'qwen3:14b');
    mockSettings.set('ollama_base_url', 'http://192.168.178.145:11434');

    const { reconcileOllamaEnvAndDb } = await import('@/lib/infra/ollama-env-sync');

    await reconcileOllamaEnvAndDb({
      baseUrl: 'http://192.168.178.145:11434',
      model: 'qwen3:14b',
      agentModel: 'qwen3:8b',
      embedModel: 'nomic-embed-text',
    });

    expect(writeFileSync).not.toHaveBeenCalled();
    expect(process.env.OLLAMA_MODEL).toBe('qwen3:14b');
    expect(process.env.OLLAMA_BASE_URL).toBe('http://192.168.178.145:11434');
    expect(process.env.OLLAMA_AGENT_MODEL).toBe('qwen3:8b');
    // Seed path should not have run — no extra upserts beyond findUnique
    expect(mockDb.setting.upsert).not.toHaveBeenCalled();
  });

  it('mirrorOllamaToProcessEnv updates process.env without writing .env', async () => {
    const { mirrorOllamaToProcessEnv } = await import('@/lib/infra/ollama-env-sync');

    mirrorOllamaToProcessEnv({
      baseUrl: 'http://10.0.0.2:11434',
      model: 'dolphin3',
      agentModel: '',
      embedModel: '',
    });

    expect(process.env.OLLAMA_BASE_URL).toBe('http://10.0.0.2:11434');
    expect(process.env.OLLAMA_MODEL).toBe('dolphin3');
    expect(process.env.OLLAMA_AGENT_MODEL).toBeUndefined();
    expect(process.env.OLLAMA_EMBED_MODEL).toBeUndefined();
    expect(writeFileSync).not.toHaveBeenCalled();
  });
});
