import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';

const root = path.dirname(fileURLToPath(import.meta.url));

/** Load `.env` keys into process.env when unset (CI already sets them). */
function loadDotEnv(filePath: string): void {
  if (!existsSync(filePath)) return;
  for (const raw of readFileSync(filePath, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"'))
      || (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

loadDotEnv(path.resolve(root, '.env'));
// Match CI defaults so local `bun run test:ci` works after `bun run setup`
if (!process.env.DATABASE_URL) process.env.DATABASE_URL = 'file:../db/custom.db';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(root, './src'),
      // `server-only` package throws when imported from client bundles.
      // In Vitest (Node environment) we want to allow imports — tests run
      // server-side and need to exercise modules that start with
      // `import 'server-only'` (e.g. db-vec.ts, kb/db-vec-kb.ts).
      'server-only': path.resolve(root, 'tests/__mocks__/server-only.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['node_modules/**', '.next/**', 'prisma/**', 'python-sidecar/**', 'scripts/**'],
    globals: false,
    testTimeout: 10_000,
    // Single-file SQLite (db/custom.db) — avoid SQLITE_BUSY when KB + core tests run in parallel
    fileParallelism: false,
  },
});
