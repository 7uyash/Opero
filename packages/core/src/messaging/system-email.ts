import { prisma } from "@lfm/db";
import { getChannelIntegration, readCredentials } from "../integrations/service";
import { sendSmtpSystemEmail, type SmtpConfig, type SmtpCredentials } from "../integrations/smtp";
import { logger } from "../logger";

/**
 * Emails to team members (notification copies, invitations) through the business's own email
 * connection. Without a connected SMTP account they are simply not sent.
 */
export async function sendTeamEmail(organizationId: string, mail: { to: string; subject: string; text: string }) {
  const integration = await getChannelIntegration(prisma, organizationId, "EMAIL");
  if (!integration || integration.provider !== "SMTP") return { sent: false as const, reason: "No email account connected" };
  try {
    await sendSmtpSystemEmail(readCredentials<SmtpCredentials>(integration), integration.config as SmtpConfig, mail);
    return { sent: true as const };
  } catch (err) {
    return { sent: false as const, reason: (err as Error).message };
  }
}

/** Worker: sends email copies of notifications for members who asked for them. */
export async function sendPendingNotificationEmails(limit = 50) {
  const pending = await prisma.notification.findMany({
    where: { emailPending: true },
    include: { member: { include: { user: { select: { email: true } } } }, organization: { select: { name: true } } },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
  const appUrl = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
  let sent = 0;
  for (const n of pending) {
    // Claim first so concurrent sweeps can't email twice.
    const claimed = await prisma.notification.updateMany({ where: { id: n.id, emailPending: true }, data: { emailPending: false } });
    if (claimed.count !== 1) continue;
    const link = n.leadId ? `${appUrl}/leads/${n.leadId}` : `${appUrl}/notifications`;
    const res = await sendTeamEmail(n.organizationId, {
      to: n.member.user.email,
      subject: `[${n.organization.name}] ${n.title}`,
      text: `${n.title}\n${n.body ? `\n${n.body}\n` : ""}\nOpen: ${link}\n\nYou can change which emails you get under Settings → My notifications.`,
    });
    await prisma.notification.update({
      where: { id: n.id },
      data: res.sent ? { emailSentAt: new Date() } : { emailError: res.reason },
    });
    if (res.sent) sent++;
    else logger.debug({ notificationId: n.id, reason: res.reason }, "notification email not sent");
  }
  return sent;
}
