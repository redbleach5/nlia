/**
 * Shared anti-fabrication fragments for prompts.
 *
 * Keep wording short and factual. Domain modules may append local constraints
 * (citations, tools, JSON shape) — do not grow this into a prompt CMS.
 */

export const GROUNDING = {
  /** Generic: do not invent facts. */
  noFabricateFacts: 'Не выдумывай факты.',
  /** KB / document excerpts: only what is in the provided text. */
  noFabricateFromText:
    'Не выдумывай факты, цифры, версии, цитаты — только то, что есть в тексте.',
  /** Empty KB / not-found path. */
  noFabricateDocContent: 'Не выдумывай содержимое документов.',
  /** Agent synthesize from tool steps. */
  noFabricateFromSteps: 'Не выдумывай то, чего нет в шагах.',
  /** Prefer only facts from the KB block below. */
  kbFactsOnly: 'Используй только факты из фрагментов ниже.',
} as const;
