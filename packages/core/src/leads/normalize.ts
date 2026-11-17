import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js/max";
import { Errors } from "../errors";

/**
 * Common internal shape every lead source is converted into before saving (PLAN §5.1).
 * Source adapters (website, email, WhatsApp, Meta, CRM) produce raw fields; this module
 * cleans and validates them so duplicate detection and messaging see consistent data.
 */
export type NormalizedContact = {
  name: string;
  email: string | null;
  emailNormalized: string | null;
  phone: string | null;
  phoneE164: string | null;
  company: string | null;
  subject: string | null;
  inquiry: string | null;
};

export type RawContact = {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  company?: string | null;
  subject?: string | null;
  inquiry?: string | null;
};

const clean = (v: string | null | undefined, max: number) => {
  const t = v?.replace(/\s+/g, " ").trim();
  return t ? t.slice(0, max) : null;
};

/**
 * Lower-cases and trims. For Gmail/Googlemail addresses, dots and "+tags" in the local part are
 * ignored because they deliver to the same mailbox — used only for duplicate matching.
 */
export function normalizeEmail(email: string | null | undefined): string | null {
  const e = email?.trim().toLowerCase();
  if (!e || !e.includes("@")) return null;
  const [local, domain] = [e.slice(0, e.lastIndexOf("@")), e.slice(e.lastIndexOf("@") + 1)];
  if (domain === "gmail.com" || domain === "googlemail.com") {
    return `${local.split("+")[0]!.replaceAll(".", "")}@gmail.com`;
  }
  return `${local}@${domain}`;
}

export type PhoneResult = { ok: true; e164: string; display: string } | { ok: false };

/** Parses a phone number to E.164 using the organization's default country for local numbers. */
export function normalizePhone(phone: string | null | undefined, defaultCountry = "IN"): PhoneResult {
  const raw = phone?.trim();
  if (!raw) return { ok: false };
  // Accept the international "00" prefix.
  const input = raw.startsWith("00") ? `+${raw.slice(2)}` : raw;
  const parsed = parsePhoneNumberFromString(input, defaultCountry.toUpperCase() as CountryCode);
  if (!parsed || !parsed.isValid()) return { ok: false };
  return { ok: true, e164: parsed.number, display: parsed.formatInternational() };
}

/**
 * Normalizes raw contact data. `strict` throws a field error for an invalid phone (manual entry);
 * non-strict keeps the raw phone but leaves phoneE164 empty (automated sources must not lose leads).
 */
export function normalizeContact(raw: RawContact, opts: { defaultCountry: string; strict: boolean }): NormalizedContact {
  const name = clean(raw.name, 160);
  const email = clean(raw.email, 254)?.toLowerCase() ?? null;
  const phoneRaw = clean(raw.phone, 40);

  let phone: string | null = null;
  let phoneE164: string | null = null;
  if (phoneRaw) {
    const p = normalizePhone(phoneRaw, opts.defaultCountry);
    if (p.ok) {
      phone = p.display;
      phoneE164 = p.e164;
    } else if (opts.strict) {
      throw Errors.validation("Please check the phone number.", {
        phone: "Enter a valid phone number, including the country code if it's not local",
      });
    } else {
      phone = phoneRaw;
    }
  }

  const emailNormalized = normalizeEmail(email);
  if (!name && !email && !phoneRaw) {
    throw Errors.validation("A lead needs at least a name and an email or phone number.");
  }

  return {
    // Fall back to the email/phone so a lead is never nameless.
    name: name ?? email ?? phone ?? "Unknown",
    email,
    emailNormalized,
    phone,
    phoneE164,
    company: clean(raw.company, 160),
    subject: clean(raw.subject, 200),
    inquiry: raw.inquiry?.trim().slice(0, 5000) || null,
  };
}
