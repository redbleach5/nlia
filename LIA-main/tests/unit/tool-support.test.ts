import { describe, it, expect, beforeEach } from 'vitest';
import {
  modelSupportsTools,
  _resetToolsCapabilityCache,
} from '@/lib/llm/tool-support';

describe('modelSupportsTools', () => {
  beforeEach(() => {
    _resetToolsCapabilityCache();
  });

  it('disables tools for dolphin-mistral-nemo Ollama tags', () => {
    expect(modelSupportsTools('CognitiveComputations/dolphin-mistral-nemo:12b')).toBe(false);
    expect(modelSupportsTools('registry.ollama.ai/CognitiveComputations/dolphin-mistral-nemo:12b')).toBe(false);
    expect(modelSupportsTools('dolphin-mistral-nemo:12b')).toBe(false);
  });

  it('keeps tools for library dolphin3 / qwen / llama', () => {
    expect(modelSupportsTools('dolphin3')).toBe(true);
    expect(modelSupportsTools('dolphin3:8b')).toBe(true);
    expect(modelSupportsTools('dolphin-llama3:8b')).toBe(true);
    expect(modelSupportsTools('qwen3:8b')).toBe(true);
    expect(modelSupportsTools('qwen2.5:7b')).toBe(true);
    expect(modelSupportsTools('llama-3.3-70b-versatile')).toBe(true);
    expect(modelSupportsTools('mistral-nemo:12b')).toBe(true);
  });

  it('disables tools for gemma / phi', () => {
    expect(modelSupportsTools('gemma3:4b')).toBe(false);
    expect(modelSupportsTools('phi3:mini')).toBe(false);
  });
});
