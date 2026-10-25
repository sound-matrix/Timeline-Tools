import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
test.skip(!process.env.DESK_FIXTURE, "Use playwright.desk.config.ts.");
const images = "docs/indigo-atelier";
test("Atelier portal, reduced motion, canvas fallback and narrow landing", async ({
  page,
}) => {
  mkdirSync(images, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator("body")).toHaveCSS(
    "background-color",
    "rgb(15, 18, 32)",
  );
  const portal = page.locator(".portal canvas");
  await expect(portal).toBeVisible();
  await page.getByRole("button", { name: "Pause visualizer" }).click();
  await page.waitForTimeout(100);
  const snapshot = await portal.evaluate((c: HTMLCanvasElement) =>
    c.toDataURL(),
  );
  await page.waitForTimeout(150);
  expect(await portal.evaluate((c: HTMLCanvasElement) => c.toDataURL())).toBe(
    snapshot,
  );
  await page.screenshot({ quality: 82, path: `${images}/landing-desktop.jpg` });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.reload();
  await page.waitForTimeout(150);
  const still = await portal.evaluate((c: HTMLCanvasElement) => c.toDataURL());
  await page.waitForTimeout(150);
  expect(await portal.evaluate((c: HTMLCanvasElement) => c.toDataURL())).toBe(
    still,
  );
  for (const width of [320, 375, 700]) {
    await page.setViewportSize({ width, height: 850 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    expect(
      (await page.locator(".sound-stage").boundingBox())!.height,
    ).toBeLessThanOrEqual(340);
  }
  await page.addInitScript(() => {
    HTMLCanvasElement.prototype.getContext = () => null;
  });
  await page.reload();
  await expect(
    page.getByRole("link", { name: "Start free" }).first(),
  ).toBeVisible();
  await expect(page.locator(".portal")).toBeVisible();
});
test("Atelier auth, shell, mobile menu and admin surfaces", async ({
  page,
  request,
}) => {
  await request.post("http://127.0.0.1:54331/__reset");
  await page.setViewportSize({ width: 1440, height: 1000 });
  for (const path of [
    "/signin",
    "/signup",
    "/forgot-password",
    "/reset-password",
  ]) {
    await page.goto(path);
    await expect(page.locator("body")).toHaveCSS(
      "background-color",
      "rgb(15, 18, 32)",
    );
  }
  await page.goto("/signin");
  await page.getByLabel("Email", { exact: true }).fill("desk@example.test");
  await page.getByLabel("Password", { exact: true }).fill("desk-test-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/dashboard/, { timeout: 15000 });
  await expect(page.locator(".side")).toHaveCSS("width", "240px");
  await expect(page.getByRole("button", { name: "Studio menu" })).toBeHidden();
  await expect(page.locator(".side-user")).toBeInViewport();
  await page.screenshot({ quality: 82, path: `${images}/shell-desktop.jpg` });
  await page.goto("/studio");
  await expect(
    page.getByRole("button", { name: "Submit", exact: true }),
  ).toBeEnabled();
  await page.screenshot({ quality: 82, path: `${images}/studio-desktop.jpg` });
  await page.setViewportSize({ width: 375, height: 850 });
  await page.getByRole("button", { name: "Studio menu" }).click();
  await page
    .getByRole("navigation", { name: "Workplace" })
    .getByRole("link", { name: "Master", exact: true })
    .click();
  await expect(page).toHaveURL(/master/);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(375);
  await request.post("http://127.0.0.1:54331/__admin");
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await expect(page.locator(".card").first()).toHaveCSS(
    "background-color",
    "rgb(26, 33, 54)",
  );
});
