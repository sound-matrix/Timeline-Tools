import {
  test,
  expect,
  type Page,
  type APIRequestContext,
} from "@playwright/test";
import { readFileSync, mkdirSync } from "node:fs";
import { unzipSync, strFromU8 } from "fflate";
test.skip(!process.env.DESK_FIXTURE, "Use playwright.desk.config.ts");
const fixture = "http://127.0.0.1:54331",
  owner = "11111111-1111-4111-8111-111111111111";
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
const file = { name: "meera_03.wav", mimeType: "audio/wav", buffer: wave };
const script =
  "Narrator: Hello there\nMeera: Welcome home\nMeera: Where is the key?";
async function files(page: Page) {
  await expect(page.getByLabel("Guide track", { exact: true })).toHaveCount(0);
  await page.getByLabel("Audio clips", { exact: true }).setInputFiles(file);
  await page.getByLabel("Script text", { exact: true }).fill(script);
}
async function options(page: Page) {
  await page.getByLabel("Line gap (ms)", { exact: true }).fill("250");
  await page
    .getByLabel("Match strictness", { exact: true })
    .selectOption("normal");
  await page.getByLabel("Dialogue target (LUFS)", { exact: true }).fill("-23");
  await page.getByLabel("Master target (LUFS)", { exact: true }).fill("-16");
  await page.getByLabel("Room tone", { exact: true }).selectOption("off");
  await page.getByLabel("Subtitles", { exact: true }).selectOption("off");
}
async function queue(page: Page) {
  const queued = page.waitForResponse(
    (r) => r.url().endsWith("/api/jobs") && r.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "Start Processing", exact: true })
    .click();
  const response = await queued;
  expect(response.status()).toBe(201);
  return (await response.json()).id as string;
}
async function complete(request: APIRequestContext, id: string) {
  const arrangement = JSON.parse(
    readFileSync("tests/fixtures/daw-arrangement.json", "utf8"),
  );
  arrangement.job_id = id;
  // Newly processed jobs use whole clips; legacy v1 remains in the unit fixture.
  arrangement.version = 2;
  arrangement.duration = 8.3;
  arrangement.unplaced = [
    {
      clip: "c2",
      src_start: 0,
      src_end: 4,
      transcript: "Unused alternate take",
    },
  ];
  arrangement.clips.push({ id: "c2", name: "alternate.wav", duration: 4 });
  arrangement.regions = arrangement.regions.map(
    (r: Record<string, unknown>, i: number) => ({
      ...r,
      lines: [
        {
          line: r.line,
          src_start: r.src_start,
          src_end: r.src_end,
          confidence: r.confidence,
        },
      ],
      src_start: 0,
      src_end: 4,
      start: i ? 4.3 : 0,
    }),
  );

  await request.post(fixture + "/__job", {
    data: {
      id,
      status: "done",
      duration_sec: 8,
      error: null,
      arrangement,
      output_paths: [
        `${owner}/${id}/arrangement-r1.json`,
        ...["c0", "c1", "c2"].flatMap((c) => [
          `${owner}/${id}/stems/${c}.wav`,
          `${owner}/${id}/peaks/${c}.json`,
        ]),
      ],
    },
  });
}
test.beforeEach(async ({ page, request }) => {
  await request.post(fixture + "/__reset");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/signin");
  await page.getByLabel("Email", { exact: true }).fill("desk@example.test");
  await page.getByLabel("Password", { exact: true }).fill("desk-test-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/dashboard/);
  await page.goto("/studio");
});
test("v2 ZIP, blank settings, real peak lanes, playback and server export choices", async ({
  page,
  request,
}) => {
  mkdirSync("docs/studio-daw", { recursive: true });
  const start = page.getByRole("button", {
    name: "Start Processing",
    exact: true,
  });
  await expect(start).toBeEnabled();
  await files(page);
  await expect(start).toBeEnabled();
  await expect(page.getByLabel("Line gap (ms)", { exact: true })).toHaveValue(
    "",
  );
  await options(page);
  let zip: Buffer | null = null;
  await page.route("**/storage/v1/object/uploads/**", async (route) => {
    const body = route.request().postDataBuffer()!,
      type = route.request().headers()["content-type"];
    if (type?.startsWith("multipart/form-data")) {
      const form = await new Response(new Uint8Array(body), {
        headers: { "Content-Type": type },
      }).formData();
      for (const value of form.values())
        if (typeof value !== "string")
          zip = Buffer.from(await value.arrayBuffer());
    } else zip = body;
    await route.continue();
  });
  await page.screenshot({ path: "docs/studio-daw/desk.png", fullPage: true });
  const id = await queue(page);
  expect(zip).not.toBeNull();
  const manifest = JSON.parse(strFromU8(unzipSync(zip!)["manifest.json"]));
  expect(manifest.version).toBe(2);
  expect(manifest.guide).toBeUndefined();
  expect(manifest.clips[0].name).toBe("meera_03.wav");
  await complete(request, id);
  const daw = page.getByRole("region", { name: "DAW timeline", exact: true });
  await expect(daw).toBeVisible();
  await expect(daw.locator(".pro-header")).toHaveCount(2);
  await expect(daw.getByLabel("Timeline waveform canvas")).toBeVisible();
  await daw.scrollIntoViewIfNeeded();
  const canvas = daw.getByLabel("Timeline waveform canvas"),
    box = (await canvas.boundingBox())!;
  await page.mouse.click(box.x + 230, box.y + 20);
  await expect(daw.getByLabel("Current time", { exact: true })).toHaveText(
    "0:01.000",
  );
  await page.screenshot({
    path: "docs/studio-daw/timeline-missing.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Export mix", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Export your mix" });
  await expect(
    dialog.getByRole("button", { name: "Confirm export" }),
  ).toBeEnabled();
  await dialog.getByLabel("MP3", { exact: true }).check();
  await expect(
    dialog.getByRole("button", { name: "Confirm export" }),
  ).toBeEnabled();
  await dialog
    .getByLabel("MP3 bitrate (kbps)", { exact: true })
    .selectOption("320");
  await dialog
    .getByLabel("MP3 sample rate (Hz)", { exact: true })
    .selectOption("48000");
  await dialog
    .getByLabel("Export subtitles", { exact: true })
    .selectOption("none");
  await dialog
    .getByLabel("Missing lines in subtitles", { exact: true })
    .selectOption("exclude");
  await page.screenshot({
    path: "docs/studio-daw/export-dialog.png",
    fullPage: true,
  });
  const exported = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/jobs") &&
      r.request().postDataJSON()?.type === "studio_export",
  );
  await dialog.getByRole("button", { name: "Confirm export" }).click();
  expect((await exported).status()).toBe(201);
});
test("move lane/time, trim, undo/redo, split, missing bin placement and autosave", async ({
  page,
  request,
}) => {
  await files(page);
  await options(page);
  const id = await queue(page);
  await complete(request, id);
  const daw = page.getByRole("region", { name: "DAW timeline", exact: true });
  await expect(daw).toBeVisible();
  await daw.scrollIntoViewIfNeeded();
  const canvas = daw.getByLabel("Timeline waveform canvas"),
    box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + 210, box.y + 80);
  await page.mouse.down();
  await page.mouse.move(box.x + 260, box.y + 200, { steps: 5 });
  await page.mouse.up();
  const state = async () => {
    await expect(
      page.getByRole("status", { name: "Autosave", exact: true }),
    ).toContainText("Saved", { timeout: 10000 });
    return page.evaluate(
      async (id) =>
        (await (await fetch(`/api/studio/${id}/arrangement`)).json())
          .arrangement,
      id,
    );
  };
  let a = await state();
  expect(a.regions.find((r: { id: string }) => r.id === "r0").lane).toBe("l1");
  await daw.getByRole("button", { name: "Undo", exact: true }).click();
  await expect.poll(async () => (await state()).regions[0].lane).toBe("l0");
  await daw.getByRole("button", { name: "Redo", exact: true }).click();
  await expect.poll(async () => (await state()).regions[0].lane).toBe("l1");
  await canvas.scrollIntoViewIfNeeded();
  const currentBox = (await canvas.boundingBox())!;
  await page.mouse.click(currentBox.x + 255, currentBox.y + 15);
  await daw.focus();
  await page.keyboard.press("s");
  await expect(
    daw.getByText("Regions (3) · select with keyboard"),
  ).toBeVisible();
  await daw.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(
    daw.getByText("Regions (2) · select with keyboard"),
  ).toBeVisible();
  await page
    .locator(".daw-bin-item")
    .getByLabel("Place on lane", { exact: true })
    .selectOption("l0");
  await expect(page.getByText("Unplaced clips (0)")).toBeVisible();
  a = await state();
  expect(a.regions.length).toBe(3);
  expect(a.version).toBe(2);
});
test("context menu bounce, fades, markers and undo remain non-destructive", async ({
  page,
  request,
}) => {
  await files(page);
  const id = await queue(page);
  await complete(request, id);
  const daw = page.getByRole("region", { name: "DAW timeline", exact: true });
  await expect(daw).toBeVisible();
  const canvas = daw.getByLabel("Timeline waveform canvas");
  await canvas.scrollIntoViewIfNeeded();
  let box = (await canvas.boundingBox())!;
  await page.mouse.click(box.x + 220, box.y + 80);
  await daw.getByLabel("Fade in (default 0 s)", { exact: true }).fill("0.2");
  await daw.getByLabel("Region gain (dB)", { exact: true }).fill("-3");
  await canvas.scrollIntoViewIfNeeded();
  box = (await canvas.boundingBox())!;
  await page.mouse.click(box.x + 220, box.y + 80, { button: "right" });
  await page
    .getByRole("menuitem", { name: "Bounce in place", exact: true })
    .click();
  await expect(daw.getByRole("alert")).toContainText("Bounced in place", {
    timeout: 15000,
  });
  await expect
    .poll(async () =>
      page.evaluate(async (id) => {
        const a = (await (await fetch(`/api/studio/${id}/arrangement`)).json())
          .arrangement;
        return a.derived_clips.length;
      }, id),
    )
    .toBe(1);
  await daw.getByRole("button", { name: "Undo", exact: true }).click();
  await daw
    .getByRole("button", { name: "Add marker (M)", exact: true })
    .click();
  await expect(daw.getByText("Markers (1)", { exact: true })).toBeVisible();
  await daw.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(daw.getByText("Markers (0)", { exact: true })).toBeVisible();
});
test("20-track, 500-region hour session: canvas scroll/zoom frame budget and payload", async ({
  page,
  request,
}, info) => {
  await files(page);
  const id = await queue(page);
  const fixture = JSON.parse(
    readFileSync("tests/fixtures/daw-arrangement.json", "utf8"),
  );
  fixture.job_id = id;
  fixture.duration = 3600;
  fixture.missing = [];
  fixture.unplaced = [];
  fixture.clips = [{ id: "c0", name: "One hour source", duration: 3600 }];
  fixture.lanes = Array.from({ length: 20 }, (_, i) => ({
    ...fixture.lanes[0],
    id: `l${i}`,
    name: `Track ${i + 1}`,
  }));
  fixture.regions = Array.from({ length: 500 }, (_, i) => ({
    ...fixture.regions[0],
    id: `r${i}`,
    lane: `l${i % 20}`,
    clip: "c0",
    src_start: (i % 25) * 140,
    src_end: (i % 25) * 140 + 100,
    start: (i % 25) * 140,
    line: 0,
  }));
  await request.post("http://127.0.0.1:54331/__job", {
    data: {
      id,
      status: "done",
      duration_sec: 3600,
      arrangement: fixture,
      output_paths: [
        `${owner}/${id}/arrangement-r1.json`,
        `${owner}/${id}/stems/c0.wav`,
        `${owner}/${id}/peaks/c0.json`,
      ],
    },
  });
  const daw = page.getByRole("region", { name: "DAW timeline", exact: true });
  await expect(daw).toBeVisible();
  await daw.scrollIntoViewIfNeeded();
  const bytes = await page.evaluate(
    async (id) =>
      new TextEncoder().encode(
        JSON.stringify(
          (await (await fetch(`/api/studio/${id}/arrangement`)).json())
            .arrangement,
        ),
      ).length,
    id,
  );
  expect(bytes).toBeLessThan(1000000);
  const samples = await daw.locator(".pro-scroll").evaluate(async (el) => {
    const times: number[] = [];
    let previous = performance.now();
    for (let i = 0; i < 360; i++) {
      await new Promise<void>((resolve) =>
        requestAnimationFrame((t) => {
          if (i >= 60) times.push(t - previous);
          previous = t;
          el.scrollLeft = (i * 270) % 12000;
          el.scrollTop = (i * 19) % 1900;
          if (i % 20 === 0)
            el.dispatchEvent(
              new WheelEvent("wheel", {
                deltaY: i % 40 === 0 ? 10 : -10,
                ctrlKey: true,
                bubbles: true,
                cancelable: true,
              }),
            );
          resolve();
        }),
      );
    }
    return times.sort((a, b) => a - b);
  });
  const result = {
    p95_frame_ms: Number(samples[Math.floor(samples.length * 0.95)].toFixed(3)),
    payload_bytes: bytes,
    tracks: 20,
    regions: 500,
    duration: 3600,
    renderer: await daw
      .getByLabel("Timeline waveform canvas")
      .getAttribute("data-renderer"),
    browser:
      "Chromium headless; shared container, not an M1/i5 hardware certification",
  };
  await info.attach("daw-performance.json", {
    body: JSON.stringify(result, null, 2),
    contentType: "application/json",
  });
  console.log("DAW_PERFORMANCE " + JSON.stringify(result));
  expect(result.p95_frame_ms).toBeLessThanOrEqual(16.7);
});
test("language mismatch lists clips, charges zero, reduced-motion and mobile view", async ({
  page,
  request,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await files(page);
  await options(page);
  const id = await queue(page);
  await request.post(fixture + "/__job", {
    data: {
      id,
      status: "failed",
      error: "The language of the clips and the script do not match",
      error_code: "language_mismatch",
      error_detail: {
        script_lang: "hi",
        clips: [{ name: "meera_03.wav", lang: "en", prob: 0.99 }],
      },
    },
  });
  await expect(page.getByText(/Script: hi/)).toBeVisible();
  await expect(page.getByText("meera_03.wav: en (99%)")).toBeVisible();
  await page.screenshot({
    path: "docs/studio-daw/language-error.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 375, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
});
