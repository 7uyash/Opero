import { prisma, type Integration } from "@lfm/db";
import { metaSelectPageSchema } from "@lfm/shared";
import { audit } from "../audit/audit";
import { encryptJson } from "../crypto/encryption";
import { Errors } from "../errors";
import { ingestLead, mapFormFields } from "../intake/ingest";
import { assertPermission, type OrgContext } from "../tenancy/context";
import { providerFetch } from "./http";
import { graphBase } from "./meta-common";
import { createOAuthState, missingEnv, oauthRedirectUri, verifyOAuthState } from "./oauth-state";
import { integrationView, readCredentials } from "./service";

/**
 * Facebook & Instagram lead ads (Meta Lead Ads). Instagram lead ads are delivered through the
 * linked Facebook Page, so one Page connection covers both.
 *
 * Flow: Meta OAuth → list the Pages the user manages → business picks one → we subscribe the Page
 * to `leadgen` webhooks → each new lead triggers a webhook → we fetch the lead's answers.
 * Requires a Meta app with the leads_retrieval permission approved through App Review.
 */

export const META_SCOPES = ["pages_show_list", "pages_read_engagement", "pages_manage_metadata", "leads_retrieval", "business_management"];
export const META_REQUIRED_ENV = ["META_APP_ID", "META_APP_SECRET", "WHATSAPP_WEBHOOK_VERIFY_TOKEN"] as const;

type Page = { id: string; name: string; access_token: string };
type MetaCreds = { userToken: string; pages: Page[] };

export function metaAuthUrl(ctx: OrgContext) {
  assertPermission(ctx, "integrations:manage");
  const missing = missingEnv(META_REQUIRED_ENV);
  if (missing.length) throw Errors.validation(`Facebook isn't set up on this server yet (missing ${missing.join(", ")}).`);
  const host = (process.env.META_DIALOG_URL ?? "https://www.facebook.com").replace(/\/$/, "");
  const p = new URLSearchParams({
    client_id: process.env.META_APP_ID!,
    redirect_uri: oauthRedirectUri("meta"),
    state: createOAuthState(ctx.organizationId, ctx.userId, "meta"),
    scope: META_SCOPES.join(","),
    response_type: "code",
  });
  return `${host}/${process.env.META_GRAPH_VERSION ?? "v23.0"}/dialog/oauth?${p}`;
}

/** OAuth callback: exchanges the code, gets a long-lived token and the user's Pages. */
export async function completeMetaOAuth(ctx: OrgContext, params: { code: string | null; state: string | null; error?: string | null }) {
  const { organizationId } = verifyOAuthState(params.state, { userId: ctx.userId, provider: "meta" });
  if (organizationId !== ctx.organizationId) throw Errors.forbidden("Switch to the business you started connecting from.");
  if (params.error || !params.code) throw Errors.validation("Facebook connection was cancelled.");
  const base = graphBase();
  const short = await providerFetch<{ access_token: string }>(
    `${base}/oauth/access_token?${new URLSearchParams({ client_id: process.env.META_APP_ID!, client_secret: process.env.META_APP_SECRET!, redirect_uri: oauthRedirectUri("meta"), code: params.code })}`,
    { label: "Facebook" },
  );
  const long = await providerFetch<{ access_token: string }>(
    `${base}/oauth/access_token?${new URLSearchParams({ grant_type: "fb_exchange_token", client_id: process.env.META_APP_ID!, client_secret: process.env.META_APP_SECRET!, fb_exchange_token: short.access_token })}`,
    { label: "Facebook" },
  );
  const pages = await providerFetch<{ data: Page[] }>(`${base}/me/accounts?fields=id,name,access_token&limit=100&access_token=${encodeURIComponent(long.access_token)}`, { label: "Facebook" });
  const creds: MetaCreds = { userToken: long.access_token, pages: pages.data };
  const existing = await prisma.integration.findFirst({ where: { organizationId, provider: "META_LEAD_ADS" } });
  const data = {
    name: "Facebook & Instagram lead forms",
    encryptedCredentials: encryptJson(creds),
    // Not connected until a Page is chosen and subscribed.
    status: "PENDING" as const,
    config: { pages: pages.data.map((p) => ({ id: p.id, name: p.name })) },
    lastError: pages.data.length ? null : "No Facebook Pages found for this account. You need to manage a Page that runs lead ads.",
  };
  const integration = existing
    ? await prisma.integration.update({ where: { id: existing.id }, data })
    : await prisma.integration.create({ data: { organizationId, provider: "META_LEAD_ADS", ...data } });
  return integrationView(integration);
}

