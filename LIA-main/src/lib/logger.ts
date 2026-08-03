// Структурированный логгер на базе pino.
//
// Обёртка сохраняет API кастомного логгера (Phase 0), но использует pino
// для сериализации — это даёт:
//   - JSON-вывод в production (parser-friendly для log aggregators)
//   - Pretty-вывод в development (цветные строки)
//   - Быструю сериализацию (~3× быстрее чем console.log обёртки)
//   - Безопасную обработку circular references
//   - Корректную обработку Error objects (stack, cause)
//
// API (обратная совместимость):
//   import { logger } from '@/lib/logger';
//   logger.info('agent', 'Generated plan', { taskId, steps: 5 });
//   logger.error('ollama', 'Connection failed', {}, error);
//
//   const log = logger.context({ taskId, episodeId });
//   log.info('agent', 'Step started', { step: 2 });
//
// Формат (dev): [ISO] [LEVEL] [category] | message ctx=val | error
// Формат (prod): JSON с полями {time, level, category, msg, ...ctx, err}

import 'server-only';

import { pino, stdSerializers, type Logger as PinoLogger } from 'pino';

type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';
type Category = 'chat' | 'agent' | 'ollama' | 'llm' | 'tools' | 'memory' | 'db' | 'vrm' | 'api' | 'rl' | 'system' | 'kb' | 'ui';

type LogContext = Record<string, unknown>;

// ============================================================================
// Pino instance — настроен по окружению.
// ============================================================================
const isDev = process.env.NODE_ENV !== 'production';
const minLevel = (() => {
  const fromEnv = (process.env.LOG_LEVEL || '').toLowerCase() as LogLevel;
  if (['trace', 'debug', 'info', 'warn', 'error'].includes(fromEnv)) {
    return fromEnv;
  }
  return isDev ? 'debug' : 'info';
})();

const pinoLogger: PinoLogger = pino({
  level: minLevel,
  // В dev — pretty-принтер с цветами. В prod — NDJSON (newline-delimited JSON).
  transport: isDev
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          // Формат: [ISO] [LEVEL] [category] | message ctx=val
          messageFormat: '[{category}] | {msg}',
          translateTime: 'SYS:ISO8601',
          ignore: 'pid,hostname,category',
          // category выносим в messageFormat, не в стандартные поля
          singleLine: true,
        },
      }
    : undefined,
  // Redact — заменяем чувствительные поля на '[REDACTED]' в логах.
  // P3-3 fix: expanded redact paths to cover LIA_INTERNAL_TOKEN,
  // LIA_SIDECAR_API_KEY, password, secret, privateKey, cookie.
  redact: {
    paths: [
      'token', '*.token', '*.*.token', '*.*.*.token',
      'config.token', '*.config.token',
      'groqApiKey', '*.groqApiKey',
      'LIA_ENCRYPTION_KEY', '*.LIA_ENCRYPTION_KEY',
      // P3-3 fix: internal tokens and sidecar key
      'LIA_INTERNAL_TOKEN', '*.LIA_INTERNAL_TOKEN',
      'LIA_SIDECAR_API_KEY', '*.LIA_SIDECAR_API_KEY',
      // P3-3 fix: generic secret patterns
      'password', '*.password', '*.*.password',
      'secret', '*.secret', '*.*.secret',
      'privateKey', '*.privateKey',
      'cookie', '*.cookie', 'headers.cookie',
      // Authorization headers
      'authorization', '*.headers.authorization', 'headers.authorization',
      'apiKey', '*.apiKey',
      'embedding', '*.embedding',
      // body может содержать что угодно — прикрываем потенциально чувствительное
      'body.token', 'body.apiKey', 'body.groqApiKey', 'body.password', 'body.secret',
    ],
    censor: '[REDACTED]',
    remove: false,
  },
  // Сериализаторы: Errors → { msg, stack, cause }
  serializers: {
    err: stdSerializers.err,
    error: stdSerializers.err,
  },
});

