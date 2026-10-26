import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";

test.skip(!process.env.DESK_FIXTURE, "Use playwright.desk.config.ts.");
const phase = process.env.THEME_SCREENSHOT_PHASE || "after";
const images = `docs/silver-theme/${phase}`;

// Use the existing isolated auth/API fixture; no live accounts or jobs.
test("silver theme: desktop and mobile route evidence", async ({
  page,
  request,
}) => {
  mkdirSync(images, { recursive: true });
  await request.post("http://127.0.0.1:54331/__reset");
  await page.emulateMedia({ reducedMotion: "reduce" });
  const shot = async (name: string) => {
    await page.evaluate(() => document.fonts.ready);
    if (phase === "after") {
      await expect(page.locator("body")).toHaveCSS(
        "background-color",
        "rgb(178, 186, 187)",
      );
      await expect(page.locator("html")).toHaveCSS("color-scheme", "light");
    }
    await page.screenshot({
      path: `${images}/${name}.png`,
      animations: "disabled",
    });
  };
  for (const [size, width, height] of [
    ["desktop", 1440, 1000],
    ["mobile", 390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.goto("/");
    await shot(`landing-${size}`);
  }
  await page.goto("/signin");
  await page.getByLabel("Email", { exact: true }).fill("desk@example.test");
  await page.getByLabel("Password", { exact: true }).fill("desk-test-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/dashboard/);
  for (const [size, width, height] of [
    ["desktop", 1440, 1000],
    ["mobile", 390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.goto("/studio");
    await expect(
      page.getByRole("button", { name: "Submit", exact: true }),
    ).toBeVisible();
    await shot(`studio-${size}`);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/editor");
  await page.getByRole("link", { name: "New project", exact: true }).click();
  await expect(page).toHaveURL(/editor\/[0-9a-f-]{36}/);
  await expect(page.getByRole("main", { name: "Editor Studio" })).toBeVisible();
  const rate = 48000,
    n = rate * 4,
    wav = Buffer.alloc(44 + n * 2);
  wav.write("RIFF");
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++)
    wav.writeInt16LE(
      Math.round(
        Math.sin((i / rate) * 440 * Math.PI * 2) *
          (5000 + 5000 * Math.sin((i / rate) * 5)),
      ),
      44 + i * 2,
    );
  const transfer = await page.evaluateHandle((data) => {
    const dt = new DataTransfer();
    dt.items.add(
      new File([new Uint8Array(data)], "Silver session.wav", {
        type: "audio/wav",
      }),
    );
    return dt;
  }, Array.from(wav));
  const canvas = page.getByLabel("Timeline waveform canvas");
  const box = (await canvas.boundingBox())!;
  await canvas.dispatchEvent("drop", {
    dataTransfer: transfer,
    clientX: box.x + 190,
    clientY: box.y + 100,
  });
  await expect(page.locator(".pro-header")).toHaveCount(1);
  await expect(
    page.getByRole("status", { name: "Editor save status" }),
  ).toHaveText("Saved", { timeout: 20000 });
  for (const [size, width, height] of [
    ["desktop", 1440, 1000],
    ["mobile", 390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    await shot(`editor-${size}`);
  }
  if (phase === "after") {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const selectedBox = (await canvas.boundingBox())!;
    await page.mouse.click(selectedBox.x + 240, selectedBox.y + 70);
    await page.screenshot({
      path: `${images}/editor-selected.png`,
      animations: "disabled",
    });
  }
  await request.post("http://127.0.0.1:54331/__admin");
  for (const [size, width, height] of [
    ["desktop", 1440, 1000],
    ["mobile", 390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.goto("/admin");
    await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
    await shot(`admin-${size}`);
  }
  if (phase === "after") {
    for (const path of [
      "/dashboard",
      "/cleanup",
      "/master",
      "/subs",
      "/podcast",
      "/plans",
      "/editor",
      "/signin",
      "/signup",
      "/forgot-password",
      "/reset-password",
      "/auth/invalid",
      "/suspended",
    ]) {
      await page.goto(path);
      await expect(page.locator("body")).toHaveCSS(
        "background-color",
        "rgb(178, 186, 187)",
      );
    }
  }
});
