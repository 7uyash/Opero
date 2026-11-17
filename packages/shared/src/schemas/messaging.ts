import { z } from "zod";
import { emailSchema } from "./auth";
import { workingHoursSchema } from "./organization";

export const MESSAGE_CHANNELS = ["EMAIL", "WHATSAPP"] as const;
export type MessageChannel = (typeof MESSAGE_CHANNELS)[number];
export const CHANNEL_LABELS: Record<MessageChannel, string> = { EMAIL: "Email", WHATSAPP: "WhatsApp" };

export const MESSAGE_STATUS_LABELS: Record<string, string> = {
  QUEUED: "Queued",
  SENDING: "Sending",
  SENT: "Sent",
  DELIVERED: "Delivered",
  READ: "Read",
  FAILED: "Failed",
  CANCELLED: "Not sent",
  RECEIVED: "Received",
};

export const MESSAGE_PURPOSES = ["acknowledgement", "follow_up", "manual", "fallback"] as const;
export type MessagePurpose = (typeof MESSAGE_PURPOSES)[number];

// ───────────────────────────── Templates ─────────────────────────────

/** Built-in template keys. Follow-up steps use FOLLOW_UP_<n> when present, otherwise FOLLOW_UP. */
export const TEMPLATE_KEYS = ["ACKNOWLEDGEMENT", "FOLLOW_UP"] as const;
export type TemplateKey = (typeof TEMPLATE_KEYS)[number];
export const TEMPLATE_KEY_LABELS: Record<string, { label: string; description: string }> = {
  ACKNOWLEDGEMENT: { label: "Acknowledgement", description: "Sent automatically as soon as a new lead arrives." },
  FOLLOW_UP: { label: "Follow-up", description: "Sent when a follow-up step is due and the customer hasn't replied." },
};

/** Variables available in every template, with the value used when the data is missing. */
export const TEMPLATE_VARIABLES = {
  customer_name: { label: "Customer name", sample: "Rahul Sharma", fallback: "there" },
  customer_first_name: { label: "Customer first name", sample: "Rahul", fallback: "there" },
  customer_email: { label: "Customer email", sample: "rahul@example.com", fallback: "" },
  customer_phone: { label: "Customer phone", sample: "+91 98765 43210", fallback: "" },
  customer_company: { label: "Customer company", sample: "Sharma Traders", fallback: "" },
  inquiry_subject: { label: "What they asked about", sample: "Website Development", fallback: "your requirements" },
  business_name: { label: "Your business name", sample: "Acme Digital", fallback: "" },
  business_email: { label: "Your business email", sample: "hello@acme.example", fallback: "" },
  business_website: { label: "Your website", sample: "https://acme.example", fallback: "" },
  employee_name: { label: "Assigned team member", sample: "Priya", fallback: "The team" },
  employee_first_name: { label: "Assigned member first name", sample: "Priya", fallback: "The team" },
} as const;
export type BuiltInVariable = keyof typeof TEMPLATE_VARIABLES;

export const customVariableKeySchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{1,39}$/, { error: "Use lowercase letters, numbers and _ (e.g. office_address)" })
  .refine((k) => !(k in TEMPLATE_VARIABLES), { error: "That name is already a built-in variable" });

export const saveTemplateSchema = z.object({
  key: z.string().regex(/^(ACKNOWLEDGEMENT|FOLLOW_UP(_\d{1,2})?)$/, { error: "Unknown template" }),
  channel: z.enum(MESSAGE_CHANNELS),
  subject: z.string().trim().max(200).optional(),
  body: z.string().trim().min(1, { error: "Write the message" }).max(4000),
  /** Name and language of the template approved by Meta (WhatsApp only). */
  providerTemplateName: z
    .string()
    .trim()
    .regex(/^[a-z0-9_]{1,512}$/, { error: "Use the exact template name from WhatsApp Manager (lowercase, _)" })
    .optional()
    .or(z.literal("").transform(() => undefined)),
  providerLanguage: z.string().trim().max(15).optional(),
});
export type SaveTemplateInput = z.input<typeof saveTemplateSchema>;

