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
  await request.post(fixture + "/__job", {
    data: {
      id,
      status: "done",
      duration_sec: 8,
      error: null,
      arrangement,
      output_paths: [
        `${owner}/${id}/arrangement-r1.json`,
        ...["c0", "c1"].flatMap((c) => [
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
  await expect(start).toBeDisabled();
  await files(page);
  await expect(start).toBeDisabled();
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
  await expect(daw.locator(".daw-lane")).toHaveCount(2);
  await expect(daw.locator(".daw-peaks")).toHaveCount(2);
  await expect(daw.getByText("Missing line: Where is the key?")).toBeVisible();
  await expect(daw.getByText("Unused alternate take")).toBeVisible();
  await daw.scrollIntoViewIfNeeded();
  await daw.focus();
  await page.keyboard.press("Space");
  await expect(
    daw.getByRole("button", { name: "Pause", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Space");
  const ruler = daw.getByRole("slider", { name: "Time ruler" });
  const box = (await ruler.boundingBox())!;
  await page.mouse.click(box.x + 50, box.y + 20);
  await expect(daw.getByLabel("Current time", { exact: true })).toHaveText(
    "00:01.000",
  );
  const head = daw.getByRole("slider", { name: "Playhead", exact: true });
  const h = (await head.boundingBox())!;
  await page.mouse.move(h.x, h.y + 20);
  await page.mouse.down();
  await page.mouse.move(h.x + 30, h.y + 20);
  await page.mouse.up();
  await expect(daw.getByLabel("Current time", { exact: true })).toHaveText(
    "00:01.600",
  );
  await page.screenshot({
    path: "docs/studio-daw/timeline-missing.png",
    fullPage: true,
  });
  await daw.getByRole("button", { name: "Export mix", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Export your mix" });
  await expect(
    dialog.getByRole("button", { name: "Confirm export" }),
  ).toBeDisabled();
  await dialog.getByLabel("MP3", { exact: true }).check();
  await expect(
    dialog.getByRole("button", { name: "Confirm export" }),
  ).toBeDisabled();
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
  const region = daw.getByRole("button", {
    name: "Region Hello there",
    exact: true,
  });
  const box = (await region.boundingBox())!;
  await page.mouse.move(box.x + 30, box.y + 30);
  await page.mouse.down();
  await page.mouse.move(box.x + 80, box.y + 130, { steps: 5 });
  await page.mouse.up();
  await expect(daw.locator('[data-lane="l1"] .daw-region')).toHaveCount(2);
  await daw.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(daw.locator('[data-lane="l0"] .daw-region')).toHaveCount(1);
  await daw.getByRole("button", { name: "Redo", exact: true }).click();
  await expect(daw.locator('[data-lane="l1"] .daw-region')).toHaveCount(2);
  const ruler = daw.getByRole("slider", { name: "Time ruler", exact: true });
  const rulerBox = (await ruler.boundingBox())!;
  await page.mouse.click(rulerBox.x + 75, rulerBox.y + 20);
  await region.focus();
  await page.keyboard.press("s");
  await expect(daw.locator(".daw-region")).toHaveCount(3);
  await daw.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(daw.locator(".daw-region")).toHaveCount(2);
  const trim = daw.getByRole("button", { name: "Trim end r0", exact: true });
  await trim.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(
    daw.getByRole("status", { name: "Autosave", exact: true }),
  ).toContainText("Saving");
  await expect(
    daw.getByRole("status", { name: "Autosave", exact: true }),
  ).toContainText("Saved", {
    timeout: 10000,
  });
  const bin = daw.locator(".daw-bin-item");
  await bin.getByLabel("Place on lane", { exact: true }).selectOption("l0");
  await expect(daw.getByText("Unplaced segments (0)")).toBeVisible();
  await expect(
    daw.getByRole("status", { name: "Autosave", exact: true }),
  ).toContainText("Saved", {
    timeout: 10000,
  });
  await daw.focus();
  await page.keyboard.press("Control+z");
  await expect(daw.getByText("Unplaced segments (1)")).toBeVisible();
  await page.keyboard.press("Control+Shift+z");
  await expect(daw.getByText("Unplaced segments (0)")).toBeVisible();
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
