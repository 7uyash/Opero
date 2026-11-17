import { prisma, type Integration } from "@lfm/db";
import { hubspotConnectSchema, type HubSpotConnectInput } from "@lfm/shared";
import { audit } from "../audit/audit";
import { encryptJson } from "../crypto/encryption";
import { Errors } from "../errors";
import { ingestLead } from "../intake/ingest";
import { logger } from "../logger";
import { assertPermission, type OrgContext } from "../tenancy/context";
import { providerFetch } from "./http";
import { integrationView, markIntegrationError, readCredentials } from "./service";

/**
 * HubSpot CRM import (private app token with crm.objects.contacts.read).
 * Contacts *created after the connection* are imported as leads, so connecting never floods the
 * team (or customers) with years of old contacts. One lead per HubSpot contact id.
 */

type Creds = { accessToken: string };
type Config = { syncEveryMinutes: number; importCreatedAfter: string; lastSyncAt?: string; lastCursor?: string; portalId?: number };
type Contact = { id: string; properties: Record<string, string | null>; createdAt: string };

const base = () => (process.env.HUBSPOT_API_URL ?? "https://api.hubapi.com").replace(/\/$/, "");
const auth = (c: Creds) => ({ Authorization: `Bearer ${c.accessToken}` });

async function testToken(creds: Creds) {
  try {
    await providerFetch(`${base()}/crm/v3/objects/contacts?limit=1`, { headers: auth(creds), label: "HubSpot" });
    const info = await providerFetch<{ portalId?: number }>(`${base()}/account-info/v3/details`, { headers: auth(creds), label: "HubSpot" }).catch(() => ({ portalId: undefined }));
    return { ok: true as const, portalId: info.portalId };
  } catch (err) {
    return { ok: false as const, error: (err as Error).message };
  }
}

export async function connectHubSpot(ctx: OrgContext, raw: HubSpotConnectInput, ip?: string | null) {
  assertPermission(ctx, "integrations:manage");
  const input = hubspotConnectSchema.parse(raw);
  const existing = await prisma.integration.findFirst({ where: { organizationId: ctx.organizationId, provider: "HUBSPOT" } });
  const token = input.accessToken || (existing?.encryptedCredentials ? readCredentials<Creds>(existing).accessToken : undefined);
  if (!token) throw Errors.validation("Paste the access token.", { accessToken: "Required" });
  const t = await testToken({ accessToken: token });
  const prev = (existing?.config ?? {}) as Partial<Config>;
  const now = new Date();
  const config: Config = {
    syncEveryMinutes: input.syncEveryMinutes,
    importCreatedAfter: prev.importCreatedAfter ?? now.toISOString(),
    lastSyncAt: prev.lastSyncAt,
    portalId: t.ok ? t.portalId : prev.portalId,
  };
  const data = {
    name: "HubSpot CRM",
    config,
    encryptedCredentials: encryptJson({ accessToken: token }),
    status: t.ok ? ("CONNECTED" as const) : ("ERROR" as const),
    lastError: t.ok ? null : t.error,
    lastTestedAt: now,
    connectedAt: t.ok ? (existing?.connectedAt ?? now) : (existing?.connectedAt ?? null),
  };
  const integration = existing
    ? await prisma.integration.update({ where: { id: existing.id }, data })
    : await prisma.integration.create({ data: { organizationId: ctx.organizationId, provider: "HUBSPOT", ...data } });
  await audit({ organizationId: ctx.organizationId, actorUserId: ctx.userId, action: t.ok ? "integration.connected" : "integration.connect_failed", targetType: "integration", targetId: integration.id, ip, metadata: { provider: "HUBSPOT" } });
  return { integration: integrationView(integration), test: t.ok ? { ok: true as const, detail: "Connected to HubSpot" } : { ok: false as const, error: t.error } };
}

const PROPS = ["firstname", "lastname", "email", "phone", "mobilephone", "company", "message", "hs_lead_status", "lifecyclestage", "createdate"];

