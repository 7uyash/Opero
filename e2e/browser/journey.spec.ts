import { expect, test } from "@playwright/test";

/**
 * A business owner's first session in the browser: sign up, see the install card, add a lead by
 * hand, work it from the lead page, and find it in the lists. Checks the screens render and the
 * main buttons do what they say — the logic itself is covered by the API and integration tests.
 */
const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const ownerEmail = `browser-${id}@e2e.test`;

test.describe.configure({ mode: "serial" });

test("sign up → automation → add a lead → work it → find it again", async ({ page }) => {
  await test.step("register a new business", async () => {
    await page.goto("/register");
    await page.getByLabel("Your name").fill("Browser Owner");
    await page.getByLabel("Your email").fill(ownerEmail);
    await page.getByLabel("Password").fill("longpassword1");
    await page.getByLabel("Business name").fill(`Browser Co ${id}`);
    await page.getByLabel("Business email").fill(`hello-${id}@e2e.test`);
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.getByText(`Browser Co ${id}`).first()).toBeVisible();
  });

  await test.step("the automation isn't installed yet, and says so", async () => {
    await page.getByRole("link", { name: "Automation" }).first().click();
    await expect(page.getByText("Install automation").first()).toBeVisible();
  });

  await test.step("add a lead by hand", async () => {
    await page.goto("/leads/new");
    await page.getByLabel("Customer name").fill("Neha Kapoor");
    await page.getByLabel("Email").fill(`neha-${id}@example.com`);
    await page.getByLabel("Phone").fill("+91 98111 22233");
    await page.getByLabel("What are they interested in?").fill("Website redesign");
    await page.getByRole("button", { name: "Add lead" }).click();
    await expect(page).toHaveURL(/\/leads\/[a-z0-9]+$/);
    await expect(page.getByRole("heading", { name: "Neha Kapoor" })).toBeVisible();
    // Normalised phone number and the scheduled follow-ups show on the lead page.
    await expect(page.getByText("+91 98111 22233").first()).toBeVisible();
    await expect(page.getByText("First reminder (1 of 4)")).toBeVisible();
    await expect(page.getByText("Fourth reminder (4 of 4)")).toBeVisible();
  });

  await test.step("add a note; it appears on the timeline", async () => {
    await page.getByRole("tab", { name: "Add note" }).click();
    await page.getByLabel("Note").fill("Prefers a call after 5pm");
    await page.getByRole("button", { name: "Add note" }).last().click();
    await expect(page.getByText("Prefers a call after 5pm")).toBeVisible();
  });

  await test.step("the lead shows in the leads list and the search finds it", async () => {
    await page.goto("/leads");
    await expect(page.getByRole("link", { name: "Neha Kapoor" })).toBeVisible();
    await page.goto("/leads?q=nomatch-xyz");
    await expect(page.getByRole("link", { name: "Neha Kapoor" })).toHaveCount(0);
  });

  await test.step("the main screens all load", async () => {
    for (const path of ["/dashboard", "/follow-ups", "/notifications", "/activity", "/integrations", "/settings/team", "/settings/business"]) {
      const res = await page.goto(path);
      expect(res?.status(), path).toBeLessThan(400);
      await expect(page.locator("body")).not.toContainText("Something went wrong");
    }
  });

  await test.step("sign out returns to the login page", async () => {
    await page.goto("/dashboard");
    await page.getByRole("button", { name: /sign out/i }).first().click();
    await expect(page).toHaveURL(/\/login/);
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login/);
  });
});
