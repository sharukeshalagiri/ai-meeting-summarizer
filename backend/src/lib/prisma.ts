import { PrismaClient } from "@prisma/client";
import { env } from "./env";

/**
 * Single Prisma instance for the process.
 *
 * Cached on globalThis because ts-node-dev re-executes modules on
 * reload; without this each restart would open a new connection pool
 * and eventually exhaust the database's connection limit.
 */
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ["warn", "error"],
  });

if (!env.isProduction) {
  globalForPrisma.prisma = prisma;
}
