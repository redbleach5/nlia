import 'server-only';

/**
 * Apply additive SQLite schema patches on existing DBs.
 * Delegates to scripts/lib/apply-schema-patches.mjs (same path as db:push).
 *
 * Non-fatal for callers — log and continue if patch fails.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { PROJECT_ROOT } from '@/lib/paths';
import { logger } from '@/lib/logger';

const execFileAsync = promisify(execFile);

export async function applySchemaPatchesOnStartup(): Promise<{
  applied: string[];
  skipped: string[];
}> {
  const script = path.join(PROJECT_ROOT, 'scripts', 'lib', 'apply-schema-patches.mjs');
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [script], {
      cwd: PROJECT_ROOT,
      timeout: 20_000,
      env: process.env,
    });
    const out = `${stdout || ''}${stderr || ''}`;
    if (out.includes('Applied:')) {
      const m = out.match(/Applied:\s*(.+)/);
      const applied = m?.[1]?.split(',').map((s) => s.trim()).filter(Boolean) ?? [];
      logger.info('system', 'Schema patches applied on startup', { applied });
      return { applied, skipped: [] };
    }
    logger.info('system', 'Schema patches up to date');
    return { applied: [], skipped: ['up-to-date'] };
  } catch (e) {
    logger.warn('system', 'Schema patches failed on startup (non-fatal)', {}, e);
    return { applied: [], skipped: ['error'] };
  }
}
