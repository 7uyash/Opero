import { prisma, type Channel, type Integration, type Lead, type Prisma, type SourceType, type Tx } from "@lfm/db";
import { autoAssignLead } from "../assignment/round-robin";
import { ASSIGNMENT_TX } from "../assignment/constants";
import { logExecution } from "../automation/executions";
import { getLeadAutomationSettings } from "../automation/settings";
import { sha256Hex } from "../crypto/tokens";
import { Errors } from "../errors";
import { normalizeContact, type RawContact } from "../leads/normalize";
import { intakeLead } from "../leads/service";
import { recordConsent } from "../messaging/consent";

/**
 * The single entry point for leads arriving automatically (website, WhatsApp, Gmail, Meta, CRM).
 * Everything happens in one transaction keyed by the provider's event id, so a webhook delivered
 * twice — or retried after a crash — creates exactly one lead and one acknowledgement (ADR-007).
 */

export type IngestArgs = {
  integration: Pick<Integration, "id" | "organizationId" | "name">;
  sourceType: SourceType;
  /** Provider's unique id for this event, e.g. `leadgen:123`. */
  externalEventId: string;
  eventType: string;
  raw: RawContact;
  metadata?: Prisma.InputJsonValue;
  consent?: Partial<Record<Channel, boolean>>;
  /** Runs right after the lead is created/merged, before acknowledgement (e.g. store the WhatsApp message). */
  afterCreate?: (tx: Tx, lead: Lead) => Promise<void>;
};

export type IngestResult = { outcome: "created" | "merged" | "flagged_duplicate" | "duplicate_event"; leadId: string | null };

export function hashPayload(payload: unknown) {
  return sha256Hex(typeof payload === "string" ? payload : JSON.stringify(payload));
}

export async function ingestLead(a: IngestArgs): Promise<IngestResult> {
  const { organizationId } = a.integration;
  const prior = await prisma.inboundEvent.findUnique({
    where: { integrationId_externalEventId: { integrationId: a.integration.id, externalEventId: a.externalEventId } },
  });
  if (prior) return { outcome: "duplicate_event", leadId: prior.leadId };

  const [org, settings] = await Promise.all([
    prisma.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { defaultCountry: true } }),
    getLeadAutomationSettings(organizationId),
  ]);
  // Automated sources keep imperfect data (an odd phone format) rather than lose the lead.
  const contact = normalizeContact(a.raw, { defaultCountry: org.defaultCountry, strict: false });
  if (!contact.email && !contact.phone) throw Errors.validation("An email address or phone number is required.", { email: "Required" });

  return prisma.$transaction(async (tx) => {
    // Claim the event first; a concurrent duplicate inserts nothing and stops here.
    const claimed = await tx.inboundEvent.createMany({
      data: [{ organizationId, integrationId: a.integration.id, externalEventId: a.externalEventId, eventType: a.eventType, payloadHash: hashPayload(a.raw) }],
      skipDuplicates: true,
    });
    if (claimed.count !== 1) {
      const e = await tx.inboundEvent.findUnique({ where: { integrationId_externalEventId: { integrationId: a.integration.id, externalEventId: a.externalEventId } } });
      return { outcome: "duplicate_event" as const, leadId: e?.leadId ?? null };
    }
    const source = await tx.leadSource.upsert({
      where: { organizationId_type_label: { organizationId, type: a.sourceType, label: a.integration.name } },
      update: { integrationId: a.integration.id },
      create: { organizationId, type: a.sourceType, label: a.integration.name, integrationId: a.integration.id },
    });
    const res = await intakeLead(tx, {
      organizationId,
      contact,
      source: { type: a.sourceType, sourceId: source.id, metadata: a.metadata ?? {} },
      onDuplicate: settings.duplicates.policy === "MERGE" ? "merge" : "create",
      actor: { type: "SYSTEM" },
      assign: async (lead) => (await autoAssignLead(tx, lead, settings)).lead,
      afterCreate: async (lead) => {
        // Consent must exist before the acknowledgement decides which channels it may use.
        for (const [channel, optedIn] of Object.entries(a.consent ?? {})) {
          if (optedIn) await recordConsent(tx, { organizationId, leadId: lead.id, channel: channel as Channel, optedOut: false, source: `${a.sourceType.toLowerCase()}_form` });
        }
        if (a.afterCreate) await a.afterCreate(tx, lead);
      },
    });
    await tx.inboundEvent.update({
      where: { integrationId_externalEventId: { integrationId: a.integration.id, externalEventId: a.externalEventId } },
      data: { leadId: res.lead.id, processedAt: new Date() },
    });
    await logExecution(tx, {
      organizationId,
      eventType: "lead.captured",
      status: "SUCCESS",
      leadId: res.lead.id,
      output: { source: a.sourceType, integration: a.integration.name, outcome: res.outcome },
    });
    return { outcome: res.outcome, leadId: res.lead.id };
  }, ASSIGNMENT_TX);
}

// ───────────────────────────── Field mapping ─────────────────────────────

const ALIASES: Record<keyof RawContact, string[]> = {
  name: ["name", "full_name", "fullname", "your_name", "contact_name", "customer_name"],
  email: ["email", "email_address", "e_mail", "your_email", "mail"],
  phone: ["phone", "phone_number", "mobile", "mobile_number", "telephone", "tel", "whatsapp", "contact_number", "your_phone"],
  company: ["company", "company_name", "business", "organization", "organisation"],
  subject: ["subject", "service", "interest", "interested_in", "topic", "requirement", "product"],
  inquiry: ["message", "inquiry", "enquiry", "comments", "comment", "details", "description", "your_message", "question"],
};

const keyOf = (k: string) => k.trim().toLowerCase().replace(/[\s-]+/g, "_");

/**
 * Maps arbitrary form fields (WordPress, Webflow, Meta lead forms, custom HTML) to lead fields.
 * Unrecognised fields are kept so nothing the customer typed is lost.
 */
export function mapFormFields(fields: Record<string, unknown>): { contact: RawContact; extra: Record<string, string> } {
  const flat: Record<string, string> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === null || v === undefined) continue;
    const s = Array.isArray(v) ? v.map(String).join(", ") : typeof v === "object" ? JSON.stringify(v) : String(v);
    if (s.trim()) flat[keyOf(k)] = s.trim().slice(0, 5000);
  }
  const used = new Set<string>();
  const pick = (field: keyof RawContact) => {
    for (const alias of ALIASES[field]) if (flat[alias]) return used.add(alias), flat[alias];
    return undefined;
  };
  const contact: RawContact = {
    name: pick("name"),
    email: pick("email"),
    phone: pick("phone"),
    company: pick("company"),
    subject: pick("subject"),
    inquiry: pick("inquiry"),
  };
  if (!contact.name) {
    const first = flat.first_name ?? flat.firstname;
    const last = flat.last_name ?? flat.lastname;
    if (first || last) {
      contact.name = [first, last].filter(Boolean).join(" ");
      ["first_name", "firstname", "last_name", "lastname"].forEach((k) => used.add(k));
    }
  }
  const extra = Object.fromEntries(Object.entries(flat).filter(([k]) => !used.has(k)));
  return { contact, extra };
}

/** Truthy checkbox values from forms ("on", "yes", "true", "1"). */
export function isChecked(v: unknown) {
  return v === true || (typeof v === "string" && ["on", "yes", "true", "1", "y"].includes(v.trim().toLowerCase()));
}