/** Imports contacts created since the last sync. Safe to run concurrently and repeatedly. */
export async function syncHubSpot(integration: Integration) {
  const creds = readCredentials<Creds>(integration);
  const cfg = integration.config as Config;
  const since = cfg.lastSyncAt ?? cfg.importCreatedAfter;
  const started = new Date();
  let after: string | undefined;
  let imported = 0;
  let newestCreated = since;
  try {
    for (let page = 0; page < 20; page++) {
      const res = await providerFetch<{ results: Contact[]; paging?: { next?: { after: string } } }>(`${base()}/crm/v3/objects/contacts/search`, {
        method: "POST",
        headers: auth(creds),
        label: "HubSpot",
        body: {
          filterGroups: [{ filters: [{ propertyName: "createdate", operator: "GTE", value: String(new Date(since).getTime()) }] }],
          sorts: [{ propertyName: "createdate", direction: "ASCENDING" }],
          properties: PROPS,
          limit: 100,
          ...(after ? { after } : {}),
        },
      });
      for (const c of res.results) {
        const p = c.properties;
        const r = await ingestLead({
          integration,
          sourceType: "CRM",
          externalEventId: `hubspot-contact:${c.id}`,
          eventType: "hubspot.contact",
          raw: {
            name: [p.firstname, p.lastname].filter(Boolean).join(" ") || null,
            email: p.email,
            phone: p.phone ?? p.mobilephone,
            company: p.company,
            inquiry: p.message,
          },
          metadata: { hubspotId: c.id, portalId: cfg.portalId ?? null, lifecycleStage: p.lifecyclestage ?? null, leadStatus: p.hs_lead_status ?? null },
        }).catch((err) => {
          // A contact without email/phone can't become a lead; skip it rather than block the sync.
          logger.warn({ contactId: c.id, err: (err as Error).message }, "hubspot contact skipped");
          return null;
        });
        if (r && r.outcome !== "duplicate_event") imported++;
        if (c.properties.createdate && c.properties.createdate > newestCreated) newestCreated = c.properties.createdate;
      }
      after = res.paging?.next?.after;
      if (!after) break;
    }
    await prisma.integration.update({
      where: { id: integration.id },
      // Re-scan from the newest contact seen; duplicates are skipped by the event id.
      data: { config: { ...cfg, lastSyncAt: newestCreated > since ? newestCreated : started.toISOString() }, lastError: null, status: "CONNECTED", lastTestedAt: new Date() },
    });
    return { imported };
  } catch (err) {
    const msg = (err as Error).message;
    if ((err as { code?: string }).code === "EAUTH") await markIntegrationError(prisma, integration.id, msg);
    else await prisma.integration.update({ where: { id: integration.id }, data: { lastError: msg } });
    throw err;
  }
}

export async function syncHubSpotNow(ctx: OrgContext, id: string) {
  assertPermission(ctx, "integrations:manage");
  const i = await prisma.integration.findFirst({ where: { id, organizationId: ctx.organizationId, provider: "HUBSPOT" } });
  if (!i) throw Errors.notFound("Connection");
  if (i.status !== "CONNECTED") throw Errors.validation("Connect HubSpot first.");
  return syncHubSpot(i);
}

/** Worker: syncs every connected HubSpot account whose interval has passed. */
export async function syncDueHubSpotIntegrations(now = new Date()) {
  const list = await prisma.integration.findMany({ where: { provider: "HUBSPOT", status: "CONNECTED" } });
  let imported = 0;
  for (const i of list) {
    const cfg = i.config as Config;
    const last = i.lastTestedAt?.getTime() ?? 0;
    if (now.getTime() - last < (cfg.syncEveryMinutes ?? 15) * 60_000) continue;
    try {
      imported += (await syncHubSpot(i)).imported;
    } catch (err) {
      logger.warn({ integrationId: i.id, err: (err as Error).message }, "hubspot sync failed");
    }
  }
  return imported;
}
