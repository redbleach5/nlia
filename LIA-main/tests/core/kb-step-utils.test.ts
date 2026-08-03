import { describe, expect, it } from 'vitest';
import {
  formatGroundedKbAnswer,
  hasSuccessfulKbMaterial,
  isCodeCreationGoal,
  isCodeExplorationGoal,
  isKbAssistedGoal,
  isKbLookupGoal,
  KB_LOOKUP_TOOL_WHITELIST,
  parseGroundedKbJson,
  resolveToolsWhitelistForGoal,
  shouldFinalizeKbLookupAfterSteps,
  stepHasKbReadableContent,
  stepsHaveCreationArtifacts,
} from '@/lib/agent/kb-step-utils';

describe('kb-step-utils', () => {
  it('detects code creation goals', () => {
    expect(isCodeCreationGoal('Напиши игру тетрис в неоновом стиле')).toBe(true);
    expect(isCodeCreationGoal('Создай сайт-лендинг на HTML')).toBe(true);
    expect(isCodeCreationGoal('Изучи проект и найди проблемы')).toBe(false);
    expect(isCodeCreationGoal('какие новости сегодня')).toBe(false);
  });

  it('detects creation artifacts in steps', () => {
    expect(stepsHaveCreationArtifacts([{ action: 'reason', observation: 'код' }])).toBe(false);
    expect(stepsHaveCreationArtifacts([
      { action: 'write_file', observation: '{"ok":true,"path":"a.html"}' },
    ])).toBe(true);
  });

  it('detects pure KB lookup goals', () => {
    expect(isKbLookupGoal('Найди описание протокола EGTS в базе знаний')).toBe(true);
    expect(isKbLookupGoal('Что такое EGTS_SR_ADAS_DATA в базе знаний?')).toBe(true);
    expect(isKbLookupGoal('Напиши функцию sort')).toBe(false);
  });

  it('does not treat mere KB mention / exploration as lookup-only', () => {
    expect(isKbLookupGoal('У тебя есть этот проект в базе знаний')).toBe(false);
    expect(isCodeExplorationGoal('У тебя есть этот проект в базе знаний')).toBe(true);
    expect(isKbAssistedGoal('У тебя есть этот проект в базе знаний')).toBe(true);

    expect(isKbLookupGoal('изучить кодовую базу проекта Lia-v2-public и обнаружить проблемы')).toBe(false);
    expect(isCodeExplorationGoal('изучить кодовую базу проекта Lia-v2-public и обнаружить проблемы')).toBe(true);

    expect(isKbLookupGoal('Изучи проект Lia-v2-public, какие в нем основные проблемы')).toBe(false);
    expect(isCodeExplorationGoal('Изучи проект Lia-v2-public, какие в нем основные проблемы')).toBe(true);

    expect(isKbLookupGoal('проект в базе знаний — найди ошибки')).toBe(false);
    expect(isKbAssistedGoal('проект в базе знаний — найди ошибки')).toBe(true);
  });

  it('forces KB tool whitelist only for pure lookup (overrides template)', () => {
    const researcherWeb = ['web_search', 'fetch_page', 'search_codebase'];
    expect(resolveToolsWhitelistForGoal(
      'Найди описание протокола EGTS в базе знаний',
      null,
      researcherWeb,
    )).toEqual([...KB_LOOKUP_TOOL_WHITELIST]);
  });

  it('keeps open tools for code exploration even if KB is mentioned', () => {
    expect(resolveToolsWhitelistForGoal(
      'У тебя есть этот проект в базе знаний',
      null,
      null,
    )).toBeNull();
    expect(resolveToolsWhitelistForGoal(
      'изучи проект и найди проблемы',
      null,
      ['web_search', 'search_codebase'],
    )).toEqual(['web_search', 'search_codebase']);
  });

  it('keeps explicit caller whitelist', () => {
    expect(resolveToolsWhitelistForGoal(
      'Найди в базе знаний EGTS',
      ['search_sources', 'ask_user'],
      ['web_search'],
    )).toEqual(['search_sources', 'ask_user']);
  });

  it('keeps template whitelist for non-KB goals', () => {
    expect(resolveToolsWhitelistForGoal(
      'Найди свежие RFC по HTTP/3 в интернете',
      null,
      ['web_search', 'fetch_page'],
    )).toEqual(['web_search', 'fetch_page']);
  });

  it('detects read_folder_file content', () => {
    expect(stepHasKbReadableContent({
      action: 'search_sources + read_folder_file',
      observation: '{"content":"ОПИСАНИЕ протокола EGTS","truncated":true}',
    })).toBe(true);
  });

  it('does not finalize after a single thin search for lookup goal', () => {
    const thinSearch = [{
      action: 'search_sources',
      observation: `{"chunks":[${'"x"'.repeat(50)}],"content":"${'y'.repeat(700)}"}`,
    }];
    // Make a real long observation that passes stepHasKbReadableContent
    const oneHit = [{
      action: 'search_sources',
      observation: `{"chunks":[${JSON.stringify({ content: 'x'.repeat(700) })}]}`,
    }];
    expect(hasSuccessfulKbMaterial(oneHit)).toBe(true);
    expect(shouldFinalizeKbLookupAfterSteps(
      'Найди описание протокола EGTS в базе знаний',
      oneHit,
    )).toBe(false);

    const twoHits = [
      ...oneHit,
      {
        action: 'get_source',
        observation: `{"chunks":[${JSON.stringify({ content: 'z'.repeat(200) })}]}`,
      },
    ];
    expect(shouldFinalizeKbLookupAfterSteps(
      'Найди описание протокола EGTS в базе знаний',
      twoHits,
    )).toBe(true);

    // exploration never early-finalizes via KB path
    expect(shouldFinalizeKbLookupAfterSteps(
      'изучи проект в базе знаний и найди проблемы',
      twoHits,
    )).toBe(false);

    void thinSearch;
  });

  it('finalize after deep folder read for lookup goal', () => {
    const steps = [{
      action: 'search_sources + read_folder_file',
      observation: `{"content":"${'x'.repeat(400)}"}`,
    }];
    expect(hasSuccessfulKbMaterial(steps)).toBe(true);
    expect(shouldFinalizeKbLookupAfterSteps(
      'Привет. Найди описание протокола EGTS в базе знаний',
      steps,
    )).toBe(true);
  });

  it('parses and formats grounded KB JSON', () => {
    const raw = `{
      "summary": "EGTS_SR_ADAS_DATA передаёт события ADAS.",
      "facts": [
        {"text": "Подзапись сервиса TELEDATA", "citation": "Таблица 49"},
        {"text": "Поле dateTime — UnixTime", "citation": null}
      ],
      "missing": null
    }`;
    const parsed = parseGroundedKbJson(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.facts).toHaveLength(2);
    const md = formatGroundedKbAnswer(parsed!);
    expect(md).toContain('EGTS_SR_ADAS_DATA');
    expect(md).toContain('[Таблица 49]');
    expect(md).toContain('dateTime');
  });

  it('parses grounded JSON with extra braces (model glitch)', () => {
    const raw = '{"summary":"ok","facts":[{"text":"EGTS_SR_ADAS_DATA","citation":"src (ADAS)"}},{"text":"Mobileye","citation":null}],"missing":null}';
    const parsed = parseGroundedKbJson(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.facts.map((f) => f.text)).toEqual(['EGTS_SR_ADAS_DATA', 'Mobileye']);
  });
});