// ============================================================================
// Wrapper — сохраняет API кастомного логгера.
// ============================================================================
// Pino использует child loggers для контекста — это эффективно:
// child = parent.child({ taskId, episodeId }), затем child.info(...) автоматически
// включает эти поля. Мы используем это для logger.context().

function log(
  level: LogLevel,
  category: Category,
  message: string,
  ctx?: LogContext,
  error?: unknown,
) {
  const payload: LogContext = { category, ...ctx };
  if (error !== undefined) {
    // pino автоматически сериализует Error через serializers.err.
    // Если error — не Error (например, объект от Vercel AI SDK onError),
    // преобразуем в Error с осмысленным сообщением вместо "[object Object]".
    if (error instanceof Error) {
      payload.err = error;
    } else if (typeof error === 'string') {
      payload.err = new Error(error);
    } else if (error && typeof error === 'object') {
      const e = error as { message?: string; name?: string; stack?: string; cause?: unknown };
      const err = new Error(e.message ?? JSON.stringify(error));
      if (e.name) err.name = e.name;
      if (e.stack) err.stack = e.stack;
      if (e.cause !== undefined) (err as Error & { cause?: unknown }).cause = e.cause;
      payload.err = err;
    } else {
      payload.err = new Error(String(error));
    }
  }
  pinoLogger[level](payload, message);
}

// ============================================================================
// Logger API — обратная совместимость с Phase 0-2.
// ============================================================================
export const logger = {
  trace: (cat: Category, msg: string, ctx?: LogContext) => log('trace', cat, msg, ctx),
  debug: (cat: Category, msg: string, ctx?: LogContext) => log('debug', cat, msg, ctx),
  info: (cat: Category, msg: string, ctx?: LogContext) => log('info', cat, msg, ctx),
  warn: (cat: Category, msg: string, ctx?: LogContext, error?: unknown) => log('warn', cat, msg, ctx, error),
  error: (cat: Category, msg: string, ctx?: LogContext, error?: unknown) => log('error', cat, msg, ctx, error),

  context(ctx: LogContext): ContextualLogger {
    // Pino child logger — автоматически включает ctx во все последующие логи.
    const child = pinoLogger.child(ctx);
    const contextualLog = (
      level: LogLevel,
      category: Category,
      message: string,
      extra?: LogContext,
      error?: unknown,
    ) => {
      const payload: LogContext = { category, ...extra };
      if (error !== undefined) {
        if (error instanceof Error) {
          payload.err = error;
        } else if (typeof error === 'string') {
          payload.err = new Error(error);
        } else if (error && typeof error === 'object') {
          const e = error as { message?: string; name?: string; stack?: string; cause?: unknown };
          const err = new Error(e.message ?? JSON.stringify(error));
          if (e.name) err.name = e.name;
          if (e.stack) err.stack = e.stack;
          if (e.cause !== undefined) (err as Error & { cause?: unknown }).cause = e.cause;
          payload.err = err;
        } else {
          payload.err = new Error(String(error));
        }
      }
      child[level](payload, message);
    };
    return {
      trace: (cat: Category, msg: string, extra?: LogContext) => contextualLog('trace', cat, msg, extra),
      debug: (cat: Category, msg: string, extra?: LogContext) => contextualLog('debug', cat, msg, extra),
      info: (cat: Category, msg: string, extra?: LogContext) => contextualLog('info', cat, msg, extra),
      warn: (cat: Category, msg: string, extra?: LogContext, error?: unknown) => contextualLog('warn', cat, msg, extra, error),
      error: (cat: Category, msg: string, extra?: LogContext, error?: unknown) => contextualLog('error', cat, msg, extra, error),
    };
  },
};

type ContextualLogger = {
  trace: (cat: Category, msg: string, extra?: LogContext) => void;
  debug: (cat: Category, msg: string, extra?: LogContext) => void;
  info: (cat: Category, msg: string, extra?: LogContext) => void;
  warn: (cat: Category, msg: string, extra?: LogContext, error?: unknown) => void;
  error: (cat: Category, msg: string, extra?: LogContext, error?: unknown) => void;
};
