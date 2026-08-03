import 'server-only';

// Fact extraction — извлечение фактов из диалога через LLM.
//
// Вызывается после каждого ответа Лии (в onFinish callback chat route).
// Глобальные факты о человеке → Person + PersonFact (привязка эпизода).
// Эпизодные факты (current.*) — EpisodeFact.

import { streamText } from 'ai';
import { getChatModel } from '@/lib/ollama';
import { upsertEpisodeFact } from './facts';
import { remember } from './vector';
import { GROUNDING } from '@/lib/prompts/grounding';
import { logger } from '@/lib/logger';
import { getEpisodePersonId, bindEpisodePerson } from './person-binding';
import {
  createPerson,
  countPeople,
  extractClaimedNameFromUtterance,
  listPeople,
  MAX_PEOPLE,
  renamePersonDisplayName,
  resolvePersonFromUtterance,
  upsertPersonFact,
} from './people';

const FACT_TRIGGER_PATTERNS = [
  /(?<![\p{L}\p{N}])(меня зовут|моё имя|я [\wа-яё]+,? а ты|зови меня)(?![\p{L}\p{N}])/iu,
  /(?<![\p{L}\p{N}])(я работаю|я учусь|моя профессия|по профессии)(?![\p{L}\p{N}])/iu,
  /(?<![\p{L}\p{N}])(мне \d+ лет|мне исполнилось)(?![\p{L}\p{N}])/iu,
  /(?<![\p{L}\p{N}])(мой проект|я делаю|я пишу|я разрабатываю|мы работаем над)(?![\p{L}\p{N}])/iu,
  /(?<![\p{L}\p{N}])(использую|пишу на|язык программирования|фреймворк)(?![\p{L}\p{N}])/iu,
  /(?<![\p{L}\p{N}])(мне нравится|я люблю|не люблю|предпочитаю|мой любимый)(?![\p{L}\p{N}])/iu,
  /(?<![\p{L}\p{N}])(моя цель|я хочу сделать|планирую|задача —)(?![\p{L}\p{N}])/iu,
];

const MIN_LENGTH_FOR_EXTRACTION = 200;

function shouldExtractFacts(userMessage: string): boolean {
  if (userMessage.length < 30) return false;
  if (userMessage.length > MIN_LENGTH_FOR_EXTRACTION) return true;
  return FACT_TRIGGER_PATTERNS.some(re => re.test(userMessage));
}

const EXTRACTION_PROMPT = `Проанализируй диалог между пользователем и ассистентом Лией.
Извлеки ФАКТЫ — устойчивую информацию о пользователе и контексте.

Правила:
1. Только ФАКТЫ, не интерпретации. "Меня зовут Иван" → user.name: Иван. Не "пользователь представился".
2. Глобальные факты (профиль пользователя): префикс "user."
   - user.name — имя
   - user.profession — профессия
   - user.age — возраст
   - user.favorite_language — любимый язык программирования
   - user.location — где живёт
3. Эпизодные факты (контекст текущего чата): префикс "current."
   - current.project — над чем работает
   - current.task — что делает сейчас
   - current.topic — тема обсуждения
   - current.tech_stack — используемые технологии
4. ${GROUNDING.noFabricateFacts} Если информации нет — не включай.
5. Если факт уже известен и не изменился — не дублируй.
6. Формат: строго JSON {"global": {"name": "Иван", ...}, "episode": {"project": "...", ...}}
   В ключах JSON — БЕЗ префиксов user./current. (их добавит система). Допустимы и полные ключи — дубль префикса будет снят.
7. Если фактов нет — верни {"global": {}, "episode": {}}

Диалог:
Пользователь: {USER_MSG}
Лия: {LIA_MSG}

Извлеки факты (JSON):`;

/** Снять дубли user./current. и собрать канонический ключ. */
export function normalizeFactStorageKey(
  rawKey: string,
  prefix: 'user' | 'current',
): string | null {
  let key = rawKey.trim();
  if (!key) return null;
  while (/^(user|current)\./i.test(key)) {
    key = key.replace(/^(user|current)\./i, '');
  }
  key = key.replace(/[^a-zA-Z0-9_.-]/g, '_').replace(/_+/g, '_').replace(/^[._]+|[._]+$/g, '');
  if (!key || key.length > 64) return null;
  return `${prefix}.${key.toLowerCase()}`;
}

