import MailComposer from "nodemailer/lib/mail-composer";
import { prisma, type Integration } from "@lfm/db";
import { audit } from "../audit/audit";
import { encryptJson } from "../crypto/encryption";
import { Errors } from "../errors";
import { ingestLead } from "../intake/ingest";
import { logger } from "../logger";
import { recordInboundMessage } from "../messaging/inbound";
import { assertPermission, type OrgContext } from "../tenancy/context";
import { providerFetch } from "./http";
import { createOAuthState, missingEnv, oauthRedirectUri, verifyOAuthState } from "./oauth-state";
import { integrationView, markIntegrationError, readCredentials } from "./service";
import { ProviderError, type ChannelAdapter, type TestResult } from "./types";

/**
 * Gmail / Google Workspace via OAuth and the Gmail API.
 * Sends as the connected address and polls the inbox (history API) for customer replies and,
 * optionally, brand-new inquiries. gmail.send/gmail.readonly are "restricted" scopes: a public
 * deployment needs Google's OAuth verification; internal Workspace apps don't.
 */

export const GMAIL_SCOPES = ["openid", "email", "https://www.googleapis.com/auth/gmail.send", "https://www.googleapis.com/auth/gmail.readonly"];
export const GMAIL_REQUIRED_ENV = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"] as const;

export type GmailCreds = { accessToken: string; refreshToken: string; expiresAt: number };
export type GmailConfig = { email: string; historyId?: string; createLeadsFromNewEmails: boolean; lastPolledAt?: string };

const api = () => (process.env.GMAIL_API_URL ?? "https://gmail.googleapis.com/gmail/v1").replace(/\/$/, "");
const tokenUrl = () => process.env.GOOGLE_TOKEN_URL ?? "https://oauth2.googleapis.com/token";

export function gmailAuthUrl(ctx: OrgContext) {
  assertPermission(ctx, "integrations:manage");
  const missing = missingEnv(GMAIL_REQUIRED_ENV);
  if (missing.length) throw Errors.validation(`Google sign-in isn't set up on this server yet (missing ${missing.join(", ")}).`);
  const p = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID!,
    redirect_uri: oauthRedirectUri("gmail"),
    response_type: "code",
    scope: GMAIL_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state: createOAuthState(ctx.organizationId, ctx.userId, "gmail"),
  });
  return `${process.env.GOOGLE_AUTH_URL ?? "https://accounts.google.com/o/oauth2/v2/auth"}?${p}`;
}

export async function completeGmailOAuth(ctx: OrgContext, params: { code: string | null; state: string | null; error?: string | null }, ip?: string | null) {
  const { organizationId } = verifyOAuthState(params.state, { userId: ctx.userId, provider: "gmail" });
  if (organizationId !== ctx.organizationId) throw Errors.forbidden("Switch to the business you started connecting from.");
  if (params.error || !params.code) throw Errors.validation("Google connection was cancelled.");
  const tok = await providerFetch<{ access_token: string; refresh_token?: string; expires_in: number }>(tokenUrl(), {
    form: {
      code: params.code,
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: oauthRedirectUri("gmail"),
      grant_type: "authorization_code",
    },
    label: "Google",
  });
  if (!tok.refresh_token) throw Errors.validation("Google didn't grant offline access. Remove the app from your Google Account permissions and connect again.");
  const creds: GmailCreds = { accessToken: tok.access_token, refreshToken: tok.refresh_token, expiresAt: Date.now() + tok.expires_in * 1000 };
  const profile = await providerFetch<{ emailAddress: string; historyId: string }>(`${api()}/users/me/profile`, { headers: { Authorization: `Bearer ${creds.accessToken}` }, label: "Gmail" });
  const existing = await prisma.integration.findFirst({ where: { organizationId, provider: "GMAIL" } });
  const prev = (existing?.config ?? {}) as Partial<GmailConfig>;
  const config: GmailConfig = { email: profile.emailAddress, historyId: profile.historyId, createLeadsFromNewEmails: prev.createLeadsFromNewEmails ?? false };
  const now = new Date();
  const data = { name: `Gmail (${profile.emailAddress})`, config, encryptedCredentials: encryptJson(creds), status: "CONNECTED" as const, lastError: null, lastTestedAt: now, connectedAt: now };
  const integration = existing
    ? await prisma.integration.update({ where: { id: existing.id }, data })
    : await prisma.integration.create({ data: { organizationId, provider: "GMAIL", ...data } });
  await audit({ organizationId, actorUserId: ctx.userId, action: "integration.connected", targetType: "integration", targetId: integration.id, ip, metadata: { provider: "GMAIL", email: profile.emailAddress } });
  return integrationView(integration);
}

