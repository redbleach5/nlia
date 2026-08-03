import 'server-only';

// ============================================================================
// Crypto — AES-256-GCM шифрование секретов at rest.
// ============================================================================
//
// Используется для шифрования чувствительных полей в config (field-crypto).
// SQLite на диске пользователя — без шифрования секреты читаются из бэкапа как plaintext.
//
// Алгоритм: AES-256-GCM (authenticated encryption).
//   - Key: 32 байта (256 бит), из env LIA_ENCRYPTION_KEY (base64).
//   - IV: 12 байт, случайный на каждую операцию (НЕ re-use IV с тем же key).
//   - Auth tag: 16 байт (GCM integrity check).
//
// Формат хранения (versioned):
//   v1:aes-256-gcm:<base64(iv)>:<base64(ciphertext)>:<base64(authTag)>
//
// Префикс `v1:` позволяет будущую миграцию на другой алгоритм без schema
// migration — при чтении проверяем префикс. Legacy plaintext (без префикса)
// читается как есть для lazy migration — при следующем сохранении
// зашифровывается.
//
// Key management:
//   - Сгенерируй: openssl rand -base64 32
//   - Положи в .env: LIA_ENCRYPTION_KEY=<base64>
//   - Потеря ключа = потеря доступа к зашифрованным полям (нужно перевыпустить секреты). Храни ключ в password manager.
//   - Для rotation: задай LIA_ENCRYPTION_KEY_PREVIOUS со старым ключом,
//     decrypt() попробует текущий, при ошибке — предыдущий. CLI-команда
//     `rotate-encryption-key` перешифрует все секреты новым ключом.

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { logger } from '@/lib/logger';

const PREFIX = 'v1:aes-256-gcm:';
const ENV_KEY = 'LIA_ENCRYPTION_KEY';
const ENV_KEY_PREVIOUS = 'LIA_ENCRYPTION_KEY_PREVIOUS';

// ============================================================================
// Key loading — caches key in memory after first read.
// ============================================================================

let _currentKey: Buffer | null = null;
let _previousKey: Buffer | null = null;
let _keyWarningLogged = false;

function parseKeyFromEnv(value: string | undefined, envName: string): Buffer | null {
  if (!value) return null;
  const buf = Buffer.from(value, 'base64');
  if (buf.length !== 32) {
    throw new Error(
      `${envName} must be 32 bytes (base64-encoded). Got ${buf.length} bytes. ` +
      `Generate with: openssl rand -base64 32`,
    );
  }
  return buf;
}

function getCurrentKey(): Buffer | null {
  if (_currentKey !== null) return _currentKey;
  try {
    _currentKey = parseKeyFromEnv(process.env[ENV_KEY], ENV_KEY);
  } catch (e) {
    throw e;
  }
  if (!_currentKey && !_keyWarningLogged) {
    logger.warn(
      'kb',
      `${ENV_KEY} not set — encrypted fields will be stored in plaintext. ` +
      `Generate one with: openssl rand -base64 32`,
    );
    _keyWarningLogged = true;
  }
  return _currentKey;
}

