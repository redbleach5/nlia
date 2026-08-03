import { describe, expect, it } from 'vitest';
import { normalizeFactStorageKey } from '@/lib/memory/fact-extraction';
import { getUserNameFromFacts, USER_NAME_FACT_KEY } from '@/lib/memory/facts';

describe('normalizeFactStorageKey', () => {
  it('adds user. prefix to bare keys', () => {
    expect(normalizeFactStorageKey('name', 'user')).toBe('user.name');
    expect(normalizeFactStorageKey('profession', 'user')).toBe('user.profession');
  });

  it('strips duplicate user. / current. prefixes from LLM output', () => {
    expect(normalizeFactStorageKey('user.name', 'user')).toBe('user.name');
    expect(normalizeFactStorageKey('user.user.name', 'user')).toBe('user.name');
    expect(normalizeFactStorageKey('current.project', 'current')).toBe('current.project');
    expect(normalizeFactStorageKey('current.current.topic', 'current')).toBe('current.topic');
  });

  it('rejects empty keys', () => {
    expect(normalizeFactStorageKey('', 'user')).toBeNull();
    expect(normalizeFactStorageKey('user.', 'user')).toBeNull();
  });
});

describe('getUserNameFromFacts', () => {
  it('reads canonical user.name', () => {
    expect(getUserNameFromFacts([{ key: USER_NAME_FACT_KEY, value: 'Руслан' }])).toBe('Руслан');
  });

  it('falls back to legacy double-prefix key', () => {
    expect(getUserNameFromFacts([{ key: 'user.user.name', value: 'Иван' }])).toBe('Иван');
  });
});
