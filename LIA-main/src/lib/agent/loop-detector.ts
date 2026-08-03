import 'server-only';

// Loop detector — detects when agent is stuck in a loop.
//
// Three signals:
//   1. Pattern: same tool + same input N times in a row
//   2. Empty results: N consecutive empty/error observations
//   3. Semantic: embeddings of last 3 thoughts too similar (>0.85 cosine)
//
// On any signal → return true, runner should pause and ask user.
//
// ВАЖНО: ошибки LLM (timeout, connection refused, malformed response) НЕ считаются
// "пустым результатом". Это инфраструктурная проблема, не цикл. Если LLM
// таймаутит 2 раза подряд — это не значит что агент "застрял в цикле",
// это значит что LLM слишком медленный или недоступен. В этом случае
// детектор не срабатывает, и агент может попробовать другой шаг.
//
// Дополнительные различия (для ясного логирования):
//   - 'pattern': модель генерирует идентичный tool call → точно цикл, нужен ask_user
//   - 'empty': разные tool calls, но все возвращают пустой результат → возможно
//     модель ищет не там, нужен ask_user или другая стратегия
//   - 'semantic': разные tool calls, но мысли identical → модель "думает" одно
//     и то же, нужен ask_user
//   - 'llm_error': НЕ цикл, инфраструктурная проблема → не срабатывает детектор,
//     но логируется отдельно в runner для retry logic

import { embed } from '@/lib/ollama';
import { hasSuccessfulKbMaterial } from './kb-step-utils';

export type Step = {
  thought: string;
  action: string;
  input: unknown;
  observation: string;
};

const PATTERN_LIMIT = 2;       // same tool+input max 2 times
const EMPTY_LIMIT = 3;         // 3 empty observations in a row → exit (increased from 2)
const SEMANTIC_THRESHOLD = 0.85;
const SEMANTIC_WINDOW = 3;     // check last 3 thoughts

type LoopSignal =
  | { kind: 'pattern'; tool: string; input: unknown; count: number; message: string }
  | { kind: 'empty'; count: number; message: string }
  | { kind: 'semantic'; similarity: number; message: string }
  | null;

// Признаки LLM-ошибок в observation — НЕ считаются "пустым результатом".
// Это инфраструктурные ошибки, не цикл.
const LLM_ERROR_MARKERS = [
  'streamtext timeout',
  'plan generation timeout',
  'synthesize timeout',
  'no output generated',
  'ai_apicallerror',
  'ai_retryerror',
  'ai_nooutputgeneratederror',
  'econnrefused',
  'fetch failed',
  'connect econnrefused',
  'rate limit',
  '429',
  '503',
  '502',
  '504',
];

function isLlmError(observation: string): boolean {
  const lower = observation.toLowerCase();
  return LLM_ERROR_MARKERS.some(m => lower.includes(m));
}

/** Successful web_search / fetch_page — model already has enough to synthesize a news/summary answer. */
export function hasSuccessfulWebMaterial(steps: Step[]): boolean {
  return steps.some((s) => {
    if (!/^(web_search|fetch_page|http_request)$/.test(s.action)) return false;
    const o = s.observation || '';
    if (/"error"\s*:/.test(o)) return false;
    if (/"results"\s*:\s*\[\s*\]/.test(o)) return false;
    return o.length >= 200;
  });
}

function detectPatternLoop(steps: Step[]): LoopSignal {
  if (steps.length < PATTERN_LIMIT + 1) return null;

  const last = steps[steps.length - 1];
  // Runner-injected hints must not count as model tool loops.
  if (last.action === 'strategy_hint' || last.action === 'user_guidance') return null;
  // M8 fix: stable stringify so {a:1,b:2} and {b:2,a:1} match.
  const actionKey = `${last.action}:${stableStringify(last.input)}`;

  let count = 1;
  for (let i = steps.length - 2; i >= 0; i--) {
    const s = steps[i];
    if (`${s.action}:${stableStringify(s.input)}` === actionKey) {
      count++;
      if (count > PATTERN_LIMIT) {
        return {
          kind: 'pattern',
          tool: last.action,
          input: last.input,
          count,
          message: `Agent called ${last.action} with identical input ${count} times in a row. This is a true loop — model is not making progress. Ask user for clarification.`,
        };
      }
    } else {
      break;
    }
  }
  return null;
}

