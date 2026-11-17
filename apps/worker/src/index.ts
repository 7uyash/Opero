import { Queue } from "bullmq";
import { prisma } from "@lfm/db";
import { config, logger } from "@lfm/core";
import { DEFAULT_JOB_OPTIONS, QUEUES, SWEEP_EVERY_MS, createRedisConnection, ensureSweepScheduler } from "@lfm/queue";
import { createFollowUpWorker, createMessageWorker, runSweep } from "./processors";

/**
 * Background worker: follow-up reminders and outgoing messages, independent of any browser session.
 * Safe to run several copies — the sweep scheduler is shared and all processing is idempotent.
 */
async function main() {
  config(); // fail fast on misconfiguration
  const log = logger.child({ component: "worker" });

  const queueConn = createRedisConnection();
  const followConn = createRedisConnection({ forWorker: true });
  const messageConn = createRedisConnection({ forWorker: true });
  const queues = {
    followups: new Queue(QUEUES.followups, { connection: queueConn, defaultJobOptions: DEFAULT_JOB_OPTIONS }),
    messages: new Queue(QUEUES.messages, { connection: queueConn, defaultJobOptions: { ...DEFAULT_JOB_OPTIONS, attempts: 1 } }),
  };

  await prisma.$queryRaw`SELECT 1`;
  await ensureSweepScheduler(queues.followups);
  // Catch up immediately on start (e.g. after downtime) instead of waiting for the first tick.
  await runSweep(queues);
  const workers = [createFollowUpWorker(followConn, queues), createMessageWorker(messageConn)];
  log.info({ sweepEveryMs: SWEEP_EVERY_MS }, "worker started");

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, "shutting down: finishing current jobs");
    // Let in-flight jobs finish; anything unfinished is re-found by the next sweep.
    await Promise.all(workers.map((w) => w.close()));
    await Promise.all([queues.followups.close(), queues.messages.close()]);
    await Promise.allSettled([queueConn.quit(), followConn.quit(), messageConn.quit(), prisma.$disconnect()]);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.fatal({ err }, "worker failed to start");
  process.exit(1);
});