async function ensurePersonForExtraction(
  episodeId: string,
  userMessage: string,
): Promise<string | null> {
  let personId = await getEpisodePersonId(episodeId);
  if (personId) return personId;

  const people = await listPeople();
  const matched = resolvePersonFromUtterance(userMessage, people);
  if (matched) {
    await bindEpisodePerson(episodeId, matched.id);
    return matched.id;
  }

  const claimed = extractClaimedNameFromUtterance(userMessage);
  if (claimed && people.length < MAX_PEOPLE) {
    const hit = resolvePersonFromUtterance(claimed, people);
    if (hit) {
      await bindEpisodePerson(episodeId, hit.id);
      return hit.id;
    }
    try {
      const created = await createPerson({
        displayName: claimed,
        isDefault: people.length === 0,
      });
      await bindEpisodePerson(episodeId, created.id);
      return created.id;
    } catch {
      return null;
    }
  }

  if (people.length === 1 && people[0]) {
    await bindEpisodePerson(episodeId, people[0].id);
    return people[0].id;
  }

  return null;
}

export async function extractAndSaveFacts(params: {
  userMessage: string;
  liaMessage: string;
  episodeId: string;
}): Promise<{ globalCount: number; episodeCount: number }> {
  const { userMessage, liaMessage, episodeId } = params;

  if (!shouldExtractFacts(userMessage)) {
    return { globalCount: 0, episodeCount: 0 };
  }

  try {
    const model = await getChatModel();
    const prompt = EXTRACTION_PROMPT
      .replace('{USER_MSG}', userMessage.slice(0, 1000))
      .replace('{LIA_MSG}', liaMessage.slice(0, 500));

    const result = streamText({
      model,
      system: 'Ты — модуль извлечения фактов. Возвращай только валидный JSON, без markdown.',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      maxOutputTokens: 300,
      abortSignal: AbortSignal.timeout(30_000),
      onError: (error) => {
        logger.warn('memory', 'Fact extraction streamText onError', {
          userMsgPreview: userMessage.slice(0, 60),
        }, error instanceof Error ? error : undefined);
      },
    });

    const text = await result.text;

    const { extractJson } = await import('@/lib/infra/prompt-safety');
    const parsed = extractJson<{
      global?: Record<string, string>;
      episode?: Record<string, string>;
    }>(text);
    if (!parsed) {
      return { globalCount: 0, episodeCount: 0 };
    }

    let globalCount = 0;
    let episodeCount = 0;

    const personId = await ensurePersonForExtraction(episodeId, userMessage);

    if (parsed.global && typeof parsed.global === 'object' && personId) {
      for (const [key, value] of Object.entries(parsed.global)) {
        if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length >= 500) {
          continue;
        }
        const trimmed = value.trim();
        const storageKey = normalizeFactStorageKey(key, 'user');
        if (!storageKey) continue;
        const shortKey = storageKey.replace(/^user\./, '');
        if (shortKey === 'name') {
          await renamePersonDisplayName(personId, trimmed);
          globalCount++;
          await remember({
            episodeId,
            sourceType: 'fact',
            text: `[person] name: ${trimmed}`,
          });
          continue;
        }
        // At capacity: never overwrite another person's profile via unbound name change
        const n = await countPeople();
        if (n > MAX_PEOPLE) continue;
        await upsertPersonFact(personId, shortKey, trimmed);
        await remember({
          episodeId,
          sourceType: 'fact',
          text: `[person] ${shortKey}: ${trimmed}`,
        });
        globalCount++;
      }
    }

    if (parsed.episode && typeof parsed.episode === 'object') {
      for (const [key, value] of Object.entries(parsed.episode)) {
        if (typeof value === 'string' && value.trim().length > 0 && value.trim().length < 500) {
          const trimmed = value.trim();
          const storageKey = normalizeFactStorageKey(key, 'current');
          if (!storageKey) continue;
          await upsertEpisodeFact(episodeId, storageKey, trimmed);
          await remember({
            episodeId,
            sourceType: 'fact',
            text: `[episode] ${storageKey}: ${trimmed}`,
          });
          episodeCount++;
        }
      }
    }

    if (globalCount + episodeCount > 0) {
      logger.info('memory', `Facts extracted`, {
        globalCount,
        episodeCount,
        personId: personId?.slice(0, 8),
      });
    }

    return { globalCount, episodeCount };
  } catch (e) {
    logger.warn('memory', 'extraction failed (non-fatal)', {}, e);
    return { globalCount: 0, episodeCount: 0 };
  }
}
