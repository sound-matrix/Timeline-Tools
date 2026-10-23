import { test, expect } from "@playwright/test";
test("sign in, queue each tool, preserve settings UI, responsive layout, sign out", async ({
  page,
}, testInfo) => {
  test.skip(
    !process.env.TEST_EMAIL || !process.env.TEST_PASSWORD,
    "Requires an isolated confirmed test user.",
  );
  await page.goto("/signin");
  await page.getByLabel("Email", { exact: true }).fill(process.env.TEST_EMAIL!);
  await page
    .getByLabel("Password", { exact: true })
    .fill(process.env.TEST_PASSWORD!);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/dashboard/, { timeout: 30000 });
  await expect(
    page.getByRole("heading", { name: "Dashboard", exact: true }),
  ).toBeVisible();
  const wave = Buffer.alloc(60);
  wave.write("RIFF");
  wave.writeUInt32LE(52, 4);
  wave.write("WAVEfmt ", 8);
  wave.writeUInt32LE(16, 16);
  wave.writeUInt16LE(1, 20);
  wave.writeUInt16LE(1, 22);
  wave.writeUInt32LE(8000, 24);
  wave.writeUInt32LE(16000, 28);
  wave.writeUInt16LE(2, 32);
  wave.writeUInt16LE(16, 34);
  wave.write("data", 36);
  wave.writeUInt32LE(16, 40);
  for (const route of ["cleanup", "master", "subs"]) {
    await page.goto("/" + route);
    await page.getByLabel("Choose audio or video").setInputFiles({
      name: `browser-${route}.wav`,
      mimeType: "audio/wav",
      buffer: wave,
    });
    const submit = page.getByRole("button", { name: "Upload & queue job" });
    await expect(submit).toBeDisabled();
    await expect(page.locator('input[type="checkbox"]:checked')).toHaveCount(0);
    await expect(
      page.getByText("Select your options above.", { exact: true }),
    ).toBeVisible();
    if (route === "cleanup") {
      await page.getByLabel("De-reverb", { exact: true }).check();
      await page.getByLabel("Strength", { exact: true }).fill("45");
    }
    if (route === "master") {
      await page.getByLabel("Apply loudness normalisation").check();
      await page
        .getByLabel("Target integrated loudness", { exact: true })
        .fill("-18.5");
      await page.getByLabel("Apply limiter", { exact: true }).check();
      await page.getByLabel("Ceiling", { exact: true }).fill("-1.5");
      await page.locator('input[name="limiterKnee"][value="soft"]').check();
      await page.getByLabel("Limiter release", { exact: true }).fill("230");
      await page.getByLabel("Apply compressor", { exact: true }).check();
      await page.getByLabel("Threshold", { exact: true }).fill("-28.5");
      await page.getByLabel("Ratio", { exact: true }).fill("4.5");
      await page.getByLabel("Attack", { exact: true }).fill("12.5");
      await page.getByLabel("Compressor release", { exact: true }).fill("320");
      await page.locator('input[name="compressorKnee"][value="soft"]').check();
      await page.locator('input[name="makeup"][value="manual"]').check();
      await page.getByLabel("Manual makeup gain", { exact: true }).fill("0");
      await page.getByLabel("Apply EQ", { exact: true }).check();
      await expect(submit).toBeDisabled();
      await page.getByLabel("60 Hz", { exact: true }).check();
      await page.getByLabel("60 Hz gain", { exact: true }).fill("1.5");
    }
    if (route === "subs") {
      await page.getByLabel("Language", { exact: true }).selectOption("Telugu");
      await page.getByLabel("SRT", { exact: true }).check();
    }
    await page.getByRole("button", { name: "Upload & queue job" }).click();
    await expect(page.locator('[role="status"]')).toContainText("Queued.", {
      timeout: 30000,
    });
  }
  await page.goto("/dashboard");
  for (const route of ["cleanup", "master", "subs"])
    await expect(
      page.getByRole("cell", { name: `browser-${route}.wav`, exact: false }),
    ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("dashboard-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 375, height: 812 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBeTruthy();
  await page.screenshot({
    path: testInfo.outputPath("dashboard-mobile.png"),
    fullPage: true,
  });
  await page.goto("/admin");
  await expect(page).toHaveURL(/dashboard/);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page).toHaveURL(/signin/);
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/signin/);
});
