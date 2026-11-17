// Dev helper: screenshots every main screen at phone size for visual review.
// Usage: node e2e/browser/mobile-shots.mjs <outDir>   (app must be running; uses installed Chrome)
import { chromium, devices } from "@playwright/test";
import { mkdirSync } from "node:fs";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const out = process.argv[2] ?? "e2e/.results/mobile";
mkdirSync(out, { recursive: true });
const id = Date.now().toString(36);

const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || undefined });
const ctx = await browser.newContext({ ...devices["iPhone 13"], defaultBrowserType: undefined });
const page = await ctx.newPage();
const api = async (method, path, body) => {
  const r = await page.request.fetch(BASE + path, { method, headers: { Origin: BASE, "Content-Type": "application/json" }, data: body ? JSON.stringify(body) : undefined });
  return r.json().catch(() => null);
};

await api("POST", "/api/auth/register", { name: "Meera Shah", email: `mobile-${id}@e2e.test`, password: "longpassword1", businessName: "Acme Digital Solutions", businessEmail: `hello-${id}@e2e.test`, timezone: "Asia/Kolkata" });
const people = [
  ["Rahul Sharma", "Website Development", "+91 98765 43210"],
  ["Anita Desai", "SEO audit for e-commerce store", "+91 99887 76655"],
  ["Kiran Patel", "Mobile app", null],
  ["Vikram Singh Rathore", "Brand identity and logo redesign", "+91 91234 56789"],
];
let leadId;
for (const [name, subject, phone] of people) {
  const r = await api("POST", "/api/leads", { name, subject, email: `${name.split(" ")[0].toLowerCase()}-${id}@example.com`, ...(phone ? { phone } : {}), company: "Sharma Traders Pvt Ltd" });
  leadId ??= r?.lead?.id;
}
await api("POST", `/api/leads/${leadId}/activities`, { body: "Prefers a call after 5pm. Budget around 2 lakh." });
await api("POST", `/api/leads/${leadId}/interactions`, { channel: "PHONE", note: "Discussed scope", awaitingCustomer: true });
await api("POST", "/api/automation/install");
await api("POST", "/api/integrations/website", { name: "Contact page" });

const pages = [
  ["dashboard", "/dashboard"],
  ["leads", "/leads"],
  ["lead", `/leads/${leadId}`],
  ["lead-new", "/leads/new"],
  ["follow-ups", "/follow-ups?view=upcoming"],
  ["notifications", "/notifications"],
  ["automation", "/automation"],
  ["setup-1", "/automation/setup?step=1"],
  ["setup-4", "/automation/setup?step=4"],
  ["setup-5", "/automation/setup?step=5"],
  ["activity", "/activity"],
  ["integrations", "/integrations"],
  ["team", "/settings/team"],
  ["business", "/settings/business"],
  ["hours", "/settings/hours"],
  ["messages", "/settings/messages"],
  ["followup-rules", "/settings/follow-ups"],
  ["assignment", "/settings/assignment"],
  ["audit", "/settings/audit"],
];
const report = [];
for (const [name, path] of pages) {
  await page.goto(BASE + path, { waitUntil: "networkidle" });
  // Horizontal overflow is the main thing that makes a page awkward on a phone.
  const overflow = await page.evaluate(() => {
    const w = document.documentElement.clientWidth;
    const wide = [...document.querySelectorAll("body *")]
      .filter((el) => el.getBoundingClientRect().right > w + 1 && getComputedStyle(el).position !== "fixed")
      .filter((el) => !el.closest("[data-scroll-x]"))
      .slice(0, 3)
      .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).split(" ").slice(0, 3).join(".")}`);
    return { scrollWidth: document.documentElement.scrollWidth, width: w, wide };
  });
  report.push(`${name.padEnd(16)} scrollWidth=${overflow.scrollWidth}/${overflow.width} ${overflow.wide.join(" | ")}`);
  await page.screenshot({ path: `${out}/${name}.png`, fullPage: true });
}
// Public pages
await ctx.clearCookies();
for (const [name, path] of [["login", "/login"], ["register", "/register"]]) {
  await page.goto(BASE + path, { waitUntil: "networkidle" });
  await page.screenshot({ path: `${out}/${name}.png`, fullPage: true });
}
console.log(report.join("\n"));
await browser.close();
