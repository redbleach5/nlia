/**
 * Task complexity classifier.
 * Ported from v2 src/lib/task-complexity.ts. Per § Appendix A: "port".
 *
 * Used by chat pipeline (§ 9.1) and inner monologue gate.
 * Classifies user message as: trivial | simple | complex | research
 */

export type TaskComplexity = "trivial" | "simple" | "complex" | "research";

const TRIVIAL_PATTERNS = [
  /^(привет|hi|hello|hey|здравствуй|доброе утро|добрый день|добрый вечер)\??\.?$/i,
  /^(как дела|что делаешь|как ты|чем занята)\??\.?$/i,
  /^(спасибо|благодарю|ок|окей|хорошо|понятно|ясно)\.?$/i,
  /^(пока|до свидания|bye|удачи)\.?$/i,
];

const RESEARCH_PATTERNS = [
  /исследуй|проанализируй|сравни|найди.*статьи|обзор|литература/i,
  /что нового|последние.*исследования|актуальные данные|статистика/i,
  /объясни.*подробно|расскажи.*всё|глубокий анализ/i,
];

const COMPLEX_PATTERNS = [
  /напиши.*код|создай.*функцию|реализуй|отрефактори/i,
  /найди.*баг|почему.*не работает|исправь.*ошибку|debug/i,
  /создай.*проект|настрой|установи|разверни/i,
  /пошагово|инструкция|гайд|туториал/i,
];

export function classifyTaskComplexity(text: string): TaskComplexity {
  const trimmed = text.trim();

  // Trivial: greetings, acknowledgements, farewells
  if (TRIVIAL_PATTERNS.some((re) => re.test(trimmed))) {
    return "trivial";
  }

  // Research: explicit analysis/review/exploration requests
  if (RESEARCH_PATTERNS.some((re) => re.test(trimmed))) {
    return "research";
  }

  // Complex: coding, debugging, multi-step instructions
  if (COMPLEX_PATTERNS.some((re) => re.test(trimmed))) {
    return "complex";
  }

  // Heuristic: long messages are likely complex
  if (trimmed.length > 500) {
    return "complex";
  }

  // Default: simple
  return "simple";
}
