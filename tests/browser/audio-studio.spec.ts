import { test, expect, type Page } from "@playwright/test";
import { unzipSync, strFromU8 } from "fflate";

test.skip(!process.env.DESK_FIXTURE, "Use playwright.desk.config.ts.");
const fixture = "http://127.0.0.1:54331";
const owner = "11111111-1111-4111-8111-111111111111";
const wave = Buffer.alloc(16044);
wave.write("RIFF");
wave.writeUInt32LE(wave.length - 8, 4);
wave.write("WAVEfmt ", 8);
wave.writeUInt32LE(16, 16);
wave.writeUInt16LE(1, 20);
wave.writeUInt16LE(1, 22);
wave.writeUInt32LE(8000, 24);
wave.writeUInt32LE(16000, 28);
wave.writeUInt16LE(2, 32);
wave.writeUInt16LE(16, 34);
wave.write("data", 36);
wave.writeUInt32LE(16000, 40);
const file = { name: "voice.wav", mimeType: "audio/wav", buffer: wave };
const script = "Narrator: Hello there\nNarrator: Goodbye";
async function files(page: Page) {
  await page
    .getByLabel("Guide track", { exact: true })
    .setInputFiles({ ...file, name: "guide.wav" });
  await page
    .getByLabel("Voice / dub tracks", { exact: true })
    .setInputFiles(file);
  await page.getByLabel("Script", { exact: true }).fill(script);
}
async function options(page: Page) {
  await page.getByLabel("Dialogue level (LUFS)", { exact: true }).fill("-23");
  await page
    .getByLabel("Final master target (LUFS)", { exact: true })
    .fill("-16");
  await page.getByLabel("Room tone fill", { exact: true }).selectOption("off");
  await page
    .getByLabel("Subtitles from script", { exact: true })
    .selectOption("on");
  await page.getByLabel("SRT", { exact: true }).check();
}
test.beforeEach(async ({ page, request }) => {
  await request.post(fixture + "/__reset");
  await page.goto("/signin");
  await page.getByLabel("Email", { exact: true }).fill("desk@example.test");
  await page.getByLabel("Password", { exact: true }).fill("desk-test-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/dashboard/);
  await page.getByRole("link", { name: "Audio Studio", exact: true }).click();
  await expect(page).toHaveURL(/\/studio$/);
});

test("studio files -> explicit choices -> real ZIP job -> live status -> alignment and downloads", async ({
  page,
  request,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const start = page.getByRole("button", {
    name: "Auto-mix & Master",
    exact: true,
  });
  await expect(
    page.getByRole("heading", { name: "Audio Studio", exact: true }),
  ).toBeVisible();
  await expect(start).toBeDisabled();
  await expect(
    page.getByRole("region", { name: "Auto-mix settings" }),
  ).toHaveCount(0);
  await files(page);
  await expect(
    page.getByRole("region", { name: "Multitrack timeline" }),
  ).toBeVisible();
  const opts = page.getByRole("region", { name: "Auto-mix settings" });
  await expect(opts).toBeVisible();
  expect((await opts.boundingBox())!.y).toBeGreaterThan(
    (await page.getByRole("region", { name: "Studio files" }).boundingBox())!.y,
  );
  for (const label of [
    "Dialogue level (LUFS)",
    "Final master target (LUFS)",
    "Room tone fill",
    "Subtitles from script",
  ])
    await expect(page.getByLabel(label, { exact: true })).toHaveValue("");
  await page.getByRole("button", { name: "Podcast -16", exact: true }).click();
  await expect(page.getByLabel("Dialogue level (LUFS)")).toHaveValue("-16");
  await expect(page.getByLabel("Final master target (LUFS)")).toHaveValue("");
  await options(page);
  await page
    .getByLabel("Music / SFX bed (optional)", { exact: true })
    .setInputFiles({ ...file, name: "bed.wav" });
  await expect(start).toBeDisabled();
  await expect(page.getByLabel("Music ducking (dB)")).toHaveValue("");
  await page.getByLabel("Music ducking (dB)").fill("0");
  await expect(start).toBeEnabled();
  await page.getByLabel("SRT", { exact: true }).uncheck();
  await expect(start).toBeDisabled();
  await page.getByLabel("SRT", { exact: true }).check();
  await page.getByLabel("VTT", { exact: true }).check();
  await page.screenshot({
    path: info.outputPath("audio-studio-desktop.png"),
    fullPage: true,
  });
  let zip: Buffer | null = null;
  await page.route("**/storage/v1/object/uploads/**", async (route) => {
    const body = route.request().postDataBuffer()!;
    const contentType = route.request().headers()["content-type"];
    if (contentType?.startsWith("multipart/form-data")) {
      const form = await new Response(new Uint8Array(body), {
        headers: { "Content-Type": contentType },
      }).formData();
      for (const value of form.values())
        if (typeof value !== "string")
          zip = Buffer.from(await value.arrayBuffer());
    } else zip = body;
    await route.continue();
  });
  const queued = page.waitForResponse(
    (r) => r.url().endsWith("/api/jobs") && r.request().method() === "POST",
  );
  await start.click();
  const response = await queued;
  expect(response.status()).toBe(201);
  const payload = response.request().postDataJSON();
  expect(payload.type).toBe("studio");
  expect(payload.input_path).toMatch(new RegExp(`^${owner}/.*\\.zip$`));
  expect(payload.settings).toEqual({
    dialogue_lufs: -23,
    master_lufs: -16,
    has_bed: true,
    ducking_db: 0,
    room_tone: { enabled: false },
    subtitles: { enabled: true, formats: ["srt", "vtt"] },
  });
  expect(Buffer.byteLength(JSON.stringify(payload.settings))).toBeLessThan(
    8192,
  );
  const unpacked = unzipSync(zip!);
  expect(strFromU8(unpacked["script.txt"])).toBe(script);
  expect(JSON.parse(strFromU8(unpacked["manifest.json"])).voices).toEqual([
    { file: "voice-0.wav", speaker: "", name: "voice.wav" },
  ]);
  const { id } = await response.json();
  const live = page.getByRole("region", { name: "Live processing" });
  await expect(live.getByRole("status", { name: "Job progress" })).toHaveText(
    "Queued",
  );
  await request.post(fixture + "/__job", {
    data: { id, status: "processing" },
  });
  await expect(live.getByRole("status")).toHaveText("Processing", {
    timeout: 10000,
  });
  const timeline = page.getByRole("region", { name: "Multitrack timeline" });
  await expect(timeline.locator(".studio-pending-clip")).toHaveCSS(
    "animation-name",
    "studio-snap",
  );
  await page.getByRole("button", { name: "Pause clip motion" }).click();
  await expect(timeline.locator(".studio-pending-clip")).toHaveCSS(
    "animation-name",
    "none",
  );
  await page.getByRole("button", { name: "Resume clip motion" }).click();
  await expect(timeline.locator(".studio-pending-clip")).toHaveCSS(
    "animation-name",
    "studio-snap",
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(timeline.locator(".studio-pending-clip")).toHaveCSS(
    "animation-name",
    "none",
  );
  await page.setViewportSize({ width: 375, height: 812 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: info.outputPath("audio-studio-live-mobile.png"),
    fullPage: true,
  });
  await request.post(fixture + "/__job", {
    data: {
      id,
      status: "done",
      duration_sec: 6,
      output_paths: [
        "studio-mix.wav",
        "alignment-report.json",
        "subtitles.srt",
        "subtitles.vtt",
      ].map((f) => `${owner}/${id}/${f}`),
      report: {
        method: "heuristic-v1",
        duration: 6,
        note: "Heuristic timing: review before publishing.",
        tracks: [{ id: "voice-0", speaker: "", name: "voice.wav" }],
        lines: [
          {
            text: "Hello there",
            speaker: "Narrator",
            start: 0.5,
            end: 1.5,
            source_start: 1,
            source_end: 2,
            track: "voice-0",
            confidence: 0.45,
            flags: ["Low confidence: review timing"],
          },
        ],
      },
    },
  });
  await expect(live.getByRole("status")).toHaveText("Done", { timeout: 10000 });
  await expect(timeline.getByText("45 / 100 · Low confidence")).toBeVisible();
  await expect(
    live.getByRole("link", { name: "Download alignment report (JSON)" }),
  ).toHaveAttribute("href", `/api/jobs/${id}/download?index=1`);
  for (const name of ["Download WAV", "Download SRT", "Download VTT"])
    await expect(live.getByRole("link", { name, exact: true })).toBeVisible();
  await timeline.getByRole("button", { name: "Review line 1" }).click();
  await expect(timeline.locator(".studio-selected-row")).toHaveCount(1);
  await expect(page).toHaveURL(/\/studio$/);
  await page.reload();
  await expect(page.getByText("45 / 100 · Low confidence")).toBeVisible();
  expect(errors).toEqual([]);
});

test("speaker mapping, timed script exports, reduced motion and input validation", async ({
  page,
}) => {
  await files(page);
  await options(page);
  await page
    .getByLabel("Voice / dub tracks", { exact: true })
    .setInputFiles([file, { ...file, name: "meera.wav" }]);
  const start = page.getByRole("button", {
    name: "Auto-mix & Master",
    exact: true,
  });
  await expect(start).toBeDisabled();
  await page.getByLabel("Speaker label for voice 1").fill("Narrator");
  await page.getByLabel("Speaker label for voice 2").fill("Meera");
  await page
    .getByLabel("Script", { exact: true })
    .fill(
      "1\n00:00:00,000 --> 00:00:01,000\nNarrator: Hello\n\n2\n00:00:01,100 --> 00:00:02,000\nMeera: Hi",
    );
  await expect(start).toBeEnabled();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export SRT / VTT" }).click();
  expect((await download).suggestedFilename()).toBe("script.srt");
  await page.getByLabel("Room tone fill").selectOption("on");
  await expect(start).toBeDisabled();
  await page.getByLabel("Room tone amount (%)").fill("0");
  await expect(start).toBeEnabled();
  await page.getByLabel("Guide track", { exact: true }).setInputFiles({
    name: "bad.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("bad"),
  });
  await expect(start).toBeDisabled();
  await expect(page.getByRole("alert")).toContainText(
    "Choose non-empty audio/video files",
  );
  const status = await page.evaluate(async (owner) => {
    const r = await fetch("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "studio",
        file_name: "foreign.zip",
        input_path: "22222222-2222-4222-8222-222222222222/a.zip",
        settings: {
          dialogue_lufs: -23,
          master_lufs: -16,
          has_bed: false,
          room_tone: { enabled: false },
          subtitles: { enabled: false },
        },
      }),
    });
    return r.status;
  }, owner);
  expect(status).toBe(400);
});
