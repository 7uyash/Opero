import { NextResponse } from "next/server";
import { inviteMember, listMembers, sendTeamEmail } from "@lfm/core";
import { ROLE_LABELS } from "@lfm/shared";
import { prisma } from "@lfm/db";
import { clientMeta, orgRoute, readJson } from "@/lib/api";
import { invitationUrl } from "@/lib/urls";

export const GET = orgRoute("members:view", async (_req, ctx) => NextResponse.json(await listMembers(ctx)));

export const POST = orgRoute("members:manage", async (req, ctx) => {
  const { invitation, token } = await inviteMember(ctx, (await readJson(req)) as never, clientMeta(req).ip);
  const inviteUrl = invitationUrl(req, token);

  // Email the invitation through the business's own email account, if one is connected.
  const [org, inviter] = await Promise.all([
    prisma.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { name: true } }),
    prisma.user.findUniqueOrThrow({ where: { id: ctx.userId }, select: { name: true } }),
  ]);
  const email = await sendTeamEmail(ctx.organizationId, {
    to: invitation.email,
    subject: `${inviter.name} invited you to ${org.name}`,
    text:
      `Hi${invitation.name ? ` ${invitation.name}` : ""},\n\n${inviter.name} has invited you to join ${org.name} on Lead & Follow-up Manager ` +
      `as ${ROLE_LABELS[invitation.role]}.\n\nAccept the invitation: ${inviteUrl}\n\nThis link works once and expires in 7 days.`,
  });

  // The link is returned once so the inviter can share it; it is not retrievable later.
  return NextResponse.json(
    {
      invitation: { id: invitation.id, email: invitation.email, role: invitation.role, expiresAt: invitation.expiresAt },
      inviteUrl,
      emailSent: email.sent,
      emailError: email.sent ? null : email.reason,
    },
    { status: 201 },
  );
});
