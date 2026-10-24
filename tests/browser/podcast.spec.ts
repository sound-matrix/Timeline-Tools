import { test, expect } from "@playwright/test";
const fixture = "http://127.0.0.1:54331",
  owner = "11111111-1111-4111-8111-111111111111";
test.skip(!process.env.DESK_FIXTURE, "Use playwright.desk.config.ts");
test("Podcast file-only start, speaker lanes, synchronized edits, autosave and default export", async ({
  page,
  request,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await request.post(fixture + "/__reset");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/signin");
  await page.getByLabel("Email", { exact: true }).fill("desk@example.test");
  await page.getByLabel("Password", { exact: true }).fill("desk-test-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/dashboard/);
  await page.getByRole("link", { name: "Podcast", exact: true }).click();
  const start = page.getByRole("button", {
    name: "Start Processing",
    exact: true,
  });
  await expect(start).toBeEnabled();
  await start.click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Choose at least one" }),
  ).toBeVisible();
  await page
    .getByLabel("Audio or video recordings", { exact: true })
    .setInputFiles({
      name: "conversation.mp4",
      mimeType: "video/mp4",
      buffer: Buffer.from("fixture upload"),
    });
  await expect(
    page.getByLabel("Number of speakers", { exact: true }),
  ).toHaveValue("");
  const queued = page.waitForResponse(
    (r) => r.url().endsWith("/api/jobs") && r.request().method() === "POST",
  );
  await start.click();
  const response = await queued;
  expect(response.status()).toBe(201);
  const id = (await response.json()).id;
  expect(response.request().postDataJSON().settings.cleanup.noise.amount).toBe(
    60,
  );
  const words = [
    { w: "Hello", start: 0, end: 1, speaker: "s0", conf: 0.9 },
    { w: "world", start: 1.2, end: 2, speaker: "s0", conf: 0.9 },
    { w: "welcome", start: 3, end: 4, speaker: "s1", conf: 0.9 },
    { w: "again", start: 5, end: 6, speaker: "s1", conf: 0.8 },
  ];
  const podcast = {
    duration: 8,
    revision: 1,
    exports_count: 0,
    transcript: {
      speakers: [
        { id: "s0", name: "Speaker 1" },
        { id: "s1", name: "Speaker 2" },
      ],
      words,
      segments: [],
      method: "synthetic",
    },
    edits: { operations: [], corrections: {}, speaker_names: {} },
    media: [
      {
        media_index: 0,
        name: "conversation.mp4",
        offset_sec: 0,
        duration: 8,
        proxy_path: `${owner}/${id}/proxy-0.mp4`,
      },
    ],
  };
  await request.post(fixture + "/__job", {
    data: {
      id,
      status: "done",
      duration_sec: 8,
      output_paths: [
        `${owner}/${id}/podcast-source.wav`,
        `${owner}/${id}/podcast-preview.mp3`,
        `${owner}/${id}/podcast-peaks.json`,
        `${owner}/${id}/proxy-0.mp4`,
      ],
      podcast,
    },
  });
  const editor = page.getByRole("region", {
    name: "Podcast editor",
    exact: true,
  });
  await expect(editor).toBeVisible({ timeout: 20000 });
  await expect(editor.locator(".podcast-lane")).toHaveCount(2);
  await expect(
    editor.getByLabel("Podcast video preview", { exact: true }),
  ).toBeVisible();
  await editor
    .getByRole("button", { name: "Select transcript word 1", exact: true })
    .click();
  await expect(
    editor.getByRole("button", { name: "Timeline word 1: Hello", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await editor.getByRole("button", { name: "Mute words", exact: true }).click();
  await editor.getByRole("button", { name: "Undo", exact: true }).click();
  await editor.getByRole("button", { name: "Redo", exact: true }).click();
  await editor.getByLabel("Transcript word 1", { exact: true }).fill("Hi");
  await editor.getByLabel("s0", { exact: true }).fill("Host");
  await editor.getByLabel("Range start (seconds)", { exact: true }).fill("2");
  await editor.getByLabel("Range end (seconds)", { exact: true }).fill("3");
  await editor
    .getByRole("button", { name: "Cut range between dialogues", exact: true })
    .click();
  await expect(
    editor.getByRole("status", { name: "Podcast save status", exact: true }),
  ).toHaveText("Saved", { timeout: 10000 });
  const ruler = editor.getByRole("slider", {
    name: "Podcast time ruler",
    exact: true,
  });
  await ruler.scrollIntoViewIfNeeded();
  const box = (await ruler.boundingBox())!;
  await page.mouse.click(box.x + 4 * 30, box.y + 10);
  await expect
    .poll(() =>
      editor
        .getByLabel("Podcast video preview", { exact: true })
        .evaluate((v: HTMLVideoElement) => v.currentTime),
    )
    .toBeCloseTo(4, 0);
  await page.screenshot({
    path: info.outputPath("podcast-editor.png"),
    fullPage: true,
  });
  const exported = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/jobs") &&
      r.request().postDataJSON()?.type === "podcast_export",
  );
  await editor
    .getByRole("button", { name: "Export audio · included", exact: true })
    .click();
  const result = await exported;
  expect(result.status()).toBe(201);
  expect(result.request().postDataJSON().settings.mp3).toEqual({
    bitrate_kbps: 320,
    sample_rate: 48000,
  });
  expect(errors).toEqual([]);
  await page.setViewportSize({ width: 375, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
});
