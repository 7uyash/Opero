import { prisma as db, type Db, type ExecutionStatus, type Prisma } from "@lfm/db";
import { Errors } from "../errors";
import { retryMessage } from "../messaging/outbox";
import { assertPermission, type OrgContext } from "../tenancy/context";
import { LEAD_FOLLOWUP_AUTOMATION } from "@lfm/shared";

export type ExecutionEntry = {
  organizationId: string;
  eventType: string;
  status: ExecutionStatus;
  leadId?: string | null;
  messageId?: string | null;
  followUpTaskId?: string | null;
  jobId?: string | null;
  input?: Prisma.InputJsonValue;
  output?: Prisma.InputJsonValue;
  error?: string | null;
  retryable?: boolean;
  attempt?: number;
};

/** Business-facing log of everything the automation did (shown in "Automation activity"). */
export function logExecution(db: Db, e: ExecutionEntry) {
  return db.automationExecution.create({
    data: {
      organizationId: e.organizationId,
      automationKey: LEAD_FOLLOWUP_AUTOMATION,
      eventType: e.eventType,
      status: e.status,
      leadId: e.leadId ?? null,
      messageId: e.messageId ?? null,
      followUpTaskId: e.followUpTaskId ?? null,
      jobId: e.jobId ?? null,
      input: e.input ?? {},
      output: e.output ?? {},
      error: e.error ?? null,
      retryable: e.retryable ?? false,
      attempt: e.attempt ?? 1,
    },
  });
}


// ───────────────────────────── Activity view ─────────────────────────────


export async function listExecutions(
  ctx: OrgContext,
  opts: { status?: ExecutionStatus; eventPrefix?: string; cursor?: string; limit?: number } = {},
) {
  assertPermission(ctx, "executions:view");
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
  const rows = await db.automationExecution.findMany({
    where: {
      organizationId: ctx.organizationId,
      ...(opts.status ? { status: opts.status } : {}),
      ...(opts.eventPrefix ? { eventType: { startsWith: opts.eventPrefix } } : {}),
    },
    include: { lead: { select: { id: true, name: true } } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
  });
  const items = rows.slice(0, limit);
  // Attach the current state of the related message so the UI only offers retry when it still makes sense.
  const messageIds = items.map((i) => i.messageId).filter((x): x is string => !!x);
  const messages = messageIds.length
    ? await db.message.findMany({ where: { id: { in: messageIds } }, select: { id: true, status: true, failureKind: true } })
    : [];
  const byId = new Map(messages.map((m) => [m.id, m]));
  return {
    items: items.map((i) => ({ ...i, message: i.messageId ? (byId.get(i.messageId) ?? null) : null })),
    nextCursor: rows.length > limit ? items[items.length - 1]!.id : null,
  };
}

/** Safe retry of a failed execution. Today only message sends can be retried. */
export async function retryExecution(ctx: OrgContext, executionId: string, opts: { confirmPossibleDuplicate?: boolean } = {}) {
  assertPermission(ctx, "executions:retry");
  const e = await db.automationExecution.findFirst({ where: { id: executionId, organizationId: ctx.organizationId } });
  if (!e) throw Errors.notFound("Activity");
  if (!e.messageId) throw Errors.validation("This step can't be retried.");
  return retryMessage(ctx, e.messageId, opts);
}
