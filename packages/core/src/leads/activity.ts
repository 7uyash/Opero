import type { ActivityType, ActorType, Db, Prisma } from "@lfm/db";

export type ActivityInput = {
  organizationId: string;
  leadId: string;
  type: ActivityType;
  actorType: ActorType;
  actorUserId?: string | null;
  payload?: Prisma.InputJsonValue;
  occurredAt?: Date;
};

/** Appends an entry to the lead's timeline. Call inside the same transaction as the change it describes. */
export function recordActivity(db: Db, a: ActivityInput) {
  return db.leadActivity.create({
    data: {
      organizationId: a.organizationId,
      leadId: a.leadId,
      type: a.type,
      actorType: a.actorType,
      actorUserId: a.actorUserId ?? null,
      payload: a.payload ?? {},
      occurredAt: a.occurredAt ?? new Date(),
    },
  });
}
