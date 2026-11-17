import { PrismaClient, Prisma } from "@prisma/client";

export * from "@prisma/client";

const globalForPrisma = globalThis as unknown as { __lfmPrisma?: PrismaClient };

/** Shared Prisma client. Reused across hot reloads in development. */
export const prisma: PrismaClient =
  globalForPrisma.__lfmPrisma ??
  new PrismaClient({
    // Handled errors (e.g. unique violations) are expected; unhandled ones are logged by the app logger.
    log: process.env.PRISMA_LOG === "query" ? ["query", "warn", "error"] : ["warn"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.__lfmPrisma = prisma;

export type Tx = Prisma.TransactionClient;
export type Db = PrismaClient | Tx;

/** True when an error is a unique-constraint violation (optionally on a given field). */
export function isUniqueViolation(err: unknown, field?: string): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== "P2002") return false;
  if (!field) return true;
  const target = (err.meta?.target ?? []) as string[] | string;
  return Array.isArray(target) ? target.includes(field) : String(target).includes(field);
}
