import 'server-only';

// Setup wizard — reserved for future first-run hooks.

import { logger } from '@/lib/logger';

/** No-op on startup; kept so server-startup can call a stable hook. */
export async function runSetupWizard(): Promise<void> {
  logger.debug('system', 'Setup wizard: nothing to configure');
}
