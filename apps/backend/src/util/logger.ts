/**
 * Pino logger. Level controlled by LIA_LOG_LEVEL env (default: info).
 * Pretty-prints in dev, JSON in prod (LIA_ENV=production).
 */

import pino from "pino";

const level = process.env.LIA_LOG_LEVEL ?? "info";
const isProd = process.env.LIA_ENV === "production";

export const logger = pino({
  level,
  base: { service: "lia-backend" },
  transport: isProd
    ? undefined
    : {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "HH:MM:ss.l",
          ignore: "pid,hostname,service",
        },
      },
});

export type Logger = typeof logger;