/** Returns a valid access token, refreshing (and saving) it when it's about to expire. */
async function accessToken(i: Integration, force = false): Promise<string> {
  const creds = readCredentials<GmailCreds>(i);
  if (!force && creds.expiresAt > Date.now() + 60_000) return creds.accessToken;
  try {
    const tok = await providerFetch<{ access_token: string; expires_in: number }>(tokenUrl(), {
      form: { client_id: process.env.GOOGLE_CLIENT_ID ?? "", client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "", refresh_token: creds.refreshToken, grant_type: "refresh_token" },
      label: "Google",
    });
    const next: GmailCreds = { ...creds, accessToken: tok.access_token, expiresAt: Date.now() + tok.expires_in * 1000 };
    await prisma.integration.update({ where: { id: i.id }, data: { encryptedCredentials: encryptJson(next) } });
    i.encryptedCredentials = encryptJson(next);
    return next.accessToken;
  } catch (err) {
    // invalid_grant = access revoked by the user.
    if (err instanceof ProviderError && err.kind === "permanent") {
      await markIntegrationError(prisma, i.id, "Google access was revoked or expired. Reconnect Gmail.");
      throw new ProviderError("Google access was revoked or expired. Reconnect Gmail.", "permanent", "EAUTH");
    }
    throw err;
  }
}

async function gmailCall<T>(i: Integration, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const call = async (token: string) => providerFetch<T>(`${api()}${path}`, { ...init, headers: { Authorization: `Bearer ${token}` }, label: "Gmail" });
  try {
    return await call(await accessToken(i));
  } catch (err) {
    if (err instanceof ProviderError && err.code === "EAUTH") return call(await accessToken(i, true));
    throw err;
  }
}

/** Builds the RFC 822 message Gmail expects (base64url). */
export async function buildRawEmail(m: { from: string; fromName?: string; to: string; subject: string; text: string; html?: string; messageId: string; headers?: Record<string, string> }) {
  const domain = m.from.split("@")[1] ?? "localhost";
  const mail = new MailComposer({
    from: m.fromName ? { name: m.fromName, address: m.from } : m.from,
    to: m.to,
    subject: m.subject,
    text: m.text,
    html: m.html,
    messageId: `<${m.messageId}@${domain}>`,
    headers: m.headers,
  });
  const buf: Buffer = await new Promise((resolve, reject) => mail.compile().build((err, b) => (err ? reject(err) : resolve(b))));
  return buf.toString("base64url");
}

/** Gmail as a sending channel. The adapter receives the integration row so it can refresh tokens. */
export function gmailAdapterFor(i: Integration): ChannelAdapter<GmailCreds, GmailConfig> {
  return {
    provider: "GMAIL",
    channel: "EMAIL",
    async test(): Promise<TestResult> {
      try {
        const p = await gmailCall<{ emailAddress: string }>(i, "/users/me/profile");
        return { ok: true, detail: `Connected as ${p.emailAddress}` };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },
    async send(_creds, config, msg) {
      const org = await prisma.organization.findUniqueOrThrow({ where: { id: i.organizationId }, select: { name: true } });
      const raw = await buildRawEmail({ from: config.email, fromName: org.name, to: msg.to, subject: msg.subject ?? "", text: msg.text, html: msg.html, messageId: msg.messageId, headers: msg.headers });
      const r = await gmailCall<{ id: string }>(i, "/users/me/messages/send", { method: "POST", body: { raw } });
      return { providerMessageId: r.id };
    },
  };
}

export async function updateGmailSettings(ctx: OrgContext, id: string, createLeadsFromNewEmails: boolean) {
  assertPermission(ctx, "integrations:manage");
  const i = await prisma.integration.findFirst({ where: { id, organizationId: ctx.organizationId, provider: "GMAIL" } });
  if (!i) throw Errors.notFound("Gmail connection");
  return integrationView(await prisma.integration.update({ where: { id }, data: { config: { ...(i.config as object), createLeadsFromNewEmails } } }));
}

// ───────────────────────────── Inbox polling ─────────────────────────────

type GmailHeader = { name: string; value: string };
type GmailPart = { mimeType?: string; body?: { data?: string }; parts?: GmailPart[]; headers?: GmailHeader[] };
type GmailMessage = { id: string; threadId: string; labelIds?: string[]; internalDate?: string; snippet?: string; payload?: GmailPart & { headers?: GmailHeader[] } };

const header = (m: GmailMessage, name: string) => m.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? null;

export function extractPlainText(part: GmailPart | undefined): string {
  if (!part) return "";
  if (part.mimeType === "text/plain" && part.body?.data) return Buffer.from(part.body.data, "base64url").toString("utf8");
  for (const p of part.parts ?? []) {
    const t = extractPlainText(p);
    if (t) return t;
  }
  if (part.mimeType === "text/html" && part.body?.data) {
    return Buffer.from(part.body.data, "base64url").toString("utf8").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }
  return "";
}

/** Drops the quoted original ("On … wrote:" / "> …") so the timeline shows what the customer wrote. */
export function stripQuotedReply(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const cut = lines.findIndex((l) => /^On .+wrote:\s*$/.test(l.trim()) || /^-{2,}\s*Original Message/i.test(l.trim()) || /^From: .+/.test(l.trim()));
  const kept = (cut >= 0 ? lines.slice(0, cut) : lines).filter((l) => !l.startsWith(">"));
  return kept.join("\n").trim();
}

/** Our outbound Message-IDs look like <messageId@domain>; In-Reply-To lets us find the exact lead. */
export function ourMessageIdFrom(inReplyTo: string | null): string | null {
  const m = inReplyTo?.match(/<([a-z0-9]{20,40})@/i);
  return m?.[1] ?? null;
}

export function parseFromHeader(v: string | null): { email: string | null; name: string | null } {
  if (!v) return { email: null, name: null };
  const m = v.match(/^\s*"?([^"<]*)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1]!.trim() || null, email: m[2]!.trim().toLowerCase() };
  return { name: null, email: v.trim().toLowerCase() };
}