/** Business picks a Page: subscribe it to lead webhooks, verify, then mark CONNECTED. */
export async function selectMetaPage(ctx: OrgContext, raw: { pageId: string }, ip?: string | null) {
  assertPermission(ctx, "integrations:manage");
  const { pageId } = metaSelectPageSchema.parse(raw);
  const i = await prisma.integration.findFirst({ where: { organizationId: ctx.organizationId, provider: "META_LEAD_ADS" } });
  if (!i?.encryptedCredentials) throw Errors.validation("Connect Facebook first.");
  const creds = readCredentials<MetaCreds>(i);
  const page = creds.pages.find((p) => p.id === pageId);
  if (!page) throw Errors.validation("That Page isn't available for this Facebook account.");
  const clash = await prisma.integration.findFirst({
    where: { provider: "META_LEAD_ADS", status: "CONNECTED", organizationId: { not: ctx.organizationId }, config: { path: ["pageId"], equals: pageId } },
  });
  if (clash) throw Errors.conflict("This Page is already connected to another business.");

  const base = graphBase();
  let error: string | null = null;
  try {
    await providerFetch(`${base}/${pageId}/subscribed_apps?subscribed_fields=leadgen&access_token=${encodeURIComponent(page.access_token)}`, { method: "POST", label: "Facebook" });
    const subs = await providerFetch<{ data: { id: string; subscribed_fields?: string[] }[] }>(`${base}/${pageId}/subscribed_apps?access_token=${encodeURIComponent(page.access_token)}`, { label: "Facebook" });
    const ours = subs.data.find((s) => s.id === process.env.META_APP_ID);
    if (!ours || !(ours.subscribed_fields ?? []).includes("leadgen")) error = "Facebook didn't confirm the lead subscription for this Page.";
  } catch (err) {
    error = (err as Error).message;
  }
  const updated = await prisma.integration.update({
    where: { id: i.id },
    data: {
      name: `Facebook & Instagram — ${page.name}`,
      config: { ...(i.config as object), pageId, pageName: page.name },
      status: error ? "ERROR" : "CONNECTED",
      lastError: error,
      lastTestedAt: new Date(),
      connectedAt: error ? i.connectedAt : new Date(),
    },
  });
  await audit({ organizationId: ctx.organizationId, actorUserId: ctx.userId, action: error ? "integration.connect_failed" : "integration.connected", targetType: "integration", targetId: i.id, ip, metadata: { provider: "META_LEAD_ADS", pageId } });
  return integrationView(updated);
}

// ───────────────────────────── Webhook ─────────────────────────────

export type MetaLeadgenWebhook = {
  object?: string;
  entry?: { id?: string; changes?: { field?: string; value?: { leadgen_id?: string; page_id?: string; form_id?: string; ad_id?: string; created_time?: number } }[] }[];
};

type LeadData = { id: string; created_time?: string; form_id?: string; ad_id?: string; campaign_name?: string; field_data?: { name: string; values: string[] }[] };

/**
 * Processes leadgen notifications: fetch each lead's answers with the Page token and ingest it.
 * Throws on fetch failure so the route answers 5xx and Meta retries; ingestion is idempotent.
 */
export async function processMetaLeadgenWebhook(payload: MetaLeadgenWebhook) {
  const result = { leads: 0, duplicates: 0, ignored: 0 };
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "leadgen" || !change.value?.leadgen_id) continue;
      const pageId = change.value.page_id ?? entry.id;
      const integration = await prisma.integration.findFirst({
        where: { provider: "META_LEAD_ADS", status: { in: ["CONNECTED", "ERROR"] }, config: { path: ["pageId"], equals: pageId } },
      });
      if (!integration) {
        result.ignored++;
        continue;
      }
      const r = await ingestMetaLead(integration, change.value.leadgen_id);
      if (r.outcome === "duplicate_event") result.duplicates++;
      else result.leads++;
    }
  }
  return result;
}

async function ingestMetaLead(integration: Integration, leadgenId: string) {
  const prior = await prisma.inboundEvent.findUnique({ where: { integrationId_externalEventId: { integrationId: integration.id, externalEventId: `leadgen:${leadgenId}` } } });
  if (prior) return { outcome: "duplicate_event" as const, leadId: prior.leadId };
  const creds = readCredentials<MetaCreds>(integration);
  const pageId = (integration.config as { pageId?: string }).pageId;
  const page = creds.pages.find((p) => p.id === pageId);
  if (!page) throw new Error("Connected Page token missing");
  const lead = await providerFetch<LeadData>(
    `${graphBase()}/${leadgenId}?fields=id,created_time,form_id,ad_id,campaign_name,field_data&access_token=${encodeURIComponent(page.access_token)}`,
    { label: "Facebook" },
  );
  const fields = Object.fromEntries((lead.field_data ?? []).map((f) => [f.name, f.values.join(", ")]));
  const { contact, extra } = mapFormFields(fields);
  return ingestLead({
    integration,
    sourceType: "META",
    externalEventId: `leadgen:${leadgenId}`,
    eventType: "meta.leadgen",
    raw: { ...contact, subject: contact.subject ?? lead.campaign_name ?? null },
    metadata: { leadgenId, formId: lead.form_id ?? null, adId: lead.ad_id ?? null, campaign: lead.campaign_name ?? null, pageId, fields: extra },
  });
}
