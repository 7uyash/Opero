import { TEMPLATE_VARIABLES, type BuiltInVariable } from "@lfm/shared";

/**
 * Template rendering. Syntax: {{variable_name}} (spaces inside the braces are allowed).
 * Rendering never throws: unknown variables are left visible so a preview shows the mistake,
 * and missing values use the variable's fallback (e.g. "Hi there").
 */

const VAR_RE = /\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g;

export type TemplateValues = Partial<Record<BuiltInVariable, string | null | undefined>> & Record<string, string | null | undefined>;

export function extractVariables(text: string): string[] {
  return [...new Set([...text.matchAll(VAR_RE)].map((m) => m[1]!))];
}

export function findUnknownVariables(text: string, customKeys: string[] = []): string[] {
  const known = new Set([...Object.keys(TEMPLATE_VARIABLES), ...customKeys]);
  return extractVariables(text).filter((v) => !known.has(v));
}

export function renderTemplate(text: string, values: TemplateValues, customVariables: Record<string, string> = {}) {
  const missing: string[] = [];
  const unknown: string[] = [];
  const output = text.replace(VAR_RE, (whole, name: string) => {
    if (name in TEMPLATE_VARIABLES) {
      const v = values[name]?.trim();
      if (v) return v;
      missing.push(name);
      return TEMPLATE_VARIABLES[name as BuiltInVariable].fallback;
    }
    if (name in customVariables) return customVariables[name]!;
    unknown.push(name);
    return whole;
  });
  // Tidy up after empty fallbacks: no "Hi ," or double spaces.
  const tidy = output
    .replace(/[ \t]+([,.!?])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { output: tidy, missing: [...new Set(missing)], unknown: [...new Set(unknown)] };
}

/** Values for a real lead. */
export function valuesForLead(lead: {
  name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  subject: string | null;
}, org: { name: string; email: string; website: string | null }, employeeName?: string | null): TemplateValues {
  const first = (s?: string | null) => s?.trim().split(/\s+/)[0] ?? null;
  // A lead named after their email address shouldn't be greeted as "Hi rahul@example.com".
  const realName = lead.name.includes("@") ? null : lead.name;
  return {
    customer_name: realName,
    customer_first_name: first(realName),
    customer_email: lead.email,
    customer_phone: lead.phone,
    customer_company: lead.company,
    inquiry_subject: lead.subject,
    business_name: org.name,
    business_email: org.email,
    business_website: org.website,
    employee_name: employeeName ?? null,
    employee_first_name: first(employeeName),
  };
}

/** Sample values for previews when no lead is chosen. */
export function sampleValues(org?: { name: string; email: string; website: string | null }): TemplateValues {
  const v = Object.fromEntries(Object.entries(TEMPLATE_VARIABLES).map(([k, d]) => [k, d.sample])) as TemplateValues;
  if (org) Object.assign(v, { business_name: org.name, business_email: org.email, business_website: org.website ?? "" });
  return v;
}

/** Plain text → minimal, safe HTML for email. */
export function textToHtml(text: string): string {
  const esc = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const linked = esc.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>');
  return linked
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
    .join("\n");
}