function getPreviousKey(): Buffer | null {
  if (_previousKey !== null) return _previousKey;
  try {
    _previousKey = parseKeyFromEnv(process.env[ENV_KEY_PREVIOUS], ENV_KEY_PREVIOUS);
  } catch (e) {
    logger.warn('kb', `${ENV_KEY_PREVIOUS} is set but invalid — ignoring`, {}, e);
    _previousKey = null;
  }
  return _previousKey;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Зашифровать строку через AES-256-GCM.
 *
 * P1-2 fix (H-SEC-1): previously, if LIA_ENCRYPTION_KEY was not set, secrets
 * were stored as plaintext with only a logger.warn. A misconfigured production
 * deploy would silently degrade to plaintext. Now:
 *   - In production (NODE_ENV=production): throw unless LIA_ALLOW_PLAINTEXT_FALLBACK=true
 *    is explicitly set. Forces operators to acknowledge the risk.
 *   - In development: keep the legacy plaintext fallback for convenience.
 *
 * @returns строка вида `v1:aes-256-gcm:<iv>:<ct>:<tag>` ИЛИ plaintext (legacy mode)
 */
export function encryptString(plaintext: string): string {
  const key = getCurrentKey();
  if (!key) {
    const isProd = process.env.NODE_ENV === 'production';
    const allowFallback = process.env.LIA_ALLOW_PLAINTEXT_FALLBACK === 'true';
    if (isProd && !allowFallback) {
      throw new Error(
        'LIA_ENCRYPTION_KEY is not set. Refusing to store secrets as plaintext in production. ' +
        'Set LIA_ENCRYPTION_KEY (recommended) or LIA_ALLOW_PLAINTEXT_FALLBACK=true (NOT recommended).'
      );
    }
    return plaintext;  // legacy mode — no encryption (dev only, or explicit opt-in)
  }

  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64')}:${ct.toString('base64')}:${tag.toString('base64')}`;
}

/**
 * Расшифровать строку.
 *
 * Если значение не имеет префикса `v1:aes-256-gcm:` — считается legacy plaintext,
 * возвращается as-is. Это позволяет lazy migration: при следующем сохранении
 * значение будет зашифровано.
 *
 * Если LIA_ENCRYPTION_KEY не задан — возвращает plaintext as-is (независимо от
 * префикса). Это аварийный режим: если ключ потерян, лучше отдать plaintext
 * чем уронить приложение. Логируется как warning.
 *
 * При ошибке auth tag (неверный текущий ключ) — пробует LIA_ENCRYPTION_KEY_PREVIOUS.
 * Это позволяет rotation: новые записи шифруются новым ключом, старые
 * расшифровываются предыдущим до перешифрования.
 *
 * @throws Error если ciphertext повреждён (malformed) или ни один ключ не подошёл
 */
export function decryptString(encrypted: string): string {
  // Legacy plaintext — no prefix
  if (!encrypted.startsWith(PREFIX)) return encrypted;

  const key = getCurrentKey();
  if (!key) {
    // P-CORE-5 fix: previously returned the raw ciphertext blob, which
    // callers would send garbage as Authorization — throw instead.
    if (process.env.LIA_ALLOW_PLAINTEXT_FALLBACK === 'true') {
      logger.warn(
        'kb',
        `${ENV_KEY} not set and LIA_ALLOW_PLAINTEXT_FALLBACK=true — ` +
          `returning empty string for encrypted value (was: ${encrypted.length} bytes).`,
      );
      return '';
    }
    throw new Error(
      `Encrypted value found but ${ENV_KEY} not set. ` +
        `Set ${ENV_KEY} in .env to decrypt.`,
    );
  }

  const rest = encrypted.slice(PREFIX.length);
  const parts = rest.split(':');
  if (parts.length !== 3) {
    throw new Error('malformed ciphertext: expected 3 base64 parts');
  }
  const [ivB64, ctB64, tagB64] = parts;
  const iv = Buffer.from(ivB64, 'base64');
  const ct = Buffer.from(ctB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');

  // Try current key first
  try {
    return decryptWithKey(key, iv, ct, tag);
  } catch {
    // fallthrough to previous key
  }

  // Try previous key (for rotation)
  const prevKey = getPreviousKey();
  if (prevKey && !prevKey.equals(key)) {
    try {
      return decryptWithKey(prevKey, iv, ct, tag);
    } catch {
      // fallthrough to error
    }
  }

  throw new Error(
    'decryption failed: auth tag mismatch (wrong key, or ciphertext corrupted). ' +
    `Check ${ENV_KEY} / ${ENV_KEY_PREVIOUS} in .env.`,
  );
}

function decryptWithKey(key: Buffer, iv: Buffer, ct: Buffer, tag: Buffer): string {
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/**
 * Проверить, зашифровано ли значение (имеет префикс v1:aes-256-gcm:).
 */
export function isEncrypted(value: string): boolean {
  return value.startsWith(PREFIX);
}

/**
 * Доступен ли модуль шифрования (LIA_ENCRYPTION_KEY задан).
 */
export function isEncryptionAvailable(): boolean {
  return getCurrentKey() !== null;
}
