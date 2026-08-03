/**
 * Structured emotional recall signals for prompt injection.
 * Facts only — no soft-tone scripts («будь мягче»).
 */

export type PainfulAnchorSignal = {
  kind: 'painful_anchor';
  emotion: string;
  intensity: number;
  currentToneNeutral: true;
};

/** Factual prompt line for painfulAnchor — tone comes from character + monologue. */
export function formatPainfulAnchorForPrompt(signal: PainfulAnchorSignal): string {
  return (
    `painful_anchor: emotion=${signal.emotion}; `
    + `intensity=${signal.intensity.toFixed(2)}; `
    + `currentToneNeutral=true`
  );
}
