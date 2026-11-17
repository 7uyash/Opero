import { NextResponse } from "next/server";
import { updateMember } from "@lfm/core";
import { clientMeta, orgRoute, readJson } from "@/lib/api";

export const PATCH = orgRoute<{ id: string }>(null, async (req, ctx, { params }) => {
  const { id } = await params;
  const m = await updateMember(ctx, id, (await readJson(req)) as never, clientMeta(req).ip);
  return NextResponse.json({
    member: {
      id: m.id,
      name: m.user.name,
      email: m.user.email,
      role: m.role,
      status: m.status,
      receivesLeads: m.receivesLeads,
      isAvailable: m.isAvailable,
      unavailableUntil: m.unavailableUntil,
      isFallbackManager: m.isFallbackManager,
    },
    redistributed: m.redistributed,
  });
});
