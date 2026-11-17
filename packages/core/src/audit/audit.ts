import { prisma, type Db, type Prisma } from "@lfm/db";

export type AuditEntry = {
  organizationId?: string | null;
  actorUserId?: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  ip?: string | null;
  metadata?: Prisma.InputJsonValue;
};

/** Records a security/administrative event. Never put secrets in metadata. */
export async function audit(entry: AuditEntry, db: Db = prisma): Promise<void> {
  await db.auditLog.create({
    data: {
      organizationId: entry.organizationId ?? null,
      actorUserId: entry.actorUserId ?? null,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      ip: entry.ip ?? null,
      metadata: entry.metadata ?? {},
    },
  });
}
