import { NextResponse } from "next/server";
import { Errors, listMyOrganizations } from "@lfm/core";
import { prisma } from "@lfm/db";
import { publicRoute } from "@/lib/api";
import { getAuth } from "@/lib/session";

export const GET = publicRoute(async () => {
  const auth = await getAuth();
  if (!auth) throw Errors.unauthenticated();
  const organization = auth.ctx
    ? await prisma.organization.findUnique({
        where: { id: auth.ctx.organizationId },
        select: { id: true, name: true, timezone: true },
      })
    : null;
  return NextResponse.json({
    user: auth.session.user,
    membership: auth.ctx ? { id: auth.ctx.memberId, role: auth.ctx.role } : null,
    organization,
    organizations: await listMyOrganizations(auth.session.user.id),
  });
});
