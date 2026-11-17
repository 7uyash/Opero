import { Queue, type ConnectionOptions, type JobsOptions } from "bullmq";
import { Redis } from "ioredis";

/**
 * Queue names, job payloads and producers shared by the web app and the worker.
 * The database remains the source of truth (ADR-006); jobs only trigger work, and every
 * processor is idempotent so duplicates and retries are harmless.
 */

export const QUEUES = {
  followups: "lfm-followups",
  messages: "lfm-messages",
} as const;

export const JOBS = {
  /** Repeatable: finds due follow-ups and enqueues them; also sends overdue notices. */
  sweep: "sweep",
  /** Processes one follow-up task. jobId = `fu-<taskId>-<dueAt>` de-duplicates per due time. */
  processFollowUp: "process-follow-up",
  /** Sends one queued message. jobId = `msg-<id>-<attempt>` so each retry attempt is a new job. */
  sendMessage: "send-message",
} as const;

export type SendMessageJob = { messageId: string };

export type ProcessFollowUpJob = { taskId: string };

export const SWEEP_EVERY_MS = Number(process.env.FOLLOWUP_SWEEP_MS ?? 15_000);

/** Retries with exponential backoff (ADR-008); failed jobs are kept for inspection (dead letter). */
export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: "exponential", delay: 30_000 },
  removeOnComplete: { age: 24 * 3600, count: 5000 },
  removeOnFail: { age: 30 * 24 * 3600 },
};

export function redisUrl(): string {
  return process.env.REDIS_URL ?? "redis://localhost:6379";
}

/** BullMQ workers need maxRetriesPerRequest: null so blocking commands survive reconnects. */
export function createRedisConnection(opts: { forWorker?: boolean } = {}): Redis {
  return new Redis(redisUrl(), {
    maxRetriesPerRequest: opts.forWorker ? null : 3,
    enableReadyCheck: true,
    lazyConnect: false,
  });
}

let followUpQueue: Queue | undefined;

export function getFollowUpQueue(connection?: ConnectionOptions): Queue {
  followUpQueue ??= new Queue(QUEUES.followups, {
    connection: connection ?? createRedisConnection(),
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  });
  return followUpQueue;
}

/**
 * Includes the due time so a rescheduled task gets a new job even while the finished job for its
 * previous due time is still retained in Redis.
 */
export function followUpJobId(taskId: string, dueAt: Date) {
  return `fu-${taskId}-${dueAt.getTime()}`;
}

/** Enqueues processing of a due task. Safe to call repeatedly for the same task. */
export async function enqueueFollowUp(queue: Queue, task: { id: string; dueAt: Date }) {
  return queue.add(JOBS.processFollowUp, { taskId: task.id } satisfies ProcessFollowUpJob, { jobId: followUpJobId(task.id, task.dueAt) });
}

/** Registers (or updates) the repeatable sweep. Idempotent across restarts and multiple workers. */
export async function ensureSweepScheduler(queue: Queue, everyMs = SWEEP_EVERY_MS) {
  await queue.upsertJobScheduler("followup-sweep", { every: everyMs }, { name: JOBS.sweep, data: {}, opts: { removeOnComplete: 100, removeOnFail: 100 } });
}

let messageQueue: Queue | undefined;

export function getMessageQueue(connection?: ConnectionOptions): Queue {
  // Sending is retried by the database schedule, not by BullMQ (one attempt per job).
  messageQueue ??= new Queue(QUEUES.messages, {
    connection: connection ?? createRedisConnection(),
    defaultJobOptions: { ...DEFAULT_JOB_OPTIONS, attempts: 1 },
  });
  return messageQueue;
}

export function messageJobId(messageId: string, attempts: number) {
  return `msg-${messageId}-${attempts}`;
}

export async function enqueueMessage(queue: Queue, m: { id: string; attempts: number }) {
  return queue.add(JOBS.sendMessage, { messageId: m.id } satisfies SendMessageJob, { jobId: messageJobId(m.id, m.attempts) });
}

/**
 * Best-effort immediate send from the web app (e.g. a message a team member just wrote).
 * If Redis is unavailable the worker's sweep still sends it within seconds.
 */
export async function tryEnqueueMessage(m: { id: string; attempts: number }) {
  try {
    await enqueueMessage(getMessageQueue(), m);
    return true;
  } catch {
    return false;
  }
}

export async function closeQueues() {
  await followUpQueue?.close();
  await messageQueue?.close();
  followUpQueue = undefined;
  messageQueue = undefined;
}
