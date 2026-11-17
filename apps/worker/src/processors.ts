import { Worker, type Job, type Queue } from "bullmq";
import type { Redis } from "ioredis";
import {
  findDueMessages,
  findDueTasks,
  logger,
  notifyOverdueFollowUps,
  pollDueGmailIntegrations,
  processDueTask,
  recoverStuckMessages,
  sendPendingNotificationEmails,
  sendQueuedMessage,
  syncDueHubSpotIntegrations,
} from "@lfm/core";
import { JOBS, QUEUES, enqueueFollowUp, enqueueMessage, type ProcessFollowUpJob, type SendMessageJob } from "@lfm/queue";

const log = logger.child({ component: "worker" });

export type Queues = { followups: Queue; messages: Queue };

/**
 * Sweep: the safety net that makes reminders and messages survive restarts and Redis data loss.
 * Everything whose time has come and is still waiting in the database gets a job. Jobs already
 * queued keep their id (follow-ups: task+due time, messages: message+attempt), so sweeping often is cheap.
 */
export async function runSweep(queues: Queues, now = new Date()) {
  const dueTasks = await findDueTasks(now);
  for (const t of dueTasks) await enqueueFollowUp(queues.followups, t);
  const overdue = await notifyOverdueFollowUps(now);

  const recovered = await recoverStuckMessages(now);
  const dueMessages = await findDueMessages(now);
  for (const m of dueMessages) await enqueueMessage(queues.messages, m);
  const notificationEmails = await sendPendingNotificationEmails();

  // Lead sources that are polled rather than pushed (each throttles itself per connection).
  const gmail = await pollDueGmailIntegrations(now);
  const crmImported = await syncDueHubSpotIntegrations(now);

  const summary = {
    followUps: dueTasks.length,
    overdueNotices: overdue,
    messages: dueMessages.length,
    recovered,
    notificationEmails,
    emailReplies: gmail.replies,
    emailLeads: gmail.newLeads,
    crmImported,
  };
  if (Object.values(summary).some(Boolean)) log.info(summary, "sweep");
  return summary;
}

export function createFollowUpWorker(connection: Redis, queues: Queues, opts: { concurrency?: number; queueName?: string } = {}) {
  const worker = new Worker(
    opts.queueName ?? QUEUES.followups,
    async (job: Job) => {
      if (job.name === JOBS.sweep) return runSweep(queues);
      if (job.name === JOBS.processFollowUp) {
        const { taskId } = job.data as ProcessFollowUpJob;
        const result = await processDueTask(taskId, new Date(), job.id);
        log.info({ taskId, result, jobId: job.id }, "follow-up processed");
        // A due step may have queued a customer message — send it right away.
        if (result === "due") for (const m of await findDueMessages()) await enqueueMessage(queues.messages, m);
        return { result };
      }
      throw new Error(`Unknown job ${job.name}`);
    },
    { connection, concurrency: opts.concurrency ?? 5 },
  );
  attachLogging(worker);
  return worker;
}

export function createMessageWorker(connection: Redis, opts: { concurrency?: number; queueName?: string } = {}) {
  const worker = new Worker(
    opts.queueName ?? QUEUES.messages,
    async (job: Job) => {
      if (job.name !== JOBS.sendMessage) throw new Error(`Unknown job ${job.name}`);
      const { messageId } = job.data as SendMessageJob;
      const result = await sendQueuedMessage(messageId, new Date(), job.id);
      log.info({ messageId, result, jobId: job.id }, "message processed");
      return { result };
    },
    // Gentle global rate limit to stay inside provider sending limits.
    { connection, concurrency: opts.concurrency ?? 5, limiter: { max: 20, duration: 1000 } },
  );
  attachLogging(worker);
  return worker;
}

function attachLogging(worker: Worker) {
  worker.on("failed", (job, err) => log.error({ jobId: job?.id, name: job?.name, err: err.message }, "job failed"));
  worker.on("error", (err) => log.error({ err: err.message }, "worker error"));
}