export const previewTemplateSchema = z.object({
  subject: z.string().max(200).optional(),
  body: z.string().max(4000),
  leadId: z.string().optional(),
});

// ───────────────────────────── Settings ─────────────────────────────

export const SENDING_HOURS_MODES = ["WORKING_HOURS", "ALWAYS", "CUSTOM"] as const;

export const messagingSettingsSchema = z
  .object({
    /** Send approved automatic messages without asking anyone each time. */
    autoSend: z.boolean().default(true),
    acknowledgement: z
      .object({ enabled: z.boolean().default(true), channels: z.array(z.enum(MESSAGE_CHANNELS)).default(["EMAIL", "WHATSAPP"]) })
      .prefault({}),
    followUpMessages: z.object({ enabled: z.boolean().default(true) }).prefault({}),
    sendingHours: z
      .object({ mode: z.enum(SENDING_HOURS_MODES).default("WORKING_HOURS"), custom: workingHoursSchema.optional() })
      .prefault({}),
    /** Used when the preferred channel fails permanently or isn't available for this customer. */
    fallbackChannel: z.enum(MESSAGE_CHANNELS).nullable().default("EMAIL"),
    customVariables: z.record(z.string(), z.string().max(500)).default({}),
  })
  .prefault({});
export type MessagingSettings = z.infer<typeof messagingSettingsSchema>;

export const updateMessagingSettingsSchema = z.object({
  autoSend: z.boolean().optional(),
  acknowledgementEnabled: z.boolean().optional(),
  acknowledgementChannels: z.array(z.enum(MESSAGE_CHANNELS)).optional(),
  followUpMessagesEnabled: z.boolean().optional(),
  sendingHoursMode: z.enum(SENDING_HOURS_MODES).optional(),
  customSendingHours: workingHoursSchema.optional(),
  fallbackChannel: z.enum(MESSAGE_CHANNELS).nullable().optional(),
  customVariables: z
    .record(customVariableKeySchema, z.string().trim().max(500))
    .refine((r) => Object.keys(r).length <= 30, { error: "Use at most 30 custom variables" })
    .optional(),
});
export type UpdateMessagingSettingsInput = z.input<typeof updateMessagingSettingsSchema>;

export const updateStepChannelsSchema = z.object({
  steps: z.array(z.object({ stepIndex: z.number().int().min(1), channels: z.array(z.enum(MESSAGE_CHANNELS)) })).max(10),
});

// ───────────────────────────── Sending ─────────────────────────────

export const sendMessageSchema = z.object({
  channel: z.enum(MESSAGE_CHANNELS),
  subject: z.string().trim().max(200).optional(),
  body: z.string().trim().min(1, { error: "Write a message" }).max(4000),
  /** Client-generated id so a double-click or network retry never sends twice. */
  clientRequestId: z.string().uuid({ error: "Missing request id" }),
});
export type SendMessageInput = z.input<typeof sendMessageSchema>;

export const optOutSchema = z.object({
  channel: z.enum([...MESSAGE_CHANNELS, "ALL"]),
  optedOut: z.boolean(),
});

// ───────────────────────────── SMTP ─────────────────────────────

export const smtpConnectSchema = z.object({
  host: z.string().trim().min(1, { error: "Enter the SMTP server" }).max(255),
  port: z.coerce.number().int().min(1).max(65535),
  /** true = TLS from the start (port 465); false = STARTTLS when offered (587/25). */
  secure: z.boolean(),
  username: z.string().trim().max(255).optional(),
  password: z.string().max(1024).optional(),
  fromEmail: emailSchema,
  fromName: z.string().trim().min(1, { error: "Enter the sender name" }).max(120),
  replyTo: emailSchema.optional().or(z.literal("").transform(() => undefined)),
});
export type SmtpConnectInput = z.input<typeof smtpConnectSchema>;
