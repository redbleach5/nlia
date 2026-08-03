import { describe, expect, it } from 'vitest';
import { selectChunksByFocusQuery, extractFocusKeywords } from '@/lib/kb/chunk-focus';
import { packKbEvidenceForSynthesis } from '@/lib/agent/kb-evidence-pack';
import {
  isKbDetailLookupGoal,
  shouldFinalizeKbLookupAfterSteps,
} from '@/lib/agent/kb-step-utils';

describe('chunk-focus', () => {
  it('extracts UPPER_SNAKE and numbers from goal', () => {
    const keys = extractFocusKeywords('EGTS_SR_ADAS_DATA = 245 поля');
    expect(keys).toContain('egts_sr_adas_data');
    expect(keys).toContain('245');
  });

  it('selects ADAS chunks over unrelated head chunks', () => {
    const chunks = [
      { content: 'Введение в протокол EGTS и общие сведения', position: 0 },
      { content: 'EGTS_AUTH_SERVICE аутентификация', position: 1 },
      { content: 'Структура подзаписи EGTS_SR_ADAS_DATA код 245 Mobileye MOVON Таблица 49 LbusId', position: 40 },
      { content: 'EGTS_SR_ADAS_DATA dateTime UnixTime зоны A-F', position: 41 },
      { content: 'Оплата проезда EGTS_SR_PAY_COUNTERS', position: 50 },
    ];
    const { selected, mode } = selectChunksByFocusQuery(
      chunks,
      'EGTS_SR_ADAS_DATA = 245',
      { maxChunks: 4, neighborRadius: 0 },
    );
    expect(mode).toBe('focused');
    expect(selected.some((c) => c.content.includes('EGTS_SR_ADAS_DATA'))).toBe(true);
    expect(selected.every((c) => !c.content.includes('PAY_COUNTERS') || c.content.includes('ADAS'))).toBe(true);
  });
});

describe('kb detail finalize + evidence pack', () => {
  it('detail goals require get_source / read_folder_file', () => {
    expect(isKbDetailLookupGoal(
      'В базе знаний расскажи подробнее про EGTS_SR_ADAS_DATA = 245',
    )).toBe(true);

    const searchOnly = [{
      action: 'search_sources',
      observation: `{"chunks":[${JSON.stringify({ content: 'x'.repeat(700) })}]}`,
    }];
    expect(shouldFinalizeKbLookupAfterSteps(
      'В базе знаний подробно про EGTS_SR_ADAS_DATA = 245',
      searchOnly,
    )).toBe(false);

    const withGet = [{
      action: 'get_source',
      observation: `{"chunks":[{"content":"${'ADAS '.repeat(200)}"}],"mode":"focused"}`,
    }];
    expect(shouldFinalizeKbLookupAfterSteps(
      'В базе знаний подробно про EGTS_SR_ADAS_DATA = 245',
      withGet,
    )).toBe(true);
  });

  it('packs high-score chunks into synthesis evidence', () => {
    const packed = packKbEvidenceForSynthesis(
      'EGTS_SR_ADAS_DATA 245',
      [{
        action: 'search_sources',
        observation: JSON.stringify({
          chunks: [
            { content: 'Intro padding about trolley and auth service only', citation: 'intro' },
            {
              content: 'EGTS_SR_ADAS_DATA = 245 TELEDATA Mobileye MOVON LbusId dateTime Таблица 49',
              citation: 'ADAS',
            },
          ],
        }),
      }],
      2000,
    );
    expect(packed).toContain('EGTS_SR_ADAS_DATA');
    expect(packed).toContain('[ADAS]');
  });
});
