import 'server-only';

import { streamText } from 'ai';
import { logger } from '@/lib/logger';
import { isKbAgentAction, truncateObservationForSynthesis } from './kb-step-utils';
import { packKbEvidenceForSynthesis } from './kb-evidence-pack';
import type { AgentStepSlice, GroundedKbAnswer, GroundedKbFact } from './kb-step-utils';

export type ClaimVerdict = 'supported' | 'unsupported' | 'uncertain';

export type VerifiedClaim = GroundedKbFact & {
  verdict: ClaimVerdict;
  score: number;
};

const STOP = new Set([
  'это', 'как', 'для', 'или', 'при', 'что', 'его', 'её', 'их', 'все', 'всё',
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'are', 'was', 'were',
  'подзапись', 'сервиса', 'сервис', 'поле', 'поля', 'данных', 'данные',
  'протокол', 'записи', 'запись', 'также', 'может', 'быть', 'между',
]);

/** Distinctive tokens: UPPER_SNAKE, numbers, words ≥4 chars (ru/en). */
export function extractClaimTokens(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\b[A-Z][A-Z0-9_]{2,}\b/g)) {
    out.add(m[0].toLowerCase());
  }
  for (const m of text.matchAll(/\b\d{2,}\b/g)) {
    out.add(m[0]);
  }
  for (const m of text.toLowerCase().matchAll(/[a-zа-яё]{4,}/giu)) {
    const t = m[0].toLowerCase();
    if (!STOP.has(t)) out.add(t);
  }
  return [...out];
}

/**
 * Latin parenthetical / glossary-style expansions that often hallucinate
 * (e.g. "EGTS (European Trolleybus System)").
 */
export function extractGlossaryExpansions(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(/\(([A-Za-z][A-Za-z0-9][A-Za-z0-9\s\-/,.]{6,80})\)/g)) {
    found.push(m[1].trim());
  }
  for (const m of text.matchAll(
    /\b[A-Z]{2,}[A-Z0-9_]*\s*(?:=|—|–|-|означает|это)\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,6})\b/gi,
  )) {
    found.push(m[1].trim());
  }
  // Bare multi-word Title Case Latin phrases (European Trolleybus System).
  for (const m of text.matchAll(/\b([A-Z][a-z]{3,}(?:\s+[A-Z][a-z]{3,}){1,5})\b/g)) {
    found.push(m[1].trim());
  }
  return [...new Set(found)];
}

export function buildKbEvidenceCorpus(steps: AgentStepSlice[], goal = ''): string {
  if (goal.trim()) {
    return packKbEvidenceForSynthesis(goal, steps).toLowerCase();
  }
  return steps
    .filter((s) => isKbAgentAction(s.action))
    .map((s) => truncateObservationForSynthesis(s.action, s.observation))
    .join('\n\n')
    .toLowerCase();
}

export function scoreClaimAgainstEvidence(claim: string, evidenceLower: string): number {
  const tokens = extractClaimTokens(claim);
  if (tokens.length === 0) return evidenceLower.length > 0 ? 0.3 : 0;
  let hits = 0;
  for (const t of tokens) {
    if (evidenceLower.includes(t)) hits += 1;
  }
  return hits / tokens.length;
}

export function hasUngroundedGlossaryExpansion(claim: string, evidenceLower: string): boolean {
  const expansions = extractGlossaryExpansions(claim);
  if (expansions.length === 0) return false;
  for (const exp of expansions) {
    const tokens = exp
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 4);
    if (tokens.length === 0) continue;
    const missing = tokens.filter((t) => !evidenceLower.includes(t));
    // If most expansion words are absent from evidence — treat as hallucination.
    if (missing.length / tokens.length >= 0.6) return true;
  }
  return false;
}

