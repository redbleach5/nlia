import 'server-only';

import { NextResponse } from 'next/server';
import { logger } from '@/lib/logger';

/**
 * P2-2 fix (M-X-5): Centralized API error helper.
 *
 * Previously, 12+ API routes returned `e.message` in 500 responses — leaking
 * internal paths, Prisma error details, and stack fragments
 * to clients. This helper:
 *   - Logs the full error server-side (with context).
 *   - Returns a generic message to the client.
 *   - Generates a correlation ID so users can reference the error in bug reports.
 *
 * Usage:
 *   } catch (e) {
 *     return apiError(500, 'failed to fetch settings', { episodeId }, e);
 *   }
 */

const VALID_STATUS = new Set([400, 401, 403, 404, 409, 413, 422, 429, 500, 502, 503, 504]);

export function apiError(
  status: number,
  clientMessage: string,
  logContext?: Record<string, unknown>,
  error?: unknown,
): NextResponse {
  // Validate status code
  const code = VALID_STATUS.has(status) ? status : 500;

  // Generate a short correlation ID (8 chars) for cross-referencing logs.
  const correlationId = generateCorrelationId();

  // Log the full error server-side with context + correlation ID.
  if (error) {
    logger.error('api', clientMessage, { ...logContext, correlationId, status: code }, error);
  } else {
    logger.error('api', clientMessage, { ...logContext, correlationId, status: code });
  }

  // Return a generic message to the client — no internal details leaked.
  return NextResponse.json(
    {
      error: clientMessage,
      correlationId,
    },
    { status: code },
  );
}

/**
 * Generate a short correlation ID (8 hex chars).
 * Not cryptographically secure — just for log cross-referencing.
 */
function generateCorrelationId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${ts}${rand}`.slice(-8);
}
