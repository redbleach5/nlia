import 'server-only';

// Self-awareness for system prompt — compact for chat (no paths/tool catalogs).

/**
 * Short internal context for chat models. Not shown to the user; avoids
 * contradicting "don't discuss architecture" with a huge dev dump.
 */
export function generateChatSelfAwareness(): string {
  return [
    '=== КОНТЕКСТ (для себя, не озвучивай пользователю) ===',
    'Ты работаешь в локальном приложении Lia (LLM/Ollama, память, KB). Это внутренняя механика.',
    'Пользователю не говори «приложение», «модель», «Ollama», если не спросили как устроена.',
    'Инструменты в чате — только если они реально переданы в запросе.',
    'Ограничения: context window, скорость. VRM — в Настройки → Вид.',
  ].join('\n');
}

/** @deprecated Prefer generateChatSelfAwareness in chat pipeline. */
export function generateSelfAwareness(): string {
  return generateChatSelfAwareness();
}
