import { NextResponse } from "next/server";
import { resolveNotificationPrefs, updateMyMembership } from "@lfm/core";
import { prisma } from "@lfm/db";
import { orgRoute, readJson } from "@/lib/api";

function view(m: { id: string; role: string; isAvailable: boolean; unavailableUntil: Date | null; notificationPrefs: unknown }) {
  return {
    id: m.id,
    role: m.role,
    isAvailable: m.isAvailable,
    unavailableUntil: m.unavailableUntil,
    notificationPrefs: resolveNotificationPrefs(m.notificationPrefs),
  };
}

export const GET = orgRoute(null, async (_req, ctx) => {
  const m = await prisma.organizationMember.findUniqueOrThrow({ where: { id: ctx.memberId } });
  return NextResponse.json({ membership: view(m) });
});

export const PATCH = orgRoute(null, async (req, ctx) => {
  const m = await updateMyMembership(ctx, (await readJson(req)) as never);
  return NextResponse.json({ membership: view(m) });
});
