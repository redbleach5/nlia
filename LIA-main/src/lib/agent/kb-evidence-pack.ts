import 'server-only';

import type { AgentStepSlice } from './kb-step-utils';
import { isKbAgentAction } from './kb-step-utils';
import { extractFocusKeywords, scoreTextAgainstKeywords } from '@/lib/kb/chunk-focus';

/** Soft budget for grounded synthesis evidence (chars). */
export const KB_SYNTHESIS_EVIDENCE_BUDGET = 14_000;

type EvidencePiece = {
  score: number;
  text: string;
  label: string;
};

function tryParseJson(obs: string): unknown | null {
  const start = obs.indexOf('{');
  const end = obs.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(obs.slice(start, end + 1));
  } catch {
    return null;
  }
}

function collectPiecesFromObservation(
  action: string,
  observation: string,
  keywords: string[],
): EvidencePiece[] {
  const pieces: EvidencePiece[] = [];
  const parsed = tryParseJson(observation);

  if (parsed && typeof parsed === 'object' && parsed !== null) {
    const obj = parsed as Record<string, unknown>;

    // search_sources / get_source / get_ticket style
    if (Array.isArray(obj.chunks)) {
      for (const raw of obj.chunks) {
        if (!raw || typeof raw !== 'object') continue;
        const ch = raw as Record<string, unknown>;
        const content = typeof ch.content === 'string' ? ch.content : '';
        if (!content.trim()) continue;
        const citation =
          (typeof ch.citation === 'string' && ch.citation)
          || (typeof ch.source === 'string' && ch.source)
          || null;
        const label = citation ? `chunk [${citation}]` : 'chunk';
        pieces.push({
          score: scoreTextAgainstKeywords(content, keywords),
          text: content,
          label,
        });
      }
    }

    // read_folder_file
    if (typeof obj.content === 'string' && obj.content.trim()) {
      const path = typeof obj.relativePath === 'string' ? obj.relativePath : 'file';
      pieces.push({
        score: scoreTextAgainstKeywords(obj.content, keywords),
        text: obj.content,
        label: `file:${path}`,
      });
    }
  }

  // Fallback: whole observation as one piece
  if (pieces.length === 0 && observation.trim()) {
    pieces.push({
      score: scoreTextAgainstKeywords(observation, keywords),
      text: observation,
      label: action,
    });
  }

  return pieces;
}

/**
 * Build synthesis evidence: prefer goal-relevant chunks over head-truncation.
 * Does not inflate system prompts — only the volatile user evidence block.
 */
export function packKbEvidenceForSynthesis(
  goal: string,
  steps: AgentStepSlice[],
  budget = KB_SYNTHESIS_EVIDENCE_BUDGET,
): string {
  const keywords = extractFocusKeywords(goal);
  const kbSteps = steps.filter((s) => isKbAgentAction(s.action));
  const pieces: EvidencePiece[] = [];

  for (const step of kbSteps) {
    pieces.push(...collectPiecesFromObservation(step.action, step.observation, keywords));
  }

  if (pieces.length === 0) {
    return 'Исследование не дало результатов.';
  }

  pieces.sort((a, b) => b.score - a.score);

  const parts: string[] = [];
  let used = 0;
  let n = 0;
  for (const p of pieces) {
    if (p.score === 0 && n >= 3 && keywords.length > 0) continue;
    const block = `### ${p.label}\n${p.text}`;
    if (used + block.length > budget && n > 0) break;
    const slice = block.length > budget - used
      ? block.slice(0, Math.max(0, budget - used)) + '\n…[truncated]'
      : block;
    parts.push(slice);
    used += slice.length;
    n += 1;
    if (used >= budget) break;
  }

  return parts.join('\n\n') || 'Исследование не дало результатов.';
}
