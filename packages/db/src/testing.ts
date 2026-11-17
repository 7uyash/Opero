import { prisma } from "./index";

/** Truncates every application table in the test database. */
export async function resetDatabase() {
  if (!process.env.DATABASE_URL?.includes("lfm_test")) throw new Error("Refusing to reset a non-test database");
  const rows = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (rows.length === 0) return;
  const list = rows.map((r) => `"public"."${r.tablename}"`).join(", ");
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}
