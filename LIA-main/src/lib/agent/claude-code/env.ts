/**
 * Build child-process env for Claude Code → Ollama Anthropic Messages API.
 * Scrubs inherited Anthropic keys so a real API key cannot override Ollama.
 */

import { normalizeOllamaBaseUrl } from '@/lib/ollama-base-url';
import { isCloudModelTag } from '@/lib/ollama-cloud-tags';

export const OLLAMA_COM_BASE_URL = 'https://ollama.com';

export type ClaudeCodeEnvInput = {
  ollamaBaseUrl: string;
  /** When using ollama.com cloud, pass API key; local → token "ollama". */
  ollamaAuthToken?: string;
  extraPath?: string;
};

export type ClaudeCodeEndpoint = {
  baseUrl: string;
  authToken: string;
  /** host = Settings Ollama (path A / local); ollama_com = direct cloud (path B). */
  via: 'host' | 'ollama_com';
};

/**
 * Cloud model + API key → https://ollama.com; otherwise Settings host + token "ollama".
 */
export function resolveClaudeCodeEndpoint(opts: {
  ollamaBaseUrl: string;
  model: string;
  ollamaApiKey?: string | null;
}): ClaudeCodeEndpoint {
  const key = (opts.ollamaApiKey ?? '').trim();
  if (key && isCloudModelTag(opts.model)) {
    return { baseUrl: OLLAMA_COM_BASE_URL, authToken: key, via: 'ollama_com' };
  }
  return {
    baseUrl: opts.ollamaBaseUrl,
    authToken: 'ollama',
    via: 'host',
  };
}

export type ClaudeCodeChildEnv = {
  env: NodeJS.ProcessEnv;
  anthropicBaseUrl: string;
};

/**
 * Pure builder — unit-testable.
 * Does NOT spread process.env (would leak ANTHROPIC_API_KEY).
 */
export function buildClaudeCodeChildEnv(input: ClaudeCodeEnvInput): ClaudeCodeChildEnv {
  const normalized = normalizeOllamaBaseUrl(input.ollamaBaseUrl) ?? input.ollamaBaseUrl;
  const base = normalized.replace(/\/$/, '');
  // Ollama Anthropic-compatible endpoint is the host root (not /v1).
  const anthropicBaseUrl = base;
  const token = (input.ollamaAuthToken ?? 'ollama').trim() || 'ollama';

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: input.extraPath ?? process.env.PATH,
    ANTHROPIC_BASE_URL: anthropicBaseUrl,
    ANTHROPIC_AUTH_TOKEN: token,
    // Explicit empty — blocks inherited real keys from parent shell.
    ANTHROPIC_API_KEY: '',
  };
  // Drop common secret carriers so CC child cannot see them.
  delete env.OPENAI_API_KEY;
  delete env.ANTHROPIC_API_KEY;
  env.ANTHROPIC_API_KEY = '';

  return { env, anthropicBaseUrl };
}

/** True when env correctly forces Ollama path (no real API key). */
export function assertOllamaAnthropicEnv(env: NodeJS.ProcessEnv): boolean {
  if (!env.ANTHROPIC_BASE_URL) return false;
  if (env.ANTHROPIC_API_KEY && env.ANTHROPIC_API_KEY.trim() !== '') return false;
  return Boolean(env.ANTHROPIC_AUTH_TOKEN);
}
