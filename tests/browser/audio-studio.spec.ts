import {
  test,
  expect,
  type Page,
  type APIRequestContext,
} from "@playwright/test";
import { readFileSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
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
async function upload(page: Page) {
  await page.getByLabel("Audio clips", { exact: true }).setInputFiles(file);
}
async function queue(page: Page) {
  const pending = page.waitForResponse(
    (r) => r.url().endsWith("/api/jobs") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Submit", exact: true }).click();
  const response = await pending;
  expect(response.status()).toBe(201);
  return (await response.json()).id as string;
}
async function complete(request: APIRequestContext, id: string) {
  const a = JSON.parse(
    readFileSync("tests/fixtures/daw-arrangement.json", "utf8"),
  );
  a.job_id = id;
  await request.post(fixture + "/__job", {
    data: {
      id,
      status: "done",
      duration_sec: 8,
      arrangement: a,
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
async function finish(page: Page, request: APIRequestContext) {
  await upload(page);
  const id = await queue(page);
  const exportQueued = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/jobs") &&
      r.request().postDataJSON()?.type === "studio_export",
  );
  await complete(request, id);
  const response = await exportQueued;
  expect(response.status()).toBe(201);
  const data = response.request().postDataJSON();
  expect(data.expected_cost).toBe(0);
  expect(data.settings.formats).toEqual(["mp3"]);
  expect(data.settings.subtitles).toEqual(["srt"]);
  const exportId = (await response.json()).id;
  await request.post(fixture + "/__job", {
    data: {
      id: exportId,
      status: "done",
      duration_sec: 8,
      output_paths: [`${owner}/${exportId}/consolidated.wav`],
    },
  });
  await expect(page.getByLabel("Consolidated audio player")).toBeVisible();
  await expect(page.getByLabel("Output transcript")).toContainText(
    "Hello there",
  );
  return { id, exportId };
}
test.beforeEach(async ({ page, request }) => {
  await request.post(fixture + "/__reset");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/signin");
  // The auth form is outside this feature; let its client bundle hydrate on a cold server.
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Email", { exact: true }).fill("desk@example.test");
  await page.getByLabel("Password", { exact: true }).fill("desk-test-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/dashboard/);
  await page.goto("/studio");
});
test("Submit stays enabled, multiple upload/drop, selection preview, durations and remove", async ({
  page,
}) => {
  const submit = page.getByRole("button", { name: "Submit", exact: true });
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(
    page.locator(".studio-upload-form").getByRole("alert"),
  ).toHaveText("Choose at least one audio or video file.");
  await expect(
    page.getByText("Your transcription will appear here after processing."),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Edit script", exact: true }),
  ).toBeDisabled();
  await page
    .getByLabel("Audio clips", { exact: true })
    .setInputFiles([file, { ...file, name: "narrator.wav" }]);
  const clips = page.getByRole("region", {
    name: "Audio clips uploaded",
    exact: true,
  });
  await expect(clips.locator("li")).toHaveCount(2);
  await expect(clips.getByText("0:01")).toHaveCount(2);
  const preview = page.getByLabel("Preview selected clip");
  await expect
    .poll(() => preview.evaluate((a: HTMLAudioElement) => a.readyState))
    .toBeGreaterThan(0);
  const previousSource = await preview.getAttribute("src");
  await page
    .getByRole("button", { name: "Preview narrator.wav, clip 2", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Preview audio", exact: true }),
  ).toContainText("narrator.wav");
  await expect(preview).not.toHaveAttribute("src", previousSource!);
  await expect
    .poll(() => preview.evaluate((a: HTMLAudioElement) => a.readyState))
    .toBeGreaterThan(0);
  await preview.focus();
  await expect(preview).toBeFocused();
  // Latch actual playback. A one-second clip can finish before a later poll,
  // especially while the selected clip's object URL is being replaced.
  const played = await preview.evaluate(async (a: HTMLAudioElement) => {
    const started = new Promise<boolean>((resolve) =>
      a.addEventListener("playing", () => resolve(!a.paused), { once: true }),
    );
    await a.play();
    const playing = await started;
    a.pause();
    return playing;
  });
  expect(played).toBe(true);
  await page
    .getByRole("button", { name: "Remove clip 2: narrator.wav", exact: true })
    .click();
  await expect(clips.locator("li")).toHaveCount(1);
  const transfer = await page.evaluateHandle(
    (bytes) => {
      const d = new DataTransfer();
      d.items.add(
        new File([new Uint8Array(bytes)], "dropped.wav", { type: "audio/wav" }),
      );
      return d;
    },
    [...wave],
  );
  await page
    .locator(".studio-upload-drop")
    .dispatchEvent("drop", { dataTransfer: transfer });
  await expect(clips.locator("li")).toHaveCount(2);
  await expect(
    page.getByRole("region", { name: "DAW timeline", exact: true }),
  ).toHaveCount(0);
});
test("default ZIP/job flow, real consolidated output, seek/download and desktop/mobile screenshots", async ({
  page,
  request,
}) => {
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
  const { id, exportId } = await finish(page, request);
  const manifest = JSON.parse(strFromU8(unzipSync(zip!)["manifest.json"]));
  expect(manifest.version).toBe(2);
  expect(manifest.mode).toBe("transcribe");
  expect(manifest.clips[0].name).toBe(file.name);
  const player = page.getByLabel("Consolidated audio player");
  await expect
    .poll(() => player.evaluate((a: HTMLAudioElement) => a.readyState))
    .toBeGreaterThan(0);
  await player.focus();
  await expect(player).toBeFocused();
  await player.evaluate((a: HTMLAudioElement) => {
    a.currentTime = 2;
  });
  await expect
    .poll(() => player.evaluate((a: HTMLAudioElement) => a.currentTime))
    .toBe(2);
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download SRT", exact: true }).click();
  expect(await readFile((await (await download).path())!, "utf8")).toContain(
    "00:00:00,000 --> 00:00:02,000\nHello there",
  );
  await expect(
    page.getByRole("link", { name: "Download audio", exact: true }),
  ).toHaveAttribute("href", `/api/jobs/${exportId}/download?index=0`);
  mkdirSync("docs/audio-studio-simple", { recursive: true });
  await page.screenshot({
    path: "docs/audio-studio-simple/desktop.png",
    fullPage: true,
  });
  const left = await page.locator(".studio-simple-left").boundingBox(),
    right = await page.locator(".studio-simple-right").boundingBox();
  expect(right!.x).toBeGreaterThan(left!.x + left!.width);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "docs/audio-studio-simple/mobile.png",
    fullPage: true,
  });
  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  expect(
    (await page.locator(".studio-simple-right").boundingBox())!.y,
  ).toBeGreaterThan(
    (await page.locator(".studio-simple-left").boundingBox())!.y,
  );
  let posts = 0;
  page.on("request", (r) => {
    if (r.url().endsWith("/api/jobs") && r.method() === "POST") posts++;
  });
  await page.reload();
  await expect(player).toBeVisible();
  await expect(player).toHaveAttribute(
    "src",
    `/api/jobs/${exportId}/download?index=0`,
  );
  expect(posts).toBe(0);
  expect((await page.request.get(`/api/studio/${id}/result`)).status()).toBe(
    200,
  );
});
test("script Save/Cancel, failed save recovery, saved SRT and handoff flush before Editor Studio", async ({
  page,
  request,
}) => {
  const { id } = await finish(page, request);
  const edit = page.getByRole("button", { name: "Edit script", exact: true });
  await edit.click();
  await page
    .getByLabel("Edit transcript", { exact: true })
    .fill("Discard this");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByLabel("Output transcript")).toContainText(
    "Hello there",
  );
  await edit.click();
  const textarea = page.getByLabel("Edit transcript", { exact: true });
  await textarea.fill("Corrected తెలుగు dialogue\n\nWelcome home");
  let fail = true;
  await page.route("**/api/jobs/*/subtitles", async (route) => {
    if (fail && route.request().method() === "PUT")
      await route.fulfill({
        status: 503,
        json: { error: "Temporary save failure" },
      });
    else await route.continue();
  });
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Temporary save failure" }),
  ).toBeVisible();
  await expect(textarea).toHaveValue(
    "Corrected తెలుగు dialogue\n\nWelcome home",
  );
  fail = false;
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Script saved.", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Output transcript")).toContainText(
    "Corrected తెలుగు dialogue",
  );
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download SRT", exact: true }).click();
  expect(await readFile((await (await pending).path())!, "utf8")).toContain(
    "Corrected తెలుగు dialogue",
  );
  await edit.click();
  await textarea.fill("Saved before opening\n\nWelcome home");
  await page
    .getByRole("link", { name: "Open in Editor Studio", exact: true })
    .click();
  await expect(page).toHaveURL(/editor\/[0-9a-f-]{36}/);
  await expect(
    page.getByRole("main", { name: "Editor Studio", exact: true }),
  ).toBeVisible();
  expect(
    (await (await page.request.get(`/api/jobs/${id}/subtitles`)).json()).cues[0]
      .text,
  ).toBe("Saved before opening");
});
test("pending export resumes after reload without a second POST; result and edit APIs reject foreign jobs", async ({
  page,
  request,
}) => {
  const { foreignId } = await (await request.post(fixture + "/__seed")).json();
  expect(
    (await page.request.get(`/api/studio/${foreignId}/result`)).status(),
  ).toBe(404);
  expect(
    (await page.request.get(`/api/jobs/${foreignId}/subtitles`)).status(),
  ).toBe(404);
  await request.post(fixture + "/__reset");
  await upload(page);
  const id = await queue(page);
  const queued = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/jobs") &&
      r.request().postDataJSON()?.type === "studio_export",
  );
  await complete(request, id);
  const exportId = (await (await queued).json()).id;
  let posts = 0;
  page.on("request", (r) => {
    if (r.url().endsWith("/api/jobs") && r.method() === "POST") posts++;
  });
  await page.reload();
  await expect(
    page.getByText("Preparing your consolidated audio…", { exact: true }),
  ).toBeVisible();
  await request.post(fixture + "/__job", {
    data: {
      id: exportId,
      status: "done",
      duration_sec: 8,
      output_paths: [`${owner}/${exportId}/consolidated.wav`],
    },
  });
  await expect(page.getByLabel("Consolidated audio player")).toBeVisible();
  expect(posts).toBe(0);
});
test("language mismatch and zero-charge explanation remain visible on mobile", async ({
  page,
  request,
}) => {
  await upload(page);
  await page
    .getByText("Optional script & processing settings", { exact: true })
    .click();
  await page.getByLabel("Script text", { exact: true }).fill("Narrator: Hello");
  const id = await queue(page);
  await request.post(fixture + "/__job", {
    data: {
      id,
      status: "failed",
      error: "Language mismatch",
      error_code: "language_mismatch",
      error_detail: {
        script_lang: "hi",
        clips: [{ name: file.name, lang: "en", prob: 0.99 }],
      },
    },
  });
  await expect(page.getByText(/Script: hi/)).toBeVisible();
  await expect(page.getByText("meera_03.wav: en (99%)")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Submit", exact: true }),
  ).toBeEnabled();
  await page.setViewportSize({ width: 375, height: 812 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
