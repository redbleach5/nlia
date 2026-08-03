// Heuristics for greeting / acquaintance — shared by pipeline and tests.
//
// Pure-social gate: partial matches («привет» / «как ты» inside a longer ask)
// must NOT flip trivial flags. Only messages that are entirely social after
// stripping the social shell may take the short greeting / how-are-you path.

export type TrivialMessageFlags = {
  isTrivialGreeting: boolean;
  isTrivialHowAreYou: boolean;
  isAcquaintanceRequest: boolean;
};

const GREETING_RE =
  /(?<![\p{L}\p{N}])(привет|здравствуй|hi|hello|hey|ку|даров|доброе утро|добрый вечер|добрый день)(?![\p{L}\p{N}])/iu;

const HOW_ARE_YOU_RE =
  /(?<![\p{L}\p{N}])(как дела|как ты|что делаешь|как настроение|чем занимаешься)(?![\p{L}\p{N}])/iu;

/** Tokens removed when checking whether anything non-social remains. */
const SOCIAL_SHELL_RE =
  /(?<![\p{L}\p{N}])(?:привет(?:ик)?|здравствуй(?:те)?|хай|hi|hello|hey|ку|даров|доброе утро|добрый вечер|добрый день|пока|до свидания|bye|goodbye|увидимся|спасибо|благодарю|thanks|thank you|спс|ок|окей|хорошо|ладно|да|нет|угу|ага|как дела|как ты|что делаешь|как настроение|чем занимаешься)(?![\p{L}\p{N}])/giu;

const PUNCT_EMOJI_WS_RE =
  /[\s.,!?;:…—–\-'"«»()[\]{}]+|\p{Extended_Pictographic}|\uFE0F|\u200D/gu;

/** «Давай знакомиться», «кто ты», представиться — soft signal for monologue / hints. */
const ACQUAINTANCE_RE =
  /(?<![\p{L}\p{N}])(?:знаком\p{L}*|представ\p{L}*|кто\s+ты|расскажи\s+(?:немного\s+)?о\s+себе|как\s+(?:тебя|меня)\s+зовут|who are you|what'?s your name)/iu;

/**
 * Strip greeting / how-are-you / thanks / ack tokens plus punctuation & emoji.
 * What remains is the substantive residual (if any).
 */
export function stripSocialShell(text: string): string {
  return text
    .replace(SOCIAL_SHELL_RE, ' ')
    .replace(PUNCT_EMOJI_WS_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Residual letters/digits after social-shell strip (for tests / logs). */
export function residualAfterSocialShell(text: string): string {
  return stripSocialShell(text);
}

/** True when the message is only greeting / how-are-you / thanks / ack. */
export function isPureSocialMessage(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  return residualAfterSocialShell(trimmed).length === 0;
}

export function detectAcquaintanceRequest(text: string): boolean {
  return ACQUAINTANCE_RE.test(text.toLowerCase().trim());
}

export function detectTrivialMessageFlags(text: string): TrivialMessageFlags {
  const textLower = text.toLowerCase().trim();
  const isAcquaintanceRequest = detectAcquaintanceRequest(text);
  const pure = isPureSocialMessage(text);

  // Trivial greeting / how-are-you only when NOTHING non-social remains.
  const isTrivialGreeting = pure && GREETING_RE.test(textLower);
  const isTrivialHowAreYou = pure && HOW_ARE_YOU_RE.test(textLower);

  return { isTrivialGreeting, isTrivialHowAreYou, isAcquaintanceRequest };
}

const GREETING_IN_HISTORY_RE =
  /(?<![\p{L}\p{N}])(?:привет|здравствуй|hi|hello|доброе утро|добрый день|добрый вечер)(?![\p{L}\p{N}])/iu;

/** True if chat already had a greeting (user or Lia) — avoid hello loops. */
export function episodeHasPriorGreeting(
  messages: Array<{ role: string; content: string }>,
): boolean {
  return messages.some(m =>
    (m.role === 'user' || m.role === 'companion')
    && GREETING_IN_HISTORY_RE.test(m.content),
  );
}

export function countUserTurnsInEpisode(
  messages: Array<{ role: string }>,
  includeCurrentTurn = true,
): number {
  const fromHistory = messages.filter(m => m.role === 'user').length;
  return fromHistory + (includeCurrentTurn ? 1 : 0);
}

/**
 * Acquaintance / greeting hints for the system prompt.
 *
 * `recentMessages` may be a truncated window (last N). For long episodes we
 * also use `storedMessageCountBeforeTurn` so we don't treat turn 150 as "first hello".
 */
export function resolveAcquaintanceContext(params: {
  recentMessages: Array<{ role: string; content: string }>;
  /** Message rows already in DB before the current user turn was saved. */
  storedMessageCountBeforeTurn: number;
}): {
  episodeUserTurnCount: number;
  episodeHasPriorGreeting: boolean;
} {
  const { recentMessages, storedMessageCountBeforeTurn } = params;

  const fromWindow = countUserTurnsInEpisode(recentMessages, true);
  // Lower bound when the fetch window is shorter than the episode.
  const fromTotal = storedMessageCountBeforeTurn === 0
    ? 1
    : Math.ceil((storedMessageCountBeforeTurn + 1) / 2);

  return {
    episodeUserTurnCount: Math.max(fromWindow, fromTotal),
    episodeHasPriorGreeting:
      episodeHasPriorGreeting(recentMessages)
      || storedMessageCountBeforeTurn >= 2,
  };
}
