import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import {
  parseBody,
  chatRequestSchema,
  createAgentTaskSchema,
  agentInputSchema,
  updateSettingsSchema,
} from '@/lib/infra/api-validation';

function jsonRequest(url: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('parseBody', () => {
  it('returns 400 for invalid JSON', async () => {
    const req = new NextRequest('http://localhost/api/chat', {
      method: 'POST',
      body: 'not-json{',
      headers: { 'Content-Type': 'application/json' },
    });
    const result = await parseBody(req, chatRequestSchema);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.response.status).toBe(400);
    const json = await result.response.json() as { error: string };
    expect(json.error).toBe('invalid JSON body');
  });

  it('returns 400 with zod details on validation failure', async () => {
    const result = await parseBody(
      jsonRequest('http://localhost/api/chat', { text: '', episodeId: 'ep-1' }),
      chatRequestSchema,
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.response.status).toBe(400);
    const json = await result.response.json() as { error: string; details: Array<{ path: string }> };
    expect(json.error).toBe('validation failed');
    expect(json.details.some(d => d.path === 'text')).toBe(true);
  });

  it('allows empty text when attachmentIds present', async () => {
    const result = await parseBody(
      jsonRequest('http://localhost/api/chat', {
        text: '',
        episodeId: 'ep-1',
        attachmentIds: ['att-1'],
      }),
      chatRequestSchema,
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.attachmentIds).toEqual(['att-1']);
  });

  it('parses valid chat request', async () => {
    const result = await parseBody(
      jsonRequest('http://localhost/api/chat', {
        text: 'Привет',
        episodeId: 'ep-123',
        mode: 'auto',
      }),
      chatRequestSchema,
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.text).toBe('Привет');
    expect(result.data.episodeId).toBe('ep-123');
    expect(result.data.mode).toBe('auto');
  });

  it('rejects legacy chat modes fast/standard/deep', async () => {
    const result = await parseBody(
      jsonRequest('http://localhost/api/chat', {
        text: 'Hi',
        episodeId: 'ep-1',
        mode: 'fast',
      }),
      chatRequestSchema,
    );
    expect(result.success).toBe(false);
  });

  it('keeps agent mode', async () => {
    const result = await parseBody(
      jsonRequest('http://localhost/api/chat', {
        text: 'Build app',
        episodeId: 'ep-1',
        mode: 'agent',
      }),
      chatRequestSchema,
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.mode).toBe('agent');
  });

  it('parses createAgentTaskSchema with template default', async () => {
    const result = await parseBody(
      jsonRequest('http://localhost/api/agent', {
        episodeId: 'ep-1',
        goal: 'Research topic',
      }),
      createAgentTaskSchema,
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.template).toBe('general');
    expect(result.data.autoStart).toBe(true);
  });

  it('accepts forceAgent on createAgentTaskSchema', async () => {
    const result = await parseBody(
      jsonRequest('http://localhost/api/agent', {
        episodeId: 'ep-1',
        goal: 'привет',
        forceAgent: true,
      }),
      createAgentTaskSchema,
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.forceAgent).toBe(true);
  });

  it('rejects agent input longer than 10000 chars', async () => {
    const result = await parseBody(
      jsonRequest('http://localhost/api/agent/x/input', { answer: 'x'.repeat(10_001) }),
      agentInputSchema,
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.response.status).toBe(400);
  });
});

describe('updateSettingsSchema', () => {
  it('accepts empty baseUrl (treat as omit) so model save still works', () => {
    const result = updateSettingsSchema.safeParse({
      baseUrl: '',
      model: 'dolphin-mistral:latest',
      agentModel: '',
      embedModel: '',
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.baseUrl).toBeUndefined();
    expect(result.data.model).toBe('dolphin-mistral:latest');
  });

  it('accepts valid baseUrl + model', () => {
    const result = updateSettingsSchema.safeParse({
      baseUrl: 'http://127.0.0.1:11434',
      model: 'qwen2.5:7b',
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.baseUrl).toBe('http://127.0.0.1:11434');
  });

  it('normalizes bare LAN IP to http://ip:11434', () => {
    const result = updateSettingsSchema.safeParse({
      baseUrl: '192.168.1.50',
      model: 'qwen2.5:7b',
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.baseUrl).toBe('http://192.168.1.50:11434');
  });

  it('rejects invalid baseUrl', () => {
    const result = updateSettingsSchema.safeParse({
      baseUrl: 'not a url',
      model: 'qwen2.5:7b',
    });
    expect(result.success).toBe(false);
  });
});
