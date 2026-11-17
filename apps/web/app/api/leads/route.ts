import { NextResponse } from "next/server";
import { createLead, listLeads } from "@lfm/core";
import { orgRoute, readJson } from "@/lib/api";
import { kickLeadMessages } from "@/lib/kick";

export const GET = orgRoute("leads:view_assigned", async (req, ctx) => {
  const sp = req.nextUrl.searchParams;
  const query: Record<string, string> = {};
  for (const [k, v] of sp) query[k] = v;
  return NextResponse.json(await listLeads(ctx, query));
});

export const POST = orgRoute("leads:create", async (req, ctx) => {
  const { lead, outcome } = await createLead(ctx, (await readJson(req)) as never);
  // Send the automatic acknowledgement (if any) right away instead of waiting for the next sweep.
  await kickLeadMessages(lead.id);
  return NextResponse.json({ lead: { id: lead.id, status: lead.status }, outcome }, { status: outcome === "merged" ? 200 : 201 });
});
