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
    const submit = page.getByRole("button", { name: "Upload & queue job" });
    await expect(submit).toBeDisabled();
    await expect(page.getByText("Select your options above.")).toBeVisible();
    await expect(page.locator('input[type="checkbox"]:checked')).toHaveCount(0);
    await page.getByLabel("Choose audio or video").setInputFiles({
      name: `browser-${route}.wav`,
      mimeType: "audio/wav",
      buffer: wave,
    });
    await expect(submit).toBeDisabled();
    if (route === "cleanup") {
      await expect(page.getByLabel("Strength", { exact: true })).toBeDisabled();
      await page.getByLabel("Noise removal").check();
      await expect(submit).toBeDisabled();
      await page.getByLabel("Strength", { exact: true }).fill("45");
    }
    if (route === "master") {
      await page.getByLabel("Apply loudness", { exact: true }).check();
      await page
        .getByRole("button", { name: "Podcast -16", exact: true })
        .click();
      await expect(
        page.getByLabel("Target integrated loudness (LUFS)", { exact: true }),
      ).toHaveValue("-16");
      await page
        .getByLabel("Target integrated loudness (LUFS)", { exact: true })
        .fill("-18.5");
      await page.getByLabel("Apply limiter", { exact: true }).check();
      await page
        .getByLabel("True-peak ceiling (dBTP)", { exact: true })
        .fill("-1.5");
      await page
        .getByLabel("Limiter release (ms)", { exact: true })
        .fill("180");
      await expect(submit).toBeDisabled();
      await page
        .getByRole("group", { name: "Limiter knee", exact: true })
        .getByLabel("Soft", { exact: true })
        .check();
      await page.getByLabel("Apply compressor", { exact: true }).check();
      for (const [label, value] of [
        ["Threshold (dB)", "-22"],
        ["Ratio", "3.5"],
        ["Attack (ms)", "12"],
        ["Compressor release (ms)", "220"],
      ]) {
        await page.getByLabel(label, { exact: true }).fill(value);
      }
      await page
        .getByRole("group", { name: "Compressor knee", exact: true })
        .getByLabel("Soft", { exact: true })
        .check();
      await page
        .getByRole("group", { name: "Makeup gain", exact: true })
        .getByLabel("Manual", { exact: true })
        .check();
      await expect(submit).toBeDisabled();
      await page
        .getByLabel("Manual makeup gain (dB)", { exact: true })
        .fill("1.5");
      await page.getByLabel("Apply eq", { exact: true }).check();
      await expect(submit).toBeDisabled();
      await page.getByLabel("60 Hz", { exact: true }).check();
      await expect(submit).toBeDisabled();
      await page.getByLabel("60 Hz gain (dB)", { exact: true }).fill("1.5");
    }
    if (route === "subs") {
      await expect(page.getByLabel("Language", { exact: true })).toHaveValue(
        "",
      );
      await page.getByLabel("Language", { exact: true }).selectOption("Telugu");
      await expect(submit).toBeDisabled();
      await page.getByLabel("SRT", { exact: true }).check();
    }
    await expect(submit).toBeEnabled();
    const queued = page.waitForRequest(
      (request) =>
        request.url().endsWith("/api/jobs") && request.method() === "POST",
    );
    await submit.click();
    const payload = (await queued).postDataJSON();
    if (route === "master") {
      expect(payload.settings.loudness).toEqual({ enabled: true, lufs: -18.5 });
      expect(payload.settings.limiter).toEqual({
        enabled: true,
        ceiling: -1.5,
        knee: "soft",
        release: 180,
      });
      expect(payload.settings.compressor.knee).toBe("soft");
      expect(
        payload.settings.eq.bands.filter(
          (band: { enabled: boolean }) => band.enabled,
        ),
      ).toHaveLength(1);
    }
    await expect(
      page.getByRole("status", { name: "Job progress" }),
    ).toContainText("Queued.", { timeout: 30000 });
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