/**
 * M8 fix: stable JSON stringify — sorts object keys recursively.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const pairs = keys.map(k => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`);
  return `{${pairs.join(',')}}`;
}

function detectEmptyLoop(steps: Step[]): LoopSignal {
  if (steps.length < EMPTY_LIMIT) return null;

  const lastN = steps.slice(-EMPTY_LIMIT);
  let emptyCount = 0;
  let llmErrorCount = 0;
  let differentTools = new Set<string>();

  for (const s of lastN) {
    const obs = s.observation?.trim() ?? '';
    differentTools.add(s.action);

    // Если это LLM-ошибка (timeout, connection) — НЕ считаем пустым результатом.
    // Это инфраструктурная проблема, не цикл.
    if (isLlmError(obs)) {
      llmErrorCount++;
      // Прерываем подсчёт — LLM-ошибки не должны суммироваться с пустыми результатами.
      // Возвращаем null — детектор не срабатывает, runner решает что делать
      // (обычно retry на следующем шаге).
      return null;
    }

    if (obs.length === 0 || obs.length < 20) {
      emptyCount++;
    }
  }

  if (emptyCount >= EMPTY_LIMIT) {
    const toolsDesc = differentTools.size > 1
      ? `${differentTools.size} different tools`
      : 'same tool';
    return {
      kind: 'empty',
      count: emptyCount,
      message: `Agent got ${emptyCount} empty results in a row from ${toolsDesc}. ${differentTools.size > 1 ? 'Model is trying different approaches but none work — likely searching wrong location or missing context.' : 'Same tool keeps returning empty — model may be stuck on a wrong query.'} Ask user for clarification.`,
    };
  }
  return null;
}

/**
 * Semantic similarity check — uses embeddings.
 * Skipped if embed fails (non-fatal).
 */
async function detectSemanticLoop(steps: Step[]): Promise<LoopSignal> {
  if (steps.length < SEMANTIC_WINDOW) return null;

  const window = steps.slice(-SEMANTIC_WINDOW);
  // Ignore runner-injected hints — they share boilerplate thoughts.
  if (window.every((s) => s.action === 'strategy_hint' || s.action === 'user_guidance')) {
    return null;
  }

  // После успешного read_folder_file / search_sources модель часто делает несколько
  // шагов reason с похожими мыслями — detectLoop() уже отключает semantic/pattern reason.
  const recent = window.map(s => s.thought);
  if (recent.some(t => !t || t.trim().length === 0)) return null;

  try {
    const embeddings = await Promise.all(recent.map(t => embed(t).catch(() => null)));
    if (embeddings.some(e => e === null)) return null;
    const nonNullEmbeddings = embeddings as Float32Array[];

    // Compare each pair, return max similarity
    let maxSim = 0;
    for (let i = 0; i < nonNullEmbeddings.length; i++) {
      for (let j = i + 1; j < nonNullEmbeddings.length; j++) {
        const sim = cosine(nonNullEmbeddings[i], nonNullEmbeddings[j]);
        if (sim > maxSim) maxSim = sim;
      }
    }
    if (maxSim >= SEMANTIC_THRESHOLD) {
      return {
        kind: 'semantic',
        similarity: maxSim,
        message: `Agent's last ${SEMANTIC_WINDOW} thoughts are ${(maxSim * 100).toFixed(0)}% similar. Model is "thinking" the same thing repeatedly without making progress. Ask user for clarification or new direction.`,
      };
    }
  } catch {
    return null;
  }
  return null;
}

function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Combined check — runs all three detectors.
 * Returns the first signal found, or null.
 */
export async function detectLoop(steps: Step[]): Promise<LoopSignal> {
  // Already have usable evidence → let runner synthesize; don't ask_user on similar thoughts.
  if (hasSuccessfulKbMaterial(steps) || hasSuccessfulWebMaterial(steps)) {
    return null;
  }

  return detectPatternLoop(steps)
    ?? detectEmptyLoop(steps)
    ?? await detectSemanticLoop(steps);
}
