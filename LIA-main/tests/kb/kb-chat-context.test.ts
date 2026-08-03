import { describe, expect, it } from 'vitest';
import {
  shouldPreSearchKbForChat,
  buildKbSearchQuery,
  kbSnippetMatchesUserQuery,
  extractUserSpecificTerms,
  filterHitsForUserTerms,
  prioritizeHitsByThreadSource,
} from '@/lib/kb/kb-chat-context';
import { isKbQuestion } from '@/lib/task-complexity';
import { kbHitsReadyForAnswer } from '@/lib/kb/kb-query-filter';
import type { SearchResult } from '@/lib/kb/types';

describe('kb-chat-context', () => {
  const egtsThread = [
    { role: 'user', content: 'найди информацию по EGTS_SR_ADAS_DATA' },
    { role: 'companion', content: 'Информация в документе Описание протокола EGTS 05_03_2026.docx' },
  ];

  const genericThread = [
    { role: 'user', content: 'найди в базе информацию по API_RATE_LIMIT' },
    { role: 'companion', content: 'См. документ api-reference.pdf, раздел лимитов.' },
  ];

  const noisyThread = [
    { role: 'user', content: 'найди по EGTS_SR_ADAS_DATA' },
    {
      role: 'companion',
      content: 'EGTS_SR_ADAS_DATA содержит данные о CAN-сигналах от транспортного средства',
    },
  ];

  it('triggers KB search for movon follow-up in EGTS thread', () => {
    expect(shouldPreSearchKbForChat(
      'туда входят события от movon?',
      egtsThread,
      isKbQuestion,
    )).toBe(true);
  });

  it('triggers KB search for camelCase term', () => {
    expect(shouldPreSearchKbForChat(
      'там есть eventDriver?',
      egtsThread,
      isKbQuestion,
    )).toBe(true);
  });

  it('triggers KB search for generic follow-up in any KB thread', () => {
    expect(shouldPreSearchKbForChat(
      'а какой там лимит по умолчанию?',
      genericThread,
      isKbQuestion,
    )).toBe(true);
  });

  it('does not trigger KB search without thread context', () => {
    expect(shouldPreSearchKbForChat(
      'а какой там лимит?',
      [],
      isKbQuestion,
    )).toBe(false);
  });

  it('does not trigger on ALL-CAPS identifier alone without KB thread', () => {
    expect(shouldPreSearchKbForChat(
      'EGTS_SR_ADAS_DATA',
      [],
      isKbQuestion,
    )).toBe(false);
  });

  it('triggers on explicit KB question stems', () => {
    expect(shouldPreSearchKbForChat(
      'найди в базе про лимиты API',
      [],
      isKbQuestion,
    )).toBe(true);
  });

  it('does not treat generic stack/architecture as KB question', () => {
    expect(isKbQuestion('какой стек у проекта?')).toBe(false);
    expect(isKbQuestion('расскажи про архитектуру')).toBe(false);
  });

  it('buildKbSearchQuery carries identifiers from user thread only', () => {
    const q = buildKbSearchQuery('в 245 подзаписи есть movon?', egtsThread);
    expect(q).toContain('egts_sr_adas_data');
    expect(q).toContain('movon');
    expect(q).toContain('05_03_2026.docx');
  });

  it('does not pollute query with companion paraphrase', () => {
    const q = buildKbSearchQuery('там есть eventDriver?', noisyThread);
    expect(q).toContain('egts_sr_adas_data');
    expect(q).toContain('eventdriver');
    expect(q).not.toMatch(/\bcan\b/);
    expect(q).not.toContain('содержит');
  });

  it('does not pollute query with companion folder listing backticks', () => {
    const folderThread = [
      { role: 'user', content: 'что в папке HDB?' },
      {
        role: 'companion',
        content: 'Файлы: `00123.txt` `1.jpg` `apc_mocker_scenario.json` и протокол EGTS 05_03_2026.docx',
      },
    ];
    const q = buildKbSearchQuery('Помнишь как меня зовут?', folderThread);
    expect(q).not.toContain('00123.txt');
    expect(q).not.toContain('1.jpg');
    expect(q).not.toContain('apc_mocker_scenario.json');
    expect(q).toContain('05_03_2026.docx');
  });

  it('does not trigger KB search for personal smalltalk after folder listing', () => {
    const folderThread = [
      { role: 'user', content: 'что в папке HDB?' },
      {
        role: 'companion',
        content: 'Файлы: `00123.txt` `1.jpg` и Описание протокола EGTS 05_03_2026.docx',
      },
    ];
    expect(shouldPreSearchKbForChat('Помнишь как меня зовут?', folderThread, isKbQuestion)).toBe(false);
    expect(shouldPreSearchKbForChat('А что так грубо?', folderThread, isKbQuestion)).toBe(false);
  });

  it('extracts camelCase user terms', () => {
    expect(extractUserSpecificTerms('там есть eventDriver?')).toContain('eventdriver');
  });

  it('extracts Cyrillic acronym, drops conversational «интересует»', () => {
    const terms = extractUserSpecificTerms('интересует СМСВ');
    expect(terms).toContain('смсв');
    expect(terms).not.toContain('интересует');
  });

  it('filterHitsForUserTerms keeps hit with СМСВ', () => {
    const hits: SearchResult[] = [{
      id: '1', sourceId: 's1', content: 'описание поля СМСВ в протоколе',
      metadata: {}, score: 0.9, matchType: 'bm25', citation: 'EGTS',
      sourceName: 'EGTS', sourceType: 'document',
    }];
    expect(filterHitsForUserTerms(hits, 'интересует СМСВ')).toHaveLength(1);
  });

  it('filterHitsForUserTerms does not require «интересует» in chunk', () => {
    const hits: SearchResult[] = [{
      id: '1', sourceId: 's1', content: 'только смсв без разговорных слов',
      metadata: {}, score: 0.9, matchType: 'bm25', citation: 'EGTS',
      sourceName: 'EGTS', sourceType: 'document',
    }];
    expect(filterHitsForUserTerms(hits, 'интересует СМСВ')).toHaveLength(1);
  });

  it('kbSnippetMatchesUserQuery finds term in snippet', () => {
    const snippet = 'устройствами Mobileye или MOVON, таблице 49';
    expect(kbSnippetMatchesUserQuery('есть movon?', snippet)).toBe(true);
  });

  it('kbSnippetMatchesUserQuery accepts wrong table number when term matches', () => {
    const snippet = 'подзаписи EGTS_SR_ADAS_DATA ... Mobileye или MOVON ... таблице 49';
    expect(kbSnippetMatchesUserQuery('в 245 подзаписи есть movon?', snippet, ['egts_sr_adas_data'])).toBe(true);
  });

  it('prioritizes thread source over unrelated hits', () => {
    const hits: SearchResult[] = [
      {
        id: '1', sourceId: 's1', content: 'readme bug report',
        metadata: {}, score: 0.9, matchType: 'bm25', citation: 'Lia README > bug',
        sourceName: 'Lia README', sourceType: 'document',
      },
      {
        id: '2', sourceId: 's2', content: 'EGTS protocol body',
        metadata: { relativePath: 'Описание протокола EGTS 05_03_2026.docx' },
        score: 0.5, matchType: 'folder_probe',
        citation: 'Downloads > Описание протокола EGTS 05_03_2026.docx',
        sourceName: 'Downloads', sourceType: 'folder',
      },
    ];
    const sorted = prioritizeHitsByThreadSource(hits, ['Описание протокола EGTS 05_03_2026.docx']);
    expect(sorted[0].citation).toContain('EGTS');
  });

  it('filterHitsForUserTerms drops hits without the term', () => {
    const hits: SearchResult[] = [{
      id: '1', sourceId: 's1', content: 'readme only',
      metadata: {}, score: 0.9, matchType: 'bm25', citation: 'README',
      sourceName: 'README', sourceType: 'document',
    }];
    expect(filterHitsForUserTerms(hits, 'там есть eventDriver?')).toHaveLength(0);
  });
});

describe('kbHitsReadyForAnswer', () => {
  it('does not lock when folder_probe lacks user term', () => {
    const hits = [{
      content: 'EGTS_SR_ADAS_DATA general description without the field',
      matchType: 'folder_probe' as const,
    }];
    const ready = kbHitsReadyForAnswer(
      'там есть eventDriver?',
      hits,
      (msg, snippet, ids) => kbSnippetMatchesUserQuery(msg, snippet, ids),
      ['egts_sr_adas_data'],
      'там есть eventDriver? egts_sr_adas_data',
    );
    expect(ready).toBe(false);
  });

  it('locks when user term is in snippet', () => {
    const hits = [{
      content: 'struct eventDriver { int code; }',
      matchType: 'folder_probe' as const,
    }];
    expect(kbHitsReadyForAnswer(
      'там есть eventDriver?',
      hits,
      (msg, snippet, ids) => kbSnippetMatchesUserQuery(msg, snippet, ids),
      ['egts_sr_adas_data'],
      'там есть eventDriver?',
    )).toBe(true);
  });
});
