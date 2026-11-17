import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Queue, type Worker } from "bullmq";
import type { Redis } from "ioredis";
import { prisma } from "@lfm/db";
import { resetDatabase } from "@lfm/db/testing";
import { createLead, registerOwner, resolveOrgContext } from "@lfm/core";
import { DEFAULT_JOB_OPTIONS, createRedisConnection } from "@lfm/queue";
import { createFollowUpWorker, runSweep } from "../src/processors";

/**
 * Runs the real BullMQ worker against the docker-compose Redis, on an isolated queue name
 * so it never touches a development worker's jobs.
 */
const QUEUE = `lfm-followups-test-${process.pid}`;
let queueConn: Redis;
let workerConn: Redis;
let queue: Queue;
let messages: Queue;
const queues = () => ({ followups: queue, messages });
let worker: Worker;

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 15_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("timed out");
}

async function dueLeadTask() {
  const reg = await registerOwner({
    name: "Owner",
    email: `owner${Date.now()}@acme.test`,
    password: "longpassword1",
    businessName: "Acme",
    businessEmail: "o@acme.test",
    timezone: "UTC",
  });
  const ctx = (await resolveOrgContext(reg.userId, reg.organizationId))!;
  const { lead } = await createLead(ctx, { name: "Rahul", email: "rahul@example.com" });
  const task = await prisma.followUpTask.findFirstOrThrow({ where: { leadId: lead.id, stepIndex: 1 } });
  await prisma.followUpTask.update({ where: { id: task.id }, data: { dueAt: new Date(Date.now() - 1000) } });
  return { lead, task };
}

beforeAll(async () => {
  queueConn = createRedisConnection();
  workerConn = createRedisConnection({ forWorker: true });
  queue = new Queue(QUEUE, { connection: queueConn, defaultJobOptions: DEFAULT_JOB_OPTIONS });
  messages = new Queue(`${QUEUE}-messages`, { connection: queueConn });
  await queue.obliterate({ force: true }).catch(() => undefined);
  worker = createFollowUpWorker(workerConn, queues(), { concurrency: 2, queueName: QUEUE });
  await worker.waitUntilReady();
});

afterAll(async () => {
  await worker?.close();
  await queue?.obliterate({ force: true }).catch(() => undefined);
  await queue?.close();
  await messages?.obliterate({ force: true }).catch(() => undefined);
  await messages?.close();
  await Promise.allSettled([queueConn?.quit(), workerConn?.quit()]);
  await prisma.$disconnect();
});

beforeEach(resetDatabase);

describe("follow-up worker", () => {
  it("sweeps a due reminder into a job and the worker fires it", async () => {
    const { lead, task } = await dueLeadTask();
    const { followUps } = await runSweep(queues());
    expect(followUps).toBe(1);
    const done = await waitFor(async () => {
      const t = await prisma.followUpTask.findUniqueOrThrow({ where: { id: task.id } });
      return t.status === "DUE" && t;
    });
    expect(done.status).toBe("DUE");
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).followUpStep).toBe(1);
  });

  it("recovers when Redis loses every job: the next sweep re-finds the task in the database", async () => {
    const { task } = await dueLeadTask();
    await worker.pause();
    await runSweep(queues());
    // Simulate Redis data loss / a crash before processing.
    await queue.obliterate({ force: true });
    expect(await queue.count()).toBe(0);
    await worker.resume();
    await runSweep(queues());
    await waitFor(async () => (await prisma.followUpTask.findUniqueOrThrow({ where: { id: task.id } })).status === "DUE");
  });

  it("a rescheduled task fires again even though its earlier job is still retained", async () => {
    const { task } = await dueLeadTask();
    await runSweep(queues());
    await waitFor(async () => (await prisma.followUpTask.findUniqueOrThrow({ where: { id: task.id } })).status === "DUE");
    // Rescheduled into the past to make it due again (as if the new time has arrived).
    await prisma.followUpTask.update({ where: { id: task.id }, data: { status: "SCHEDULED", dueAt: new Date(Date.now() - 500) } });
    await runSweep(queues());
    await waitFor(async () => (await prisma.followUpTask.findUniqueOrThrow({ where: { id: task.id } })).status === "DUE");
  });

  it("duplicate sweeps don't double-fire", async () => {
    const { lead, task } = await dueLeadTask();
    await Promise.all([runSweep(queues()), runSweep(queues()), runSweep(queues())]);
    await waitFor(async () => (await prisma.followUpTask.findUniqueOrThrow({ where: { id: task.id } })).status === "DUE");
    await new Promise((r) => setTimeout(r, 500));
    expect(await prisma.automationExecution.count({ where: { eventType: "followup.reminder_due", leadId: lead.id } })).toBe(1);
  });
});
