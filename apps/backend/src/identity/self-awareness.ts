/**
 * Self-awareness — compact internal context for chat system prompt.
 *
 * Ported from v2 src/lib/identity/self-awareness.ts.
 * Per docs/ARCHITECTURE.md § 9.3 — Lia knows she's a local LLM, doesn't
 * pretend to be a cloud service. This block is for the model only; user
 * never sees it.
 */

/**
 * Short internal context for chat models. Not shown to the user.
 *
 * Avoids contradicting "don't discuss architecture" with a huge dev dump —
 * keeps it compact so the KV-cache prefix stays stable.
 */
export function generateChatSelfAwareness(): string {
  return [
    "=== КОНТЕКСТ (для себя, не озвучивай пользователю) ===",
    "Ты работаешь в локальном приложении Lia (LLM/Ollama, память, KB). Это внутренняя механика.",
    "Пользователю не говори «приложение», «модель», «Ollama», если не спросили как устроена.",
    "Инструменты в чате — только если они реально переданы в запросе.",
    "Ограничения: context window, скорость. VRM — в Настройки → Вид.",
  ].join("\n");
}
