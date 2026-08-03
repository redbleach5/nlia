import { describe, expect, it } from 'vitest';
import {
  classifyClaimLexically,
  extractGlossaryExpansions,
  filterGroundedAnswerLexically,
  hasUngroundedGlossaryExpansion,
  scoreClaimAgainstEvidence,
} from '@/lib/agent/kb-groundedness';

const EVIDENCE = `
Структура подзаписи EGTS_SR_ADAS_DATA сервиса EGTS_TELEDATA_SERVICE,
содержащего данные о событиях, зафиксированных устройствами Mobileye или MOVON,
а также CAN-сигналах. Таблица 49. Поле dateTime UINT UnixTime.
`.toLowerCase();

describe('kb-groundedness lexical tier', () => {
  it('scores high when distinctive tokens overlap evidence', () => {
    const score = scoreClaimAgainstEvidence(
      'EGTS_SR_ADAS_DATA — подзапись EGTS_TELEDATA_SERVICE (Таблица 49)',
      EVIDENCE,
    );
    expect(score).toBeGreaterThanOrEqual(0.5);
  });

  it('detects ungrounded Latin glossary expansions', () => {
    const claim = 'EGTS (European Trolleybus System) используется для обмена данными';
    expect(extractGlossaryExpansions(claim).some((e) => /European/i.test(e))).toBe(true);
    expect(hasUngroundedGlossaryExpansion(claim, EVIDENCE)).toBe(true);
    expect(classifyClaimLexically(claim, EVIDENCE).verdict).toBe('unsupported');
  });

  it('allows grounded technical claims', () => {
    expect(classifyClaimLexically(
      'Подзапись EGTS_SR_ADAS_DATA передаёт события Mobileye/MOVON',
      EVIDENCE,
    ).verdict).toBe('supported');
  });

  it('filters grounded answer: drops hallucination, keeps ADAS fact', () => {
    const filtered = filterGroundedAnswerLexically(
      {
        summary: 'EGTS (European Trolleybus System) — протокол. EGTS_SR_ADAS_DATA описан в таблице 49.',
        facts: [
          { text: 'EGTS означает European Trolleybus System', citation: null },
          { text: 'EGTS_SR_ADAS_DATA относится к EGTS_TELEDATA_SERVICE', citation: 'Таблица 49' },
        ],
        missing: null,
      },
      EVIDENCE,
    );
    expect(filtered.droppedFacts.some((f) => /European/i.test(f.text))).toBe(true);
    expect(filtered.kept.facts.some((f) => /EGTS_SR_ADAS_DATA/.test(f.text))).toBe(true);
    expect(filtered.droppedSummaryParts.some((p) => /European/i.test(p))).toBe(true);
  });
});
