import { z } from "zod";

export const emailSchema = z.string().trim().toLowerCase().pipe(z.email({ error: "Enter a valid email address" }));

export const passwordSchema = z
  .string()
  .min(10, { error: "Use at least 10 characters" })
  .max(128, { error: "Use at most 128 characters" })
  .refine((v) => /[a-zA-Z]/.test(v) && /[0-9]/.test(v), { error: "Include at least one letter and one number" });

const optionalUrl = z
  .string()
  .trim()
  .transform((v) => (v === "" ? undefined : v))
  .pipe(z.url({ error: "Enter a full website address, e.g. https://example.com" }).optional())
  .optional();

/** IANA timezone validated by the runtime's Intl database. */
export const timezoneSchema = z.string().refine(
  (tz) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  },
  { error: "Choose a valid timezone" },
);

export const registerSchema = z.object({
  name: z.string().trim().min(1, { error: "Enter your name" }).max(120),
  email: emailSchema,
  password: passwordSchema,
  businessName: z.string().trim().min(1, { error: "Enter your business name" }).max(160),
  businessEmail: emailSchema,
  businessType: z.string().trim().max(80).optional(),
  website: optionalUrl,
  timezone: timezoneSchema,
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, { error: "Enter your password" }).max(128),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const BUSINESS_TYPES = [
  "Digital / marketing agency",
  "Recruitment agency",
  "Real estate",
  "Education & coaching",
  "Healthcare & clinics",
  "Professional services",
  "Home services",
  "Retail & e-commerce",
  "Other",
] as const;
