import { test, expect } from "@playwright/test";

test("landing: responsive, animated only after idle, pause and navigation cleanup", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "Less noise.",
  );
  await expect(page.locator("canvas.wave-ready").first()).toBeVisible({
    timeout: 10000,
  });
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBeTruthy();
    await expect(
      page.getByRole("link", { name: "Start free", exact: true }).first(),
    ).toBeVisible();
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({
    path: info.outputPath("landing-desktop.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Pause motion" }).click();
  await expect(page.locator("canvas.wave-ready")).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      document.documentElement.classList.contains("lenis"),
    ),
  ).toBeFalsy();
  await page.getByRole("button", { name: "Resume motion" }).click();
  await expect(page.locator("canvas.wave-ready").first()).toBeVisible();
  await page.locator("#pricing").scrollIntoViewIfNeeded();
  await expect(page.getByRole("heading", { name: "₹499/month" })).toBeVisible();
  await page.getByRole("link", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/signin/);
  expect(
    await page.evaluate(() =>
      document.documentElement.classList.contains("lenis"),
    ),
  ).toBeFalsy();
  expect(errors).toEqual([]);
});

test("reduced motion retains content and no heavy animation canvas, including live preference changes", async ({
  page,
}, info) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Pause motion" })).toBeHidden();
  await expect(page.locator("canvas.wave-ready")).toHaveCount(0);
  await page.screenshot({
    path: info.outputPath("landing-mobile-reduced.png"),
    fullPage: true,
  });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(page.locator("canvas.wave-ready").first()).toBeVisible();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator("canvas.wave-ready")).toHaveCount(0);
});

test("billing preview is INR-only, bounded, accessible and never claims account credit", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/billing/success?minutes=300");
  await expect(page.locator("[data-minutes]")).toHaveText("+300 min", {
    timeout: 10000,
  });
  await expect(page.getByText(/No payment has been verified/)).toBeVisible();
  await expect(page.locator(".rupee-coin")).toHaveCount(3);
  await expect(page.locator(".rupee-coin").first()).toHaveCSS("opacity", "1");
  await expect(page.locator("[data-minutes]")).toHaveText("+300 min", {
    timeout: 10000,
  });
  expect(await page.locator("main").innerText()).not.toContain("$");
  await page.screenshot({
    path: info.outputPath("billing-preview.png"),
    fullPage: true,
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/billing/success?minutes=999999");
  await expect(page.locator("[data-minutes]")).toHaveText("+1,00,000 min");
  await page.goto("/billing/success?minutes=not-a-number");
  await expect(page.locator("[data-minutes]")).toHaveText("+300 min");
  expect(errors).toEqual([]);
});

test("landing remains useful with JavaScript disabled", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto("http://127.0.0.1:3100/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Start free", exact: true }).first(),
  ).toHaveAttribute("href", "/signup");
  await expect(
    page.getByRole("heading", { name: "₹4,999/month" }),
  ).toBeAttached();
  await context.close();
});
