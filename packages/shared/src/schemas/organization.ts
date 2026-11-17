import { z } from "zod";
import { emailSchema, timezoneSchema } from "./auth";

export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Weekday = (typeof WEEKDAYS)[number];
export const WEEKDAY_LABELS: Record<Weekday, string> = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday",
};

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, { error: "Use 24-hour time, e.g. 09:00" });

export const timeRangeSchema = z
  .object({ start: hhmm, end: hhmm })
  .refine((r) => r.start < r.end, { error: "End time must be after start time", path: ["end"] });

/** Up to three working windows per day; an empty array means closed. */
export const workingHoursSchema = z
  .object(Object.fromEntries(WEEKDAYS.map((d) => [d, z.array(timeRangeSchema).max(3)])) as Record<
    Weekday,
    z.ZodArray<typeof timeRangeSchema>
  >)
  .superRefine((wh, ctx) => {
    for (const day of WEEKDAYS) {
      const ranges = [...wh[day]].sort((a, b) => a.start.localeCompare(b.start));
      for (let i = 1; i < ranges.length; i++) {
        if (ranges[i]!.start < ranges[i - 1]!.end) {
          ctx.addIssue({ code: "custom", path: [day], message: "Time ranges overlap" });
        }
      }
    }
  });
export type WorkingHours = z.infer<typeof workingHoursSchema>;

export const holidaySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { error: "Use a date like 2026-12-25" }),
  name: z.string().trim().max(80).optional(),
});
export type Holiday = z.infer<typeof holidaySchema>;

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .optional();

export const updateOrganizationSchema = z
  .object({
    name: z.string().trim().min(1, { error: "Enter your business name" }).max(160),
    email: emailSchema,
    businessType: optionalText(80),
    website: z
      .string()
      .trim()
      .transform((v) => (v === "" ? null : v))
      .pipe(z.url({ error: "Enter a full website address, e.g. https://example.com" }).nullable())
      .nullable()
      .optional(),
    timezone: timezoneSchema,
    defaultCountry: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{2}$/, { error: "Use a two-letter country code, e.g. IN" }),
    workingHours: workingHoursSchema,
    holidays: z
      .array(holidaySchema)
      .max(100)
      .refine((h) => new Set(h.map((x) => x.date)).size === h.length, { error: "Each holiday date can only appear once" }),
  })
  .partial();
export type UpdateOrganizationInput = z.infer<typeof updateOrganizationSchema>;

// ───────────── Members & invitations ─────────────

const assignableRole = z.enum(["ADMIN", "MANAGER", "SALESPERSON"], { error: "Choose a role" });

export const inviteMemberSchema = z.object({
  email: emailSchema,
  name: z.string().trim().max(120).optional(),
  role: assignableRole,
});
export type InviteMemberInput = z.infer<typeof inviteMemberSchema>;

export const updateMemberSchema = z
  .object({
    role: assignableRole,
    status: z.enum(["ACTIVE", "DISABLED"]),
    receivesLeads: z.boolean(),
    isAvailable: z.boolean(),
    unavailableUntil: z.iso.datetime({ offset: true }).nullable(),
    isFallbackManager: z.boolean(),
  })
  .partial();
export type UpdateMemberInput = z.infer<typeof updateMemberSchema>;

export const NOTIFICATION_EVENTS = {
  leadAssigned: "A new lead is assigned to me",
  customerReplied: "A customer replies to one of my leads",
  followUpDue: "A follow-up is due",
  followUpOverdue: "A follow-up becomes overdue",
  messageFailed: "A message to my customer fails",
  unassignedLead: "A lead arrives that nobody could be assigned to (managers)",
} as const;
export type NotificationEvent = keyof typeof NOTIFICATION_EVENTS;

const channelPrefs = z.object({ inApp: z.boolean(), email: z.boolean() });
export const notificationPrefsSchema = z
  .object(Object.fromEntries(Object.keys(NOTIFICATION_EVENTS).map((k) => [k, channelPrefs])) as Record<
    NotificationEvent,
    typeof channelPrefs
  >)
  .partial();
export type NotificationPrefs = z.infer<typeof notificationPrefsSchema>;

export const DEFAULT_NOTIFICATION_PREFS: Record<NotificationEvent, { inApp: boolean; email: boolean }> = {
  leadAssigned: { inApp: true, email: true },
  customerReplied: { inApp: true, email: true },
  followUpDue: { inApp: true, email: false },
  followUpOverdue: { inApp: true, email: true },
  messageFailed: { inApp: true, email: false },
  unassignedLead: { inApp: true, email: true },
};

/** Fields a member may change about themselves. */
export const updateMyMembershipSchema = z
  .object({
    isAvailable: z.boolean(),
    unavailableUntil: z.iso.datetime({ offset: true }).nullable(),
    notificationPrefs: notificationPrefsSchema,
  })
  .partial();
export type UpdateMyMembershipInput = z.infer<typeof updateMyMembershipSchema>;

export const acceptInvitationSchema = z.object({
  token: z.string().min(20).max(200),
  /** Required when the invited email has no account yet. */
  name: z.string().trim().min(1, { error: "Enter your name" }).max(120).optional(),
  password: z.string().min(1, { error: "Enter a password" }).max(128),
});
export type AcceptInvitationInput = z.infer<typeof acceptInvitationSchema>;

export const switchOrganizationSchema = z.object({ organizationId: z.string().min(1) });
