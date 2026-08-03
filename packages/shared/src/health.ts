/**
 * Health response — shape of GET /api/health.
 */

export interface HealthResponse {
  status: "ok" | "degraded";
  runtime: "node" | "bun";
  nodeVersion: string;
  bunVersion: string | null;
  sqliteVec: boolean;
  vecVersion: string | null;
  dbOk: boolean;
  kbVecTable: boolean;
  schemaVersion: string | null;
  uptimeMs: number;
  timestamp: string;
}
