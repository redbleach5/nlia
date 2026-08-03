import 'server-only';

/**
 * Lightweight grounded edit verification (P5a) — no LSP.
 */

import { readFile } from 'node:fs/promises';
import { safePathWithinScope } from './fs-scope';

export type GroundedCheckResult = {
  ok: boolean;
  errors: string[];
};

export async function verifyAppliedEdit(params: {
  fsScope: string;
  relativePath: string;
  /** Expected content after apply (optional round-trip). */
  expectedContent?: string;
  /** If true, empty file is an error. */
  requireNonEmpty?: boolean;
}): Promise<GroundedCheckResult> {
  const errors: string[] = [];
  const abs = await safePathWithinScope(params.relativePath, params.fsScope);
  if (!abs) {
    return { ok: false, errors: ['path outside workspace scope'] };
  }

  let content: string;
  try {
    content = await readFile(abs, 'utf8');
  } catch {
    return { ok: false, errors: ['file does not exist after apply'] };
  }

  if (params.requireNonEmpty !== false && content.length === 0) {
    errors.push('file is unexpectedly empty');
  }

  if (params.expectedContent != null && content !== params.expectedContent) {
    errors.push('round-trip content mismatch vs proposed');
  }

  if (params.relativePath.endsWith('.json')) {
    try {
      JSON.parse(content);
    } catch {
      errors.push('JSON parse failed');
    }
  }

  return { ok: errors.length === 0, errors };
}
