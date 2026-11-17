import { NextResponse } from "next/server";
import { AppError, findWebsiteForm, ingestWebsiteSubmission, verifyWebsiteSignature, websiteSecret } from "@lfm/core";
import { kickLeadMessages } from "@/lib/kick";
import { clientIp, readFormFields, webhookRoute } from "@/lib/webhook";

/**
 * Server-to-server website submissions (your backend, a WordPress plugin, Zapier…).
 * Signed: X-LFM-Timestamp + X-LFM-Signature: sha256=HMAC(secret, "<timestamp>.<raw body>").
 * Optional Idempotency-Key header (or a submission_id field) makes retries safe.
 */
export const POST = webhookRoute<{ key: string }>("website", async (req, { params }) => {
  const { key } = await params;
  const form = await findWebsiteForm(key);
  if (!form) throw new AppError("NOT_FOUND", "Unknown form.", 404);
  const raw = await req.text();
  const check = verifyWebsiteSignature(websiteSecret(form), raw, req.headers.get("x-lfm-timestamp"), req.headers.get("x-lfm-signature"));
  if (!check.ok) throw new AppError("INVALID_SIGNATURE", check.reason, 401);

  const fields = await readFormFields(req, raw);
  const res = await ingestWebsiteSubmission(form, {
    fields,
    verified: true,
    ip: clientIp(req),
    origin: req.headers.get("origin"),
    userAgent: req.headers.get("user-agent"),
    idempotencyKey: req.headers.get("idempotency-key") ?? (typeof fields.submission_id === "string" ? fields.submission_id : null),
  });
  if (res.leadId) await kickLeadMessages(res.leadId);
  return NextResponse.json({ ok: true, leadId: res.leadId, outcome: res.outcome }, { status: res.outcome === "duplicate_event" ? 200 : 201 });
});
