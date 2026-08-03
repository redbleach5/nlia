/**
 * Vitest config for @lia/backend.
 * M0: only smoke tests for health + db. M1+ adds unit tests for chat, agent, kb.
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    globals: false,
    pool: "forks",
    // All test files share the single on-disk SQLite DB resolved by
    // src/db/client.ts. Parallel forks race opening it (journal_mode=WAL
    // pragma) and intermittently fail with "database is locked".
    // Serialize into one fork so the suite is deterministic.
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 10_000,
  },
  resolve: {
    alias: {
      "@lia/shared": new URL("../../packages/shared/src/index.ts", import.meta.url).pathname,
    },
  },
});
