import { describe, expect, it, vi } from 'vitest';
import { shouldUseClaudeCodeExecutor } from '@/lib/agent/claude-code/route';
import {
  buildClaudeCodeUserPrompt,
  promptLooksLikeLiaSystem,
} from '@/lib/agent/claude-code/prompt';
import {
  buildClaudeCodeChildEnv,
  assertOllamaAnthropicEnv,
  resolveClaudeCodeEndpoint,
  OLLAMA_COM_BASE_URL,
} from '@/lib/agent/claude-code/env';
import { toCloudModelTag, isCloudModelTag } from '@/lib/ollama-cloud-tags';
import { parseClaudeCodeStreamLine } from '@/lib/agent/claude-code/parse-stream';
import {
  createAfterResultWatchdog,
  streamChunkContainsResultEvent,
} from '@/lib/agent/claude-code/after-result-watchdog';
import {
  spawnableClaudeCandidates,
  resolveClaudeBinary,
} from '@/lib/agent/claude-code/detect';

describe('claude-code route', () => {
  it('routes project coding when enabled', () => {
    const d = shouldUseClaudeCodeExecutor({
      goal: 'Исправь TOCTOU в src/lib/infra/ssrf.ts',
      fsScope: '/Users/me/liaTest',
      claudeCodeEnabled: true,
    });
    expect(d.use).toBe(true);
  });

  it('skips sandbox create-runtime', () => {
    const d = shouldUseClaudeCodeExecutor({
      goal: 'Напиши игру тетрис',
      fsScope: '/tmp/download/agent-workspaces/task-1',
      claudeCodeEnabled: true,
    });
    expect(d.use).toBe(false);
    expect(d.reason).toBe('sandbox_create_runtime');
  });

  it('skips when disabled', () => {
    const d = shouldUseClaudeCodeExecutor({
      goal: 'Изучи проект и найди проблемы',
      fsScope: '/Users/me/proj',
      claudeCodeEnabled: false,
    });
    expect(d.use).toBe(false);
    expect(d.reason).toBe('claude_code_disabled');
  });

  it('skips KB lookup and news', () => {
    expect(shouldUseClaudeCodeExecutor({
      goal: 'Найди описание протокола EGTS в базе знаний',
      fsScope: '/Users/me/proj',
      claudeCodeEnabled: true,
    }).use).toBe(false);
    expect(shouldUseClaudeCodeExecutor({
      goal: 'какие основные новости за сегодня?',
      fsScope: '/Users/me/proj',
      claudeCodeEnabled: true,
    }).use).toBe(false);
  });
});

describe('claude-code prompt isolation', () => {
  it('builds goal + constraints without Lia markers', () => {
    const p = buildClaudeCodeUserPrompt({
      goal: 'Замени assertSafeUrl в ssrf.ts',
      fsScope: '/repo',
      workspaceContext: '## Project rules (AGENTS.md)\nUse bun test',
    });
    expect(p).toContain('Замени assertSafeUrl');
    expect(p).toContain('/repo');
    expect(p).toContain('AGENTS.md');
    expect(promptLooksLikeLiaSystem(p)).toBe(false);
  });

  it('strips legacy ## ЗАДАЧА template from goal', () => {
    const p = buildClaudeCodeUserPrompt({
      goal: 'Ты шаблон\n\n## ЗАДАЧА\nпочини файл',
      fsScope: '/repo',
    });
    expect(p).toContain('почини файл');
    expect(p).not.toContain('Ты шаблон');
  });
});

