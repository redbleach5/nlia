import 'server-only';

// ============================================================================
// Field-level encryption — шифрование чувствительных полей в Prisma models.
// ============================================================================
//
// Проблема: SQLCipher (шифрование всей БД) не работает с better-sqlite3.
// Альтернатива: шифровать отдельные чувствительные поля через AES-256-GCM
// (как в infra/crypto.ts для field-level secrets).
//
// Что шифруем (если LIA_ENCRYPT_SENSITIVE_FIELDS=true):
//   - EmotionalMemory.context — что пользователь говорил в момент эмоции
//   - EmotionalMemory.trigger — описание триггера эмоции
//   - GlobalFact.value — глобальные факты о пользователе
//   - EpisodeFact.value — факты текущего чата
//
// Что НЕ шифруем (performance/functional constraints):
//   - Message.content — слишком много данных, расшифровка на каждый chat
//   - Chunk.content — нужен для BM25/vector search (plaintext)
//   - Embeddings — это числа, не текст (не чувствительны)
//   - Source.name — нужен для UI list без расшифровки
//
// Trade-off: при LIA_ENCRYPT_SENSITIVE_FIELDS=true — расшифровка при каждом
// recall emotional anchors / facts. Latency +1-5ms per record. Для single-user
// acceptable.
//
// Full DB encryption: если нужно зашифровать ВСЁ (chat history, document
// content) — используй OS-level encryption:
//   - Windows: BitLocker (включить в Settings → Privacy & Security → BitLocker)
//   - macOS: FileVault (System Settings → Privacy & Security → FileVault)
//   - Linux: LUKS (full-disk encryption при установке ОС)
// Это шифрует весь диск, включая SQLite файл, без изменений в коде.

import { encryptString, decryptString, isEncryptionAvailable, isEncrypted } from './crypto';

/**
 * Проверить, включено ли шифрование чувствительных полей.
 * Default: false (backward compat). Включается через LIA_ENCRYPT_SENSITIVE_FIELDS=true.
 *
 * Если LIA_ENCRYPTION_KEY не задан — возвращает false даже если env var true
 * (нечем шифровать).
 */
function isSensitiveFieldEncryptionEnabled(): boolean {
  return process.env.LIA_ENCRYPT_SENSITIVE_FIELDS === 'true' && isEncryptionAvailable();
}

/**
 * Зашифровать текстовое поле если шифрование включено.
 * Если шифрование выключено — возвращает plaintext as-is (backward compat).
 * Если шифрование включено но ключ не задан — тоже plaintext + warning.
 */
export function encryptField(plaintext: string): string {
  if (!isSensitiveFieldEncryptionEnabled()) return plaintext;
  if (!plaintext) return plaintext;
  // Не перешифровываем уже зашифрованное (idempotent)
  if (isEncrypted(plaintext)) return plaintext;
  return encryptString(plaintext);
}

/**
 * Расшифровать текстовое поле.
 * Если значение не зашифровано (legacy plaintext) — возвращает as-is.
 * Если зашифровано — расшифровывает.
 * Если шифрование выключено — возвращает as-is (даже если значение зашифровано,
 * что может произойти если env var был true, потом стал false).
 *
 * @throws Error если значение зашифровано, но ключ не задан/неверен
 */
export function decryptField(ciphertext: string): string {
  if (!ciphertext) return ciphertext;
  // Legacy plaintext — no prefix
  if (!isEncrypted(ciphertext)) return ciphertext;
  // Encrypted value — decrypt (needs key)
  return decryptString(ciphertext);
}
