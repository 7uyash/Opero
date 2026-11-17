import { z } from "zod";

export const LEAD_STATUSES = [
  "NEW",
  "ASSIGNED",
  "CONTACTED",
  "WAITING_FOR_CUSTOMER",
  "FOLLOW_UP_DUE",
  "QUALIFIED",
  "CONVERTED",
  "LOST",
  "ON_HOLD",
] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export const LEAD_STATUS_LABELS: Record<LeadStatus, string> = {
  NEW: "New",
  ASSIGNED: "Assigned",
  CONTACTED: "Contacted",
  WAITING_FOR_CUSTOMER: "Waiting for customer",
  FOLLOW_UP_DUE: "Follow-up due",
  QUALIFIED: "Qualified",
  CONVERTED: "Converted",
  LOST: "Lost",
  ON_HOLD: "On hold",
};

export const CLOSED_STATUSES: readonly LeadStatus[] = ["CONVERTED", "LOST"];
export const OPEN_STATUSES: readonly LeadStatus[] = LEAD_STATUSES.filter((s) => !CLOSED_STATUSES.includes(s));

/** Statuses a person may set by hand. NEW/ASSIGNED are set by the system when (un)assigning. */
export const MANUAL_STATUSES: readonly LeadStatus[] = [
  "CONTACTED",
  "WAITING_FOR_CUSTOMER",
  "FOLLOW_UP_DUE",
  "QUALIFIED",
  "ON_HOLD",
  "CONVERTED",
  "LOST",
];
/** A closed lead can only be reopened into one of these. */
export const REOPEN_STATUSES: readonly LeadStatus[] = ["CONTACTED", "QUALIFIED", "ON_HOLD"];

export function allowedNextStatuses(current: LeadStatus): LeadStatus[] {
  const targets = CLOSED_STATUSES.includes(current) ? REOPEN_STATUSES : MANUAL_STATUSES;
  return targets.filter((s) => s !== current);
}

export const LEAD_PRIORITIES = ["LOW", "NORMAL", "HIGH", "URGENT"] as const;
export type LeadPriority = (typeof LEAD_PRIORITIES)[number];
export const PRIORITY_LABELS: Record<LeadPriority, string> = { LOW: "Low", NORMAL: "Normal", HIGH: "High", URGENT: "Urgent" };

export const SOURCE_TYPES = ["WEBSITE", "EMAIL", "WHATSAPP", "META", "CRM", "MANUAL"] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];
export const SOURCE_LABELS: Record<SourceType, string> = {
  WEBSITE: "Website",
  EMAIL: "Email",
  WHATSAPP: "WhatsApp",
  META: "Facebook / Instagram",
  CRM: "CRM",
  MANUAL: "Manual entry",
};

export const INTERACTION_CHANNELS = ["PHONE", "EMAIL", "WHATSAPP", "SMS", "OTHER"] as const;
export const INTERACTION_CHANNEL_LABELS: Record<(typeof INTERACTION_CHANNELS)[number], string> = {
  PHONE: "Phone call",
  EMAIL: "Email",
  WHATSAPP: "WhatsApp",
  SMS: "SMS",
  OTHER: "Other / in person",
};

const optionalString = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === "" ? undefined : v))
    .optional();

/** Raw contact fields shared by every lead source before normalization. */
export const leadContactSchema = z.object({
  name: z.string().trim().min(1, { error: "Enter the customer's name" }).max(160),
  email: optionalString(254).pipe(z.email({ error: "Enter a valid email address" }).optional()),
  phone: optionalString(40),
  company: optionalString(160),
  subject: optionalString(200),
  inquiry: optionalString(5000),
});

export const DUPLICATE_ACTIONS = ["check", "merge", "create"] as const;
export type DuplicateAction = (typeof DUPLICATE_ACTIONS)[number];

export const createLeadSchema = leadContactSchema
  .extend({
    priority: z.enum(LEAD_PRIORITIES).default("NORMAL"),
    /** Member to assign to. Omit to let the system decide (round-robin from Task 5). */
    assignedMemberId: z.string().min(1).nullable().optional(),
    /** What to do when a matching open lead exists: ask (default), add to it, or create a flagged duplicate. */
    onDuplicate: z.enum(DUPLICATE_ACTIONS).default("check"),
  })
  .refine((v) => v.email || v.phone, { error: "Enter an email address or a phone number", path: ["email"] });
export type CreateLeadInput = z.input<typeof createLeadSchema>;

export const updateLeadSchema = leadContactSchema
  .extend({ priority: z.enum(LEAD_PRIORITIES) })
  .partial()
  .extend({
    // Allow clearing optional fields with an empty string.
    email: z
      .string()
      .trim()
      .max(254)
      .transform((v) => (v === "" ? null : v))
      .pipe(z.email({ error: "Enter a valid email address" }).nullable())
      .nullable()
      .optional(),
    phone: z
      .string()
      .trim()
      .max(40)
      .transform((v) => (v === "" ? null : v))
      .nullable()
      .optional(),
  });
export type UpdateLeadInput = z.input<typeof updateLeadSchema>;

export const changeStatusSchema = z.object({
  status: z.enum(LEAD_STATUSES),
  reason: z.string().trim().max(500).optional(),
});
export type ChangeStatusInput = z.input<typeof changeStatusSchema>;

export const addNoteSchema = z.object({ body: z.string().trim().min(1, { error: "Write a note" }).max(5000) });

export const assignLeadSchema = z.object({
  memberId: z.string().min(1).nullable(),
  reason: z.string().trim().max(300).optional(),
});

export const logInteractionSchema = z.object({
  channel: z.enum(INTERACTION_CHANNELS),
  note: z.string().trim().max(5000).optional(),
  /** True when the employee now waits for the customer to respond. */
  awaitingCustomer: z.boolean().default(true),
  occurredAt: z.iso.datetime({ offset: true }).optional(),
});
export type LogInteractionInput = z.input<typeof logInteractionSchema>;

export const LEAD_SORT_FIELDS = ["createdAt", "name", "lastContactAt", "nextFollowUpAt", "status", "priority"] as const;
export const FOLLOW_UP_FILTERS = ["overdue", "today", "week", "none"] as const;

const csvEnum = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .union([z.string(), z.array(z.string())])
    .transform((v) => (Array.isArray(v) ? v : v.split(",")).map((s) => s.trim()).filter(Boolean))
    .pipe(z.array(z.enum(values)))
    .optional();

const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional()
  .or(z.literal("").transform(() => undefined));

export const listLeadsQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  status: csvEnum(LEAD_STATUSES),
  source: csvEnum(SOURCE_TYPES),
  priority: csvEnum(LEAD_PRIORITIES),
  /** Member id, "me" or "unassigned". */
  assignee: z.string().max(64).optional(),
  createdFrom: dateOnly,
  createdTo: dateOnly,
  followUp: z.enum(FOLLOW_UP_FILTERS).optional().or(z.literal("").transform(() => undefined)),
  /** Hide closed (converted/lost) leads unless explicitly filtered by status. */
  includeClosed: z
    .union([z.boolean(), z.enum(["true", "false", "1", "0", ""])])
    .transform((v) => v === true || v === "true" || v === "1")
    .optional(),
  sort: z.enum(LEAD_SORT_FIELDS).default("createdAt"),
  dir: z.enum(["asc", "desc"]).default("desc"),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(5).max(100).default(25),
});
export type ListLeadsQuery = z.input<typeof listLeadsQuerySchema>;
