import { z } from "zod";
import { INTERACTION_CHANNELS } from "./leads";

export const FOLLOW_UP_STATUSES = ["SCHEDULED", "DUE", "IN_PROGRESS", "COMPLETED", "SKIPPED", "CANCELLED", "FAILED", "PAUSED"] as const;
export type FollowUpStatus = (typeof FOLLOW_UP_STATUSES)[number];
export const FOLLOW_UP_STATUS_LABELS: Record<FollowUpStatus, string> = {
  SCHEDULED: "Scheduled",
  DUE: "Due",
  IN_PROGRESS: "In progress",
  COMPLETED: "Done",
  SKIPPED: "Skipped",
  CANCELLED: "Cancelled",
  FAILED: "Failed",
  PAUSED: "Paused",
};
/** Tasks that still need something to happen. */
export const PENDING_FOLLOW_UP_STATUSES: readonly FollowUpStatus[] = ["SCHEDULED", "DUE", "IN_PROGRESS"];

/** The spec's suggested default sequence. */
export const DEFAULT_FOLLOW_UP_STEPS = [
  { name: "First reminder", delayMinutes: 24 * 60 },
  { name: "Second reminder", delayMinutes: 3 * 24 * 60 },
  { name: "Third reminder", delayMinutes: 7 * 24 * 60 },
  { name: "Fourth reminder", delayMinutes: 14 * 24 * 60 },
] as const;

export const MAX_FOLLOW_UP_STEPS = 10;
const MIN_DELAY = 60; // 1 hour
const MAX_DELAY = 365 * 24 * 60;

export const followUpStepSchema = z.object({
  name: z.string().trim().min(1, { error: "Give this step a name" }).max(80),
  /** Minutes after the sequence starts (lead arrival or the employee's last contact). */
  delayMinutes: z
    .number()
    .int()
    .min(MIN_DELAY, { error: "Use at least 1 hour" })
    .max(MAX_DELAY, { error: "Use at most 365 days" }),
  active: z.boolean().default(true),
});

export const updateFollowUpRulesSchema = z.object({
  steps: z
    .array(followUpStepSchema)
    .min(1, { error: "Keep at least one follow-up step" })
    .max(MAX_FOLLOW_UP_STEPS, { error: `Use at most ${MAX_FOLLOW_UP_STEPS} steps` })
    .superRefine((steps, ctx) => {
      for (let i = 1; i < steps.length; i++) {
        if (steps[i]!.delayMinutes <= steps[i - 1]!.delayMinutes) {
          ctx.addIssue({ code: "custom", path: [i, "delayMinutes"], message: "Each step must come later than the one before" });
        }
      }
    }),
});
export type UpdateFollowUpRulesInput = z.input<typeof updateFollowUpRulesSchema>;

export const scheduleFollowUpSchema = z.object({
  dueAt: z.iso.datetime({ offset: true }),
  title: z.string().trim().max(160).optional(),
  note: z.string().trim().max(2000).optional(),
});
export type ScheduleFollowUpInput = z.input<typeof scheduleFollowUpSchema>;

export const rescheduleFollowUpSchema = z.object({ dueAt: z.iso.datetime({ offset: true }) });

export const completeFollowUpSchema = z.object({
  /** True when the employee actually reached out to the customer (records an interaction). */
  contacted: z.boolean().default(true),
  channel: z.enum(INTERACTION_CHANNELS).default("PHONE"),
  awaitingCustomer: z.boolean().default(true),
  note: z.string().trim().max(5000).optional(),
});
export type CompleteFollowUpInput = z.input<typeof completeFollowUpSchema>;

export const customerReplySchema = z.object({
  channel: z.enum(INTERACTION_CHANNELS).default("PHONE"),
  note: z.string().trim().max(5000).optional(),
});
export type CustomerReplyInput = z.input<typeof customerReplySchema>;

export const FOLLOW_UP_VIEWS = ["due_today", "overdue", "upcoming", "waiting", "awaiting_employee", "failed"] as const;
export type FollowUpView = (typeof FOLLOW_UP_VIEWS)[number];
export const FOLLOW_UP_VIEW_LABELS: Record<FollowUpView, string> = {
  due_today: "Due today",
  overdue: "Overdue",
  upcoming: "Upcoming",
  waiting: "Waiting for customer",
  awaiting_employee: "Awaiting action",
  failed: "Failed messages",
};
