// Dialogue turn contract — episode dialogue state for the chat system prompt.
// Derived each turn from history + heuristics (no EpisodeFact persistence).
// Soft style stays in STATIC_CORE; greeting / self-intro invariants live here.

import type { TrivialMessageFlags } from '@/lib/chat/message-heuristics';

export type DialogueTurnKind = 'greeting' | 'acquaintance' | 'social' | 'other';

export type DialogueTurnContract = {
  phase: 'opening' | 'ongoing';
  /** True only on the first turn of a chat with no prior greeting. */
  mayGreet: boolean;
  turnKind: DialogueTurnKind;
  userNameKnown: boolean;
  /** User asked who you are / to introduce yourself. */
  selfIntroRequired: boolean;
  /** First pure hello + name unknown (0 people) → short hello + ask name. */
  askUserName: boolean;
  /** Unbound episode with ≥2 known people — ask who is speaking. */
  needIdentifySpeaker: boolean;
  /** Display names of known people (for identify prompt). */
  knownPeopleNames: string[];
};

export type DeriveDialogueTurnContractInput = {
  isTrivialGreeting?: boolean;
  isTrivialHowAreYou?: boolean;
  isAcquaintanceRequest?: boolean;
  userNameKnown?: boolean;
  /** User turns in episode including current. */
  episodeUserTurnCount?: number;
  episodeHasPriorGreeting?: boolean;
  /** Unbound + ≥2 people. */
  needIdentifySpeaker?: boolean;
  knownPeopleNames?: string[];
};

export function deriveDialogueTurnContract(
  params: DeriveDialogueTurnContractInput,
): DialogueTurnContract {
  const userNameKnown = !!params.userNameKnown;
  const turnCount = params.episodeUserTurnCount ?? 1;
  const priorGreeting = !!params.episodeHasPriorGreeting;
  const phase: 'opening' | 'ongoing' =
    priorGreeting || turnCount > 1 ? 'ongoing' : 'opening';
  const mayGreet = phase === 'opening' && !priorGreeting;

  let turnKind: DialogueTurnKind = 'other';
  if (params.isAcquaintanceRequest) turnKind = 'acquaintance';
  else if (params.isTrivialGreeting) turnKind = 'greeting';
  else if (params.isTrivialHowAreYou) turnKind = 'social';

  const selfIntroRequired = turnKind === 'acquaintance';
  const needIdentifySpeaker = !!params.needIdentifySpeaker && !userNameKnown;
  const knownPeopleNames = (params.knownPeopleNames ?? [])
    .map((n) => n.trim())
    .filter(Boolean)
    .slice(0, 3);

  // Ask name only when no people exist yet — not when multi unbound (use identify).
  const askUserName =
    !needIdentifySpeaker
    && mayGreet
    && turnKind === 'greeting'
    && !userNameKnown
    && turnCount === 1
    && !priorGreeting;

  return {
    phase,
    mayGreet,
    turnKind,
    userNameKnown,
    selfIntroRequired,
    askUserName,
    needIdentifySpeaker,
    knownPeopleNames,
  };
}

/** Convenience: flags bag from detectTrivialMessageFlags. */
export function deriveDialogueTurnContractFromFlags(
  flags: TrivialMessageFlags,
  rest: Omit<
    DeriveDialogueTurnContractInput,
    'isTrivialGreeting' | 'isTrivialHowAreYou' | 'isAcquaintanceRequest'
  >,
): DialogueTurnContract {
  return deriveDialogueTurnContract({
    ...rest,
    isTrivialGreeting: flags.isTrivialGreeting,
    isTrivialHowAreYou: flags.isTrivialHowAreYou,
    isAcquaintanceRequest: flags.isAcquaintanceRequest,
  });
}

/**
 * Single volatile state block for the system prompt.
 * One place for mayGreet / self-intro / speaker identify — no duplicate hello nags.
 */
export function formatDialogueTurnContract(c: DialogueTurnContract): string {
  const lines: string[] = [
    'СОСТОЯНИЕ ДИАЛОГА (факт, не стиль):',
    `phase=${c.phase}; mayGreet=${c.mayGreet}`,
  ];

  if (c.selfIntroRequired) {
    lines.push(
      'Имя: Лия. На «кто ты / представься» — скажи «я Лия» (живо, кратко). '
        + 'Не произноси «ИИ-собеседница», «приложение Lia», «человек-модель». '
        + 'Если прямо спросят «ты ИИ?» — честно да, без продуктового жаргона.',
    );
  } else {
    lines.push('Имя: Лия.');
  }

  if (c.needIdentifySpeaker && c.knownPeopleNames.length >= 2) {
    const names = c.knownPeopleNames.join(', ');
    lines.push(
      `Собеседник в этом чате ещё не определён. Известные люди: ${names}. `
        + 'Задай один короткий вопрос — кто сейчас пишет (по имени). '
        + 'Не выдумывай нового человека сверх известных; не подставляй чужой профиль.',
    );
  } else if (c.askUserName) {
    lines.push(
      'Сейчас первое сообщение и имя собеседника неизвестно: коротко поздоровайся (1–2 предложения) '
        + 'и задай один вопрос — как зовут. Без списка инструментов и возможностей.',
    );
  } else if (c.mayGreet && (c.turnKind === 'greeting' || c.turnKind === 'social')) {
    lines.push(
      'Короткая реплика (привет / как дела): ответь тепло и очень кратко, без перечисления умений.',
    );
  } else if (c.mayGreet) {
    lines.push('Можно одно короткое приветствие, если уместно; затем сразу по сути.');
  } else {
    lines.push('Открывай реплику по сути, без приветствия.');
  }

  if (
    !c.askUserName
    && !c.needIdentifySpeaker
    && !c.selfIntroRequired
    && c.turnKind === 'other'
  ) {
    lines.push(
      'Сначала ответь на сообщение пользователя по существу. '
        + 'Имя или самопрезентацию — только если уместно и не вместо ответа.',
    );
  }

  return `\n${lines.join('\n')}`;
}
