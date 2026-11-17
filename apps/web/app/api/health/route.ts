import { NextResponse } from "next/server";
import { prisma } from "@lfm/db";
import { createRedisConnection } from "@lfm/queue";

type Redis = ReturnType<typeof createRedisConnection>;

let redis: Redis | undefined;

async function check(fn: () => Promise<unknown>) {
  try {
    await Promise.race([fn(), new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 3000))]);
    return "ok" as const;
  } catch {
    return "down" as const;
  }
}

/**
 * Liveness/readiness for Docker and load balancers. Says only whether the database and Redis
 * answer — no versions, hostnames or error text.
 */
export async function GET() {
  const [database, queue] = await Promise.all([
    check(() => prisma.$queryRaw`SELECT 1`),
    check(() => (redis ??= createRedisConnection()).ping()),
  ]);
  const ok = database === "ok" && queue === "ok";
  return NextResponse.json({ ok, database, queue }, { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
