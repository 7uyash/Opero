import "server-only";
import { prisma } from "@lfm/db";
import { tryEnqueueMessage } from "@lfm/queue";

/**
 * After a request queued messages (acknowledgement, manual send, retry), hand the ready ones to the
 * worker immediately. Best effort: if Redis is down, the worker's sweep still sends them.
 */
export async function kickLeadMessages(leadId: string) {
  const ready = await prisma.message.findMany({
    where: { leadId, direction: "OUTBOUND", status: "QUEUED", OR: [{ scheduledFor: null }, { scheduledFor: { lte: new Date() } }] },
    select: { id: true, attempts: true },
    take: 20,
  });
  await Promise.all(ready.map((m) => tryEnqueueMessage(m)));
}
