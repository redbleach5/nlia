/**
 * Env loading + typed accessors. Reads from process.env after dotenv has run.
 */

import "dotenv/config";

export const env = {
  runtime: (process.env.LIA_RUNTIME ?? "node") as "node" | "bun",
  logLevel: process.env.LIA_LOG_LEVEL ?? "info",
  backendHost: process.env.LIA_BACKEND_HOST ?? "127.0.0.1",
  backendPort: Number(process.env.LIA_BACKEND_PORT ?? 8787),
  dbPath: process.env.LIA_DB_PATH,
  ollamaHost: process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434",
  /** Optional root that agent fsScope must stay under. Read live for tests. */
  get workspaceRoot(): string | undefined {
    const v = process.env.LIA_WORKSPACE_ROOT?.trim();
    return v || undefined;
  },
  /** Opt-in shell execution for agent run_command tool. Read live for tests. */
  get allowShell(): boolean {
    return (
      process.env.LIA_ALLOW_SHELL === "1" || process.env.LIA_ALLOW_SHELL === "true"
    );
  },
} as const;

export type Env = typeof env;
