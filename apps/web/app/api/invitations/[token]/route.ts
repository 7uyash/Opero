import { NextResponse } from "next/server";
import { previewInvitation } from "@lfm/core";
import { publicRoute } from "@/lib/api";

export const GET = publicRoute<{ token: string }>(async (_req, { params }) => {
  const { token } = await params;
  return NextResponse.json(await previewInvitation(token));
});
