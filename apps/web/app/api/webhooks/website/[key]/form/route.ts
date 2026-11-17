import { NextResponse, type NextRequest } from "next/server";
import { AppError, MemoryRateLimitStore, RateLimiter, checkBrowserSubmission, findWebsiteForm, ingestWebsiteSubmission, websiteSettings } from "@lfm/core";
import { errorResponse } from "@/lib/api";
import { kickLeadMessages } from "@/lib/kick";
import { appBaseUrl } from "@/lib/urls";
import { clientIp, corsHeaders, readFormFields } from "@/lib/webhook";


// Spam protection for the public form: per visitor and per form.
const perIp = new RateLimiter(new MemoryRateLimitStore(), 10, 10 * 60_000);
const perForm = new RateLimiter(new MemoryRateLimitStore(), 300, 10 * 60_000);

/**
 * Browser submissions from the hosted form or the HTML snippet. Can't be signed (a secret in the
 * page would be public), so: origin allow-list, honeypot, minimum fill time, rate limits, and the
 * lead is marked "unverified".
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  const origin = req.headers.get("origin");
  const headers = corsHeaders(origin);
  try {
    const { key } = await params;
    const form = await findWebsiteForm(key);
    if (!form) throw new AppError("NOT_FOUND", "This form is no longer accepting submissions.", 404);
    const ip = clientIp(req) ?? "unknown";
    const [a, b] = await Promise.all([perIp.check(`${key}:${ip}`), perForm.check(key)]);
    if (!a.allowed || !b.allowed) throw new AppError("RATE_LIMITED", "Too many submissions. Please try again later.", 429);

    const fields = await readFormFields(req);
    const verdict = checkBrowserSubmission(form, { origin, fields }, new URL(appBaseUrl(req)).origin);
    const settings = websiteSettings(form);
    // Bots get the same friendly answer as people, so they can't tell they were caught.
    if (verdict.spam) return NextResponse.json({ ok: true, message: settings.successMessage }, { status: 201, headers });

    const res = await ingestWebsiteSubmission(form, {
      fields,
      verified: false,
      ip,
      origin,
      userAgent: req.headers.get("user-agent"),
      idempotencyKey: typeof fields.submission_id === "string" ? fields.submission_id : null,
    });
    if (res.leadId) await kickLeadMessages(res.leadId);
    return NextResponse.json({ ok: true, message: settings.successMessage }, { status: 201, headers });
  } catch (err) {
    const res = errorResponse(err);
    for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
    return res;
  }
}

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req.headers.get("origin")) });
}
