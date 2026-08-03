import 'server-only';

/**
 * Heuristic: local/cloud chat models that accept image parts in messages.
 * When false, images are still stored for UI but only a text note is injected.
 */
export function modelSupportsVision(modelName: string): boolean {
  const m = modelName.toLowerCase();
  const patterns = [
    'llava',
    'bakllava',
    'moondream',
    'minicpm-v',
    'minicpm-v',
    'qwen2-vl',
    'qwen2.5-vl',
    'qwen3-vl',
    'llama3.2-vision',
    'llama-3.2-vision',
    'gemma3',
    'pixtral',
    'vision',
    'vl-',
    '-vl',
  ];
  return patterns.some(p => m.includes(p));
}
