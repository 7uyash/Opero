import { NextResponse } from "next/server";
import { revokeInvitation } from "@lfm/core";
import { clientMeta, orgRoute } from "@/lib/api";

export const DELETE = orgRoute<{ id: string }>("members:manage", async (req, ctx, { params }) => {
  const { id } = await params;
  await revokeInvitation(ctx, id, clientMeta(req).ip);
  return NextResponse.json({ ok: true });
});