describe('claude-code env', () => {
  it('points ANTHROPIC_BASE_URL at Ollama and scrubs API key', () => {
    const { env } = buildClaudeCodeChildEnv({
      ollamaBaseUrl: 'http://192.168.1.50:11434/',
    });
    expect(env.ANTHROPIC_BASE_URL).toBe('http://192.168.1.50:11434');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('ollama');
    expect(env.ANTHROPIC_API_KEY).toBe('');
    expect(assertOllamaAnthropicEnv(env)).toBe(true);
  });

  it('rejects env with real API key set', () => {
    expect(assertOllamaAnthropicEnv({
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:11434',
      ANTHROPIC_AUTH_TOKEN: 'ollama',
      ANTHROPIC_API_KEY: 'sk-ant-real',
    })).toBe(false);
  });

  it('routes cloud+key to ollama.com', () => {
    const ep = resolveClaudeCodeEndpoint({
      ollamaBaseUrl: 'http://192.168.1.50:11434',
      model: 'glm-4.7:cloud',
      ollamaApiKey: 'ollama_sk_test',
    });
    expect(ep).toEqual({
      baseUrl: OLLAMA_COM_BASE_URL,
      authToken: 'ollama_sk_test',
      via: 'ollama_com',
    });
  });

  it('keeps host path for cloud without key', () => {
    const ep = resolveClaudeCodeEndpoint({
      ollamaBaseUrl: 'http://192.168.1.50:11434',
      model: 'glm-4.7:cloud',
      ollamaApiKey: '',
    });
    expect(ep.via).toBe('host');
    expect(ep.authToken).toBe('ollama');
  });
});

describe('ollama cloud tags', () => {
  it('normalizes library names to :cloud', () => {
    expect(toCloudModelTag('glm-5.1')).toBe('glm-5.1:cloud');
    expect(toCloudModelTag('glm-4.7:cloud')).toBe('glm-4.7:cloud');
    expect(isCloudModelTag('gpt-oss:20b-cloud')).toBe(true);
  });
});

describe('claude-code stream parse', () => {
  it('parses assistant text and tool_use', () => {
    const textEv = parseClaudeCodeStreamLine(JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'hi' }] },
    }));
    expect(textEv).toEqual({ kind: 'assistant_delta', text: 'hi' });

    const toolEv = parseClaudeCodeStreamLine(JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', name: 'Edit', input: { path: 'a.ts' } }],
      },
    }));
    expect(toolEv.kind).toBe('tool_start');
    if (toolEv.kind === 'tool_start') {
      expect(toolEv.tool).toBe('Edit');
    }
  });

  it('parses result', () => {
    const ev = parseClaudeCodeStreamLine(JSON.stringify({
      type: 'result',
      result: 'done',
      is_error: false,
    }));
    expect(ev).toEqual({ kind: 'result', text: 'done', success: true });
  });
});

describe('claude-code binary detect', () => {
  it('maps npm global .cmd shim to claude.exe', () => {
    const prev = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      const shim = 'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd';
      const candidates = spawnableClaudeCandidates(shim);
      expect(candidates[0]).toBe(
        'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe',
      );
      expect(candidates).toContain(shim);
    } finally {
      Object.defineProperty(process, 'platform', { value: prev });
    }
  });

  it('maps local .bin shim to package claude.exe', () => {
    const prev = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      const shim = 'C:\\repo\\node_modules\\.bin\\claude.cmd';
      const candidates = spawnableClaudeCandidates(shim);
      expect(candidates).toContain(
        'C:\\repo\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe',
      );
    } finally {
      Object.defineProperty(process, 'platform', { value: prev });
    }
  });

  it('resolves spawnable claude.exe on this machine when CLI is installed', async () => {
    const binary = await resolveClaudeBinary();
    if (!binary) return;
    expect(binary.toLowerCase()).toMatch(/claude\.exe$/);
  });
});

describe('claude-code after-result watchdog', () => {
  it('detects result lines in chunks', () => {
    expect(streamChunkContainsResultEvent('{"type":"assistant"}\n')).toBe(false);
    expect(streamChunkContainsResultEvent('{"type":"result","result":"ok"}\n')).toBe(true);
  });

  it('kills once after grace; onResult is idempotent', () => {
    vi.useFakeTimers();
    try {
      const kills: number[] = [];
      const wd = createAfterResultWatchdog({
        graceMs: 1000,
        kill: () => kills.push(1),
      });
      wd.onResult();
      wd.onResult();
      expect(wd.armed).toBe(true);
      expect(kills).toEqual([]);
      vi.advanceTimersByTime(999);
      expect(kills).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(kills).toEqual([1]);
      wd.clear();
    } finally {
      vi.useRealTimers();
    }
  });

  it('clear prevents kill', () => {
    vi.useFakeTimers();
    try {
      let killed = false;
      const wd = createAfterResultWatchdog({
        graceMs: 500,
        kill: () => {
          killed = true;
        },
      });
      wd.onResult();
      wd.clear();
      vi.advanceTimersByTime(1000);
      expect(killed).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
