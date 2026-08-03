/**
 * Grounding — anti-hallucination constraints for system prompt.
 * Ported from v2 src/lib/prompts/grounding.ts. Per § Appendix A: "port".
 */
export const GROUNDING = {
  noFabricateFromText: `Не выдумывай факты, которых нет в предоставленном тексте. Если информация в тексте отсутствует — скажи «не нашла в источнике».`,
  noFabricateFromFacts: `Не выдумывай факты о пользователе. Если чего-то не знаешь — скажи «не знаю» или задай вопрос.`,
  noFabricateFromKb: `Если в результатах поиска KB нет релевантной информации — скажи «не нашла в базе знаний». Не додумывай.`,
  citeSources: `Если используешь информацию из KB — указывай источник: [название > раздел](#source:SOURCE_ID).`,
  noConfabulation: `Не путай эпизоды. Если не уверена, что это было в этом чате — скажи «не помню, было ли это здесь».`,
} as const;
