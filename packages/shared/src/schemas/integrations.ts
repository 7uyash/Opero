import { z } from "zod";

/**
 * Every provider the platform knows about. `setup` describes how it's connected; `requiresEnv`
 * lists server settings a self-hosting administrator must provide first (e.g. an OAuth app).
 */
export const PROVIDER_CATALOG = {
  WEBSITE_FORM: {
    label: "Website form",
    description: "Capture inquiries from your website with a ready-made form or by sending them from your own form.",
    kind: "source",
    setup: "webhook",
    requiresEnv: [],
    source: "WEBSITE",
  },
  SMTP: {
    label: "Email (SMTP)",
    description: "Send emails from your business address using any email provider.",
    kind: "channel",
    setup: "form",
    requiresEnv: [],
    source: null,
  },
  GMAIL: {
    label: "Gmail / Google Workspace",
    description: "Send from your Gmail address and pick up customer replies and new email inquiries.",
    kind: "both",
    setup: "oauth",
    requiresEnv: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
    source: "EMAIL",
  },
  WHATSAPP_CLOUD: {
    label: "WhatsApp Business",
    description: "Message customers and receive WhatsApp inquiries through the official WhatsApp Business Platform.",
    kind: "both",
    setup: "form",
    requiresEnv: ["META_APP_SECRET", "WHATSAPP_WEBHOOK_VERIFY_TOKEN"],
    source: "WHATSAPP",
  },
  META_LEAD_ADS: {
    label: "Facebook & Instagram lead forms",
    description: "Receive leads from Facebook and Instagram lead ads on a Page you manage.",
    kind: "source",
    setup: "oauth",
    requiresEnv: ["META_APP_ID", "META_APP_SECRET", "WHATSAPP_WEBHOOK_VERIFY_TOKEN"],
    source: "META",
  },
  HUBSPOT: {
    label: "HubSpot CRM",
    description: "Import new contacts from HubSpot as leads.",
    kind: "source",
    setup: "form",
    requiresEnv: [],
    source: "CRM",
  },
} as const;
export type ProviderKey = keyof typeof PROVIDER_CATALOG;

/** The lead sources a business can pick in the setup wizard, mapped to providers. */
export const LEAD_SOURCE_OPTIONS = [
  { key: "WEBSITE", label: "Website forms", providers: ["WEBSITE_FORM"] },
  { key: "EMAIL", label: "Email inquiries", providers: ["GMAIL"] },
  { key: "WHATSAPP", label: "WhatsApp Business", providers: ["WHATSAPP_CLOUD"] },
  { key: "META", label: "Facebook / Instagram", providers: ["META_LEAD_ADS"] },
  { key: "MANUAL", label: "Manual entry", providers: [] },
  { key: "CRM", label: "Other CRM", providers: ["HUBSPOT"] },
] as const;
export type LeadSourceOptionKey = (typeof LEAD_SOURCE_OPTIONS)[number]["key"];

const origin = z
  .string()
  .trim()
  .regex(/^https?:\/\/[a-z0-9.-]+(:\d+)?$/i, { error: "Use an origin like https://www.example.com (no path)" });

export const websiteFormSettingsSchema = z.object({
  name: z.string().trim().min(1).max(80).default("Website form"),
  /** Sites allowed to post the embedded form. Empty = any site (spam protection still applies). */
  allowedOrigins: z.array(origin).max(20).default([]),
  title: z.string().trim().max(120).default("Get in touch"),
  successMessage: z.string().trim().max(300).default("Thanks! We've received your message and will get back to you shortly."),
  askCompany: z.boolean().default(true),
  askWhatsAppOptIn: z.boolean().default(true),
  whatsAppOptInLabel: z.string().trim().max(200).default("I agree to be contacted on WhatsApp about my inquiry."),
});
export type WebsiteFormSettings = z.infer<typeof websiteFormSettingsSchema>;

export const whatsappConnectSchema = z.object({
  phoneNumberId: z.string().trim().regex(/^\d{5,25}$/, { error: "The Phone number ID is a long number from WhatsApp Manager" }),
  businessAccountId: z
    .string()
    .trim()
    .regex(/^\d{5,25}$/, { error: "The WhatsApp Business Account ID is a long number" })
    .optional()
    .or(z.literal("").transform(() => undefined)),
  accessToken: z.string().trim().min(20, { error: "Paste the permanent access token" }).max(1000).optional(),
});
export type WhatsAppConnectInput = z.input<typeof whatsappConnectSchema>;

export const hubspotConnectSchema = z.object({
  accessToken: z.string().trim().min(20, { error: "Paste the private app access token" }).max(500).optional(),
  syncEveryMinutes: z.coerce.number().int().min(5).max(1440).default(15),
});
export type HubSpotConnectInput = z.input<typeof hubspotConnectSchema>;

export const metaSelectPageSchema = z.object({ pageId: z.string().regex(/^\d{3,30}$/) });

export const gmailSettingsSchema = z.object({ createLeadsFromNewEmails: z.boolean() });

export const SOURCE_SELECTION_SCHEMA = z.object({
  selected: z.array(z.enum(["WEBSITE", "EMAIL", "WHATSAPP", "META", "MANUAL", "CRM"])).max(6),
});