export function classifyClaimLexically(claim: string, evidenceLower: string): {
  verdict: ClaimVerdict;
  score: number;
} {
  if (!evidenceLower.trim()) {
    return { verdict: 'unsupported', score: 0 };
  }
  if (hasUngroundedGlossaryExpansion(claim, evidenceLower)) {
    return { verdict: 'unsupported', score: 0 };
  }
  const score = scoreClaimAgainstEvidence(claim, evidenceLower);
  if (score >= 0.42) return { verdict: 'supported', score };
  if (score >= 0.18) return { verdict: 'uncertain', score };
  return { verdict: 'unsupported', score };
}

function splitSummarySentences(summary: string): string[] {
  return summary
    .split(/(?<=[.!?…])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Lexical groundedness filter — no LLM, no prompt bloat.
 * Drops unsupported facts/summary sentences; keeps uncertain for optional LLM pass.
 */
export function filterGroundedAnswerLexically(
  answer: GroundedKbAnswer,
  evidenceLower: string,
): {
  kept: GroundedKbAnswer;
  droppedFacts: GroundedKbFact[];
  uncertainFacts: GroundedKbFact[];
  droppedSummaryParts: string[];
  uncertainSummaryParts: string[];
} {
  const droppedFacts: GroundedKbFact[] = [];
  const uncertainFacts: GroundedKbFact[] = [];
  const keptFacts: GroundedKbFact[] = [];

  for (const fact of answer.facts) {
    const { verdict } = classifyClaimLexically(fact.text, evidenceLower);
    if (verdict === 'supported') keptFacts.push(fact);
    else if (verdict === 'uncertain') uncertainFacts.push(fact);
    else droppedFacts.push(fact);
  }

  const droppedSummaryParts: string[] = [];
  const uncertainSummaryParts: string[] = [];
  const keptSummaryParts: string[] = [];
  for (const part of splitSummarySentences(answer.summary)) {
    const { verdict } = classifyClaimLexically(part, evidenceLower);
    if (verdict === 'supported') keptSummaryParts.push(part);
    else if (verdict === 'uncertain') uncertainSummaryParts.push(part);
    else droppedSummaryParts.push(part);
  }

  let summary = keptSummaryParts.join(' ');
  // If everything in summary was uncertain/dropped but we still have facts, rebuild lightly.
  if (!summary && keptFacts.length > 0) {
    summary = keptFacts.slice(0, 2).map((f) => f.text).join(' ');
  }

    let missing = answer.missing;
    if (droppedFacts.length > 0 || droppedSummaryParts.length > 0) {
      // Internal marker; applyGroundednessFilter strips it when answer still usable.
      const note = 'часть утверждений отфильтрована как неподтверждённые источниками';
      missing = missing ? `${missing}; ${note}` : note;
    }

  return {
    kept: {
      summary,
      facts: keptFacts,
      missing,
    },
    droppedFacts,
    uncertainFacts,
    droppedSummaryParts,
    uncertainSummaryParts,
  };
}

function parseLlmVerdicts(raw: string, count: number): boolean[] | null {
  try {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    const parsed = JSON.parse(raw.slice(start, end + 1)) as {
      verdicts?: Array<{ i?: number; ok?: boolean }>;
    };
    if (!Array.isArray(parsed.verdicts)) return null;
    const out = Array.from({ length: count }, () => false);
    for (const v of parsed.verdicts) {
      if (typeof v?.i === 'number' && v.i >= 0 && v.i < count && typeof v.ok === 'boolean') {
        out[v.i] = v.ok;
      }
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Short LLM groundedness judge for uncertain claims only.
 * Does not touch STATIC system prompts — ephemeral verifier call.
 */
export async function verifyUncertainClaimsWithLlm(
  claims: string[],
  evidence: string,
  model: Parameters<typeof streamText>[0]['model'],
  signal: AbortSignal,
): Promise<boolean[] | null> {
  if (claims.length === 0) return [];
  const evidenceCap = evidence.slice(0, 6000);
  const claimsBlock = claims.map((c, i) => `${i}. ${c}`).join('\n');

  try {
    const result = await streamText({
      model,
      system:
        'You are a groundedness checker. Return ONLY JSON: {"verdicts":[{"i":0,"ok":true}]}. ' +
        'ok=true only if the claim is explicitly supported by EVIDENCE. No guessing, no extra keys.',
      messages: [{
        role: 'user',
        content: `EVIDENCE:\n${evidenceCap}\n\nCLAIMS:\n${claimsBlock}`,
      }],
      temperature: 0,
      maxOutputTokens: 400,
      abortSignal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
    });
    const text = (await result.text).trim();
    return parseLlmVerdicts(text, claims.length);
  } catch (e) {
    logger.warn('agent', 'KB groundedness LLM verify failed', {}, e);
    return null;
  }
}

export type ApplyGroundednessOptions = {
  model?: Parameters<typeof streamText>[0]['model'];
  signal?: AbortSignal;
  /** Used for query-aware evidence packing. */
  goal?: string;
  /** Default true. Set LIA_KB_VERIFY_LLM=0 to disable LLM tier. */
  enableLlmVerify?: boolean;
};

/**
 * Full groundedness pipeline: lexical filter → optional LLM for uncertain claims.
 */
export async function applyGroundednessFilter(
  answer: GroundedKbAnswer,
  steps: AgentStepSlice[],
  opts: ApplyGroundednessOptions = {},
): Promise<{
  answer: GroundedKbAnswer;
  droppedCount: number;
  uncertainResolved: number;
  usedLlm: boolean;
}> {
  const evidence = buildKbEvidenceCorpus(steps, opts.goal ?? '');
  const lex = filterGroundedAnswerLexically(answer, evidence);

  const enableLlm =
    opts.enableLlmVerify ??
    (process.env.LIA_KB_VERIFY_LLM !== '0' && process.env.LIA_KB_VERIFY_LLM !== 'false');

  const uncertainClaims = [
    ...lex.uncertainFacts.map((f) => f.text),
    ...lex.uncertainSummaryParts,
  ];

  let usedLlm = false;
  let uncertainResolved = 0;
  const keptFacts = [...lex.kept.facts];
  let summary = lex.kept.summary;
  let missing = lex.kept.missing;
  let droppedCount = lex.droppedFacts.length + lex.droppedSummaryParts.length;

  if (enableLlm && uncertainClaims.length > 0 && opts.model && opts.signal) {
    usedLlm = true;
    const verdicts = await verifyUncertainClaimsWithLlm(
      uncertainClaims,
      evidence,
      opts.model,
      opts.signal,
    );
    if (verdicts) {
      let idx = 0;
      for (const fact of lex.uncertainFacts) {
        if (verdicts[idx++]) {
          keptFacts.push(fact);
          uncertainResolved += 1;
        } else {
          droppedCount += 1;
        }
      }
      const summaryKeep: string[] = summary ? [summary] : [];
      for (const part of lex.uncertainSummaryParts) {
        if (verdicts[idx++]) {
          summaryKeep.push(part);
          uncertainResolved += 1;
        } else {
          droppedCount += 1;
        }
      }
      summary = summaryKeep.filter(Boolean).join(' ');
    } else {
      // LLM failed — drop uncertain (fail-closed for hallucinations).
      droppedCount += uncertainClaims.length;
    }
  } else if (uncertainClaims.length > 0) {
    // No LLM: fail-closed on uncertain.
    droppedCount += uncertainClaims.length;
  }

  if (!summary && keptFacts.length > 0) {
    summary = keptFacts.slice(0, 2).map((f) => f.text).join(' ');
  }

  // Don't surface internal filter noise when we still have a usable answer.
  if (missing && /отфильтрован/i.test(missing) && (keptFacts.length > 0 || summary)) {
    const cleaned = missing
      .split(/;\s*/)
      .filter((p) => !/отфильтрован/i.test(p))
      .join('; ')
      .trim();
    missing = cleaned || null;
  } else if (droppedCount > 0 && !(keptFacts.length > 0 || summary) && !missing?.includes('неподтверждён')) {
    missing = 'часть утверждений отфильтрована как неподтверждённые источниками';
  }

  return {
    answer: { summary, facts: keptFacts, missing },
    droppedCount,
    uncertainResolved,
    usedLlm,
  };
}
