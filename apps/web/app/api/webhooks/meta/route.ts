import { NextResponse, type NextRequest } from "next/server";
import { AppError, processMetaLeadgenWebhook, verifyMetaChallenge, verifyMetaSignature, type MetaLeadgenWebhook } from "@lfm/core";
import { webhookRoute } from "@/lib/webhook";

export async function GET(req: NextRequest) {
  const challenge = verifyMetaChallenge(req.nextUrl.searchParams);
  if (challenge === null) return new NextResponse("Forbidden", { status: 403 });
  return new NextResponse(challenge, { status: 200, headers: { "Content-Type": "text/plain" } });
}

/**
 * Facebook Page `leadgen` webhooks (Facebook & Instagram lead ads). If fetching a lead fails the
 * route answers 5xx so Meta retries; ingestion is idempotent per leadgen id.
 */
export const POST = webhookRoute("meta", async (req) => {
  const raw = await req.text();
  if (!verifyMetaSignature(raw, req.headers.get("x-hub-signature-256"))) throw new AppError("INVALID_SIGNATURE", "Invalid signature.", 401);
  const result = await processMetaLeadgenWebhook(JSON.parse(raw) as MetaLeadgenWebhook);
  return NextResponse.json({ ok: true, ...result });
});