export async function pollGmail(i: Integration) {
  const cfg = i.config as GmailConfig;
  const result = { replies: 0, newLeads: 0 };
  let historyId = cfg.historyId;
  if (!historyId) {
    historyId = (await gmailCall<{ historyId: string }>(i, "/users/me/profile")).historyId;
  } else {
    let pageToken: string | undefined;
    let latest = historyId;
    try {
      do {
        const h = await gmailCall<{ history?: { messagesAdded?: { message: { id: string; labelIds?: string[] } }[] }[]; historyId: string; nextPageToken?: string }>(
          i,
          `/users/me/history?startHistoryId=${historyId}&historyTypes=messageAdded&labelId=INBOX${pageToken ? `&pageToken=${pageToken}` : ""}`,
        );
        latest = h.historyId ?? latest;
        for (const rec of h.history ?? []) {
          for (const added of rec.messagesAdded ?? []) {
            if (!(added.message.labelIds ?? ["INBOX"]).includes("INBOX")) continue;
            const r = await handleGmailMessage(i, cfg, added.message.id);
            if (r === "reply") result.replies++;
            if (r === "new_lead") result.newLeads++;
          }
        }
        pageToken = h.nextPageToken;
      } while (pageToken);
      historyId = latest;
    } catch (err) {
      // History older than ~a week is gone (404): restart from the current point.
      if (err instanceof ProviderError && err.code === "404") historyId = (await gmailCall<{ historyId: string }>(i, "/users/me/profile")).historyId;
      else throw err;
    }
  }
  await prisma.integration.update({ where: { id: i.id }, data: { config: { ...cfg, historyId, lastPolledAt: new Date().toISOString() } } });
  return result;
}

async function handleGmailMessage(i: Integration, cfg: GmailConfig, id: string) {
  const m = await gmailCall<GmailMessage>(i, `/users/me/messages/${id}?format=full`);
  const from = parseFromHeader(header(m, "From"));
  if (!from.email || from.email === cfg.email.toLowerCase()) return "skipped";
  if (/^(mailer-daemon|postmaster|no-?reply)@/i.test(from.email)) return "skipped";
  const subject = header(m, "Subject");
  const body = stripQuotedReply(extractPlainText(m.payload)) || m.snippet || "";
  const receivedAt = m.internalDate ? new Date(Number(m.internalDate)) : new Date();
  const reply = await recordInboundMessage({
    organizationId: i.organizationId,
    channel: "EMAIL",
    from: from.email,
    subject,
    body,
    providerMessageId: `gmail:${m.id}`,
    externalThreadId: m.threadId,
    receivedAt,
    inReplyToMessageId: ourMessageIdFrom(header(m, "In-Reply-To")),
  });
  if (reply) return reply.duplicate ? "skipped" : "reply";
  if (!cfg.createLeadsFromNewEmails) return "skipped";
  const r = await ingestLead({
    integration: i,
    sourceType: "EMAIL",
    externalEventId: `gmail:${m.id}`,
    eventType: "gmail.message",
    raw: { name: from.name, email: from.email, subject, inquiry: body },
    metadata: { gmailId: m.id, threadId: m.threadId },
  });
  return r.outcome === "duplicate_event" ? "skipped" : "new_lead";
}

/** Worker: polls every connected Gmail inbox at most once a minute. */
export async function pollDueGmailIntegrations(now = new Date(), everyMs = 60_000) {
  const list = await prisma.integration.findMany({ where: { provider: "GMAIL", status: "CONNECTED" } });
  const total = { replies: 0, newLeads: 0 };
  for (const i of list) {
    const last = Date.parse((i.config as GmailConfig).lastPolledAt ?? "") || 0;
    if (now.getTime() - last < everyMs) continue;
    try {
      const r = await pollGmail(i);
      total.replies += r.replies;
      total.newLeads += r.newLeads;
    } catch (err) {
      logger.warn({ integrationId: i.id, err: (err as Error).message }, "gmail poll failed");
    }
  }
  return total;
}
