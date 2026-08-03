// Type declarations for snowball-stemmers (no @types package exists).
// API: https://github.com/mazko/jssnowball

declare module 'snowball-stemmers' {
  export interface Stemmer {
    stem(word: string): string;
  }

  export function newStemmer(algorithm: string): Stemmer;

  export function algorithms(): string[];

  const _default: {
    newStemmer: typeof newStemmer;
    algorithms: typeof algorithms;
  };
  export default _default;
}
