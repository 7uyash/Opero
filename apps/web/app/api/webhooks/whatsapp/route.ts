import { NextResponse, type NextRequest } from "next/server";
import { AppError, processWhatsAppWebhook, verifyMetaChallenge, verifyMetaSignature, type WhatsAppWebhook } from "@lfm/core";
import { webhookRoute } from "@/lib/webhook";

/** Meta's subscription check: echo hub.challenge when the verify token matches. */
export async function GET(req: NextRequest) {
  const challenge = verifyMetaChallenge(req.nextUrl.searchParams);
  if (challenge === null) return new NextResponse("Forbidden", { status: 403 });
  return new NextResponse(challenge, { status: 200, headers: { "Content-Type": "text/plain" } });
}

/**
 * WhatsApp Business webhooks: incoming messages and delivery receipts. Every request must carry a
 * valid X-Hub-Signature-256 for the app secret. Each event is idempotent, so Meta's retries are safe.
 */
export const POST = webhookRoute("whatsapp", async (req) => {
  const raw = await req.text();
  if (!verifyMetaSignature(raw, req.headers.get("x-hub-signature-256"))) throw new AppError("INVALID_SIGNATURE", "Invalid signature.", 401);
  const result = await processWhatsAppWebhook(JSON.parse(raw) as WhatsAppWebhook);
  return NextResponse.json({ ok: true, ...result });
});
