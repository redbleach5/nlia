/**
 * Backend process entry — always listens (macOS / Linux / Windows).
 *
 * Kept separate from `index.ts` (Hono app export) so:
 *   - tests can `import { app }` without binding a port
 *   - Windows is not broken by `import.meta.url === file://${argv[1]}`
 *     (backslashes / drive letters never match that string compare)
 */

import { app } from "./index.js";
import { logger as pinoLogger } from "./util/logger.js";
import { env } from "./util/env.js";
import { closeDb, getDb } from "./db/client.js";
import { pushSchema } from "./db/push.js";
import { startMcpServer, stopMcpServer } from "./mcp/server.js";
import { connectAllMcpServers, disconnectAllMcpServers } from "./mcp/client.js";

function shutdown(signal: string): void {
  pinoLogger.info({ signal }, "shutting down");
  stopMcpServer();
  void disconnectAllMcpServers().finally(() => {
    closeDb();
    process.exit(0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

getDb();
pushSchema();

const { serve } = await import("@hono/node-server");
serve(
  {
    fetch: app.fetch,
    hostname: env.backendHost,
    port: env.backendPort,
  },
  (info) => {
    pinoLogger.info(
      { host: info.address, port: info.port, runtime: env.runtime },
      "lia-backend listening",
    );

    startMcpServer().catch((e) => pinoLogger.error({ err: e }, "MCP server failed to start"));
    connectAllMcpServers().catch((e) =>
      pinoLogger.error({ err: e }, "MCP clients failed to connect"),
    );
  },
);
