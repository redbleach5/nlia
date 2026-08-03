import 'server-only';

import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

// P2-4 fix (M-DB): the previous ternary had identical branches (['error','warn']
// on both sides). Now simplified — query logs are noisy in both dev and prod,
// so we keep only error+warn everywhere.
const logConfig: ('error' | 'warn')[] = ['error', 'warn'];

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: logConfig,
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db

// P2-4 fix (M-DB): disconnect when the event loop drains naturally (dev
// reload, clean exit). SIGTERM/SIGINT do not fire beforeExit — background
// service cleanup lives in server-startup.ts.
process.on('beforeExit', async () => {
  try {
    await db.$disconnect();
  } catch {
    // Best-effort — process is exiting anyway.
  }
});
