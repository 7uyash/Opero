import { devices, expect, test } from "@playwright/test";

/**
 * Phone layout: no sideways scrolling, bottom tab bar + "More" sheet, lead cards, collapsible
 * filters, and one-tap contact buttons on the lead page.
 */
test.use({ ...devices["iPhone 13"], defaultBrowserType: undefined });

const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

async function noSidewaysScroll(page: import("@playwright/test").Page, path: string) {
  await page.goto(path);
  const { scroll, width } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: document.documentElement.clientWidth }));
  expect(scroll, `${path} scrolls sideways`).toBeLessThanOrEqual(width);
}

test("the app is usable on a phone", async ({ page }) => {
  const api = (method: string, path: string, data?: unknown) =>
    page.request.fetch(path, { method, headers: { Origin: new URL(test.info().project.use.baseURL!).origin }, data });
  await page.goto("/login");
  expect((await api("POST", "/api/auth/register", { name: "Phone Owner", email: `phone-${id}@e2e.test`, password: "longpassword1", businessName: `Phone Co ${id}`, businessEmail: `hi-${id}@e2e.test`, timezone: "Asia/Kolkata" })).ok()).toBe(true);
  const lead = await (await api("POST", "/api/leads", { name: "Asha Verma", email: `asha-${id}@example.com`, phone: "+91 98111 00011", subject: "Website redesign" })).json();

  await test.step("pages fit the screen", async () => {
    for (const p of ["/dashboard", "/leads", `/leads/${lead.lead.id}`, "/follow-ups", "/activity", "/integrations", "/settings/team", "/settings/messages"]) await noSidewaysScroll(page, p);
  });

  await test.step("bottom tab bar and More menu", async () => {
    await page.goto("/dashboard");
    const tabs = page.getByRole("navigation", { name: "Main" });
    await expect(tabs.getByRole("link", { name: "Leads" })).toBeVisible();
    await tabs.getByRole("button", { name: "More" }).click();
    const sheet = page.getByRole("dialog", { name: "More" });
    await expect(sheet.getByRole("link", { name: "Integrations" })).toBeVisible();
    await expect(sheet.getByRole("button", { name: /sign out/i })).toBeVisible();
    await sheet.getByRole("link", { name: "Team" }).click();
    await expect(page).toHaveURL(/\/settings\/team/);
    await expect(sheet).toBeHidden();
  });

  await test.step("leads list: cards and collapsible filters", async () => {
    await page.goto("/leads");
    await expect(page.getByLabel("Any status")).toBeHidden();
    await page.getByRole("button", { name: "Filters" }).click();
    await expect(page.getByLabel("Any status")).toBeVisible();
    await page.getByRole("link", { name: /Asha Verma/ }).click();
    await expect(page).toHaveURL(/\/leads\/[a-z0-9]+$/);
  });

  await test.step("lead page: one-tap contact, actions before history", async () => {
    await expect(page.getByRole("link", { name: "Call" })).toHaveAttribute("href", "tel:+919811100011");
    await expect(page.getByRole("link", { name: "WhatsApp" })).toHaveAttribute("href", "https://wa.me/919811100011");
    const actionsY = (await page.getByRole("heading", { name: "Actions" }).boundingBox())!.y;
    const activityY = (await page.getByRole("heading", { name: "Activity" }).boundingBox())!.y;
    expect(actionsY).toBeLessThan(activityY);
  });
});
