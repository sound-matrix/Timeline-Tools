import {
  test,
  expect,
  type Page,
  type APIRequestContext,
} from "@playwright/test";
import { readFile } from "node:fs/promises";
test.skip(!process.env.DESK_FIXTURE, "Requires the local desk fixture.");
const fixture = "http://127.0.0.1:54331",
  owner = "11111111-1111-4111-8111-111111111111";
const srt =
  "1\n00:00:01,000 --> 00:00:03,000\nHello world\n\n2\n00:00:04,000 --> 00:00:06,000\nSecond cue\n";
async function finish(page: Page, request: APIRequestContext, ext = "srt") {
  const response = await page.request.post("/api/jobs", {
    headers: { origin: "http://localhost:3100" },
    data: {
      file_name: "interview.wav",
      input_path: `${owner}/${crypto.randomUUID()}.wav`,
      type: "subtitles",
      settings: {
        language: "English",
        formats: [ext === "vtt" ? "vtt" : "srt"],
      },
    },
  });
  expect(response.status()).toBe(201);
  const { id } = await response.json();
  const path = `${owner}/${id}/subtitles.${ext}`;
  await request.post(fixture + "/__job", {
    data: {
      id,
      status: "done",
      output_paths: [path],
      subtitleOutputs: {
        [path]:
          ext === "json"
            ? JSON.stringify({
                segments: [
                  { start: 1, end: 3, text: "Hello world" },
                  { start: 4, end: 6, text: "Second cue" },
                ],
              })
            : ext === "vtt"
              ? "WEBVTT\n\n" + srt.replaceAll(",", ".")
              : srt,
      },
    },
  });
  return id;
}
test.beforeEach(async ({ page, request }) => {
  await request.post(fixture + "/__reset");
  await page.goto("/signin");
  await page.getByLabel("Email", { exact: true }).fill("desk@example.test");
  await page.getByLabel("Password", { exact: true }).fill("desk-test-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/dashboard/);
});
test("completed job auto-opens, edits download as SRT/VTT and survive reload; originals stay intact", async ({
  page,
  request,
}) => {
  await page.goto("/subs");
  const id = await finish(page, request);
  await page.reload();
  await page.getByRole("button", { name: "Open editor", exact: true }).click();
  await expect(page.getByLabel("Text 1", { exact: true })).toHaveValue(
    "Hello world",
  );
  await expect(page.getByLabel("Source audio preview")).toHaveCount(0);
  await page
    .getByLabel("Text 1", { exact: true })
    .fill("Corrected తెలుగు dialogue");
  await expect(page.getByRole("status", { name: "Save status" })).toHaveText(
    "Saved",
  );
  for (const format of ["srt", "vtt"]) {
    await page.getByLabel("Download format").selectOption(format);
    const pending = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "Download edited subtitles" })
      .click();
    const file = await pending;
    expect(file.suggestedFilename()).toBe(`interview.en.${format}`);
    const contents = await readFile((await file.path())!, "utf8");
    expect(contents).toContain("Corrected తెలుగు dialogue");
    expect(contents).toContain(
      format === "srt"
        ? "00:00:01,000 --> 00:00:03,000"
        : "00:00:01.000 --> 00:00:03.000",
    );
    if (format === "vtt") expect(contents).toMatch(/^WEBVTT/);
  }
  await page.reload();
  await expect(page.getByLabel("Text 1", { exact: true })).toHaveValue(
    "Corrected తెలుగు dialogue",
  );
  expect(
    await (await page.request.get(`/api/jobs/${id}/download?index=0`)).text(),
  ).toBe(srt);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Revert to original" }).click();
  await expect(page.getByRole("status", { name: "Save status" })).toHaveText(
    "Saved",
  );
  await page.reload();
  await expect(page.getByLabel("Text 1", { exact: true })).toHaveValue(
    "Hello world",
  );
});
test("plain text errors preserve drafts, undo/redo, find/replace, cue actions and mobile layout", async ({
  page,
  request,
}) => {
  await finish(page, request, "json");
  await page.goto("/subs");
  const text = page.getByLabel("Text 1", { exact: true });
  await expect(text).toHaveValue("Hello world");
  await page.getByRole("button", { name: "Plain text", exact: true }).click();
  const raw = page.getByLabel("SRT source");
  await raw.fill("bad draft");
  await expect(
    page.getByRole("region", { name: "Subtitle editor" }).getByRole("alert"),
  ).toContainText("expected a numeric index");
  await expect(raw).toHaveValue("bad draft");
  await expect(
    page.getByRole("button", { name: "Download edited subtitles" }),
  ).toBeDisabled();
  await raw.press("ControlOrMeta+z");
  await expect(raw).toHaveValue(/Hello world/);
  await raw.press("ControlOrMeta+Shift+z");
  await expect(raw).toHaveValue("bad draft");
  await raw.fill(srt.replace("Hello world", "Updated in source"));
  await page.getByRole("button", { name: "Cue list", exact: true }).click();
  await expect(text).toHaveValue("Updated in source");
  await page.getByLabel("Find", { exact: true }).fill("source");
  await page.getByLabel("Replace with").fill("editor");
  await page.getByRole("button", { name: "Replace all" }).click();
  await expect(text).toHaveValue("Updated in editor");
  await page.getByRole("button", { name: "Split cue 1", exact: true }).click();
  await expect(page.getByLabel("Text 3", { exact: true })).toHaveValue(
    "Second cue",
  );
  await page
    .getByRole("button", { name: "Merge cue 1 with next", exact: true })
    .click();
  await expect(text).toHaveValue("Updated in\neditor");
  await page.getByLabel("Start 2", { exact: true }).fill("00:00:02,000");
  await expect(
    page.getByText("Start overlaps the previous cue or is out of order.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Download edited subtitles" }),
  ).toBeDisabled();
  await page.getByLabel("Start 2", { exact: true }).fill("00:00:04,000");
  await page
    .getByRole("button", { name: "Insert after cue 1", exact: true })
    .click();
  await page.getByLabel("Text 2", { exact: true }).fill("Inserted cue");
  await page.getByRole("button", { name: "Delete cue 2", exact: true }).click();
  await text.fill("a".repeat(43));
  await expect(page.getByText(/above 42 characters per line/)).toBeVisible();
  await page.setViewportSize({ width: 375, height: 812 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
test("VTT-only output loads and failed saves can be retried without losing text", async ({
  page,
  request,
}) => {
  await finish(page, request, "vtt");
  await page.goto("/subs");
  await expect(page.getByLabel("Text 1", { exact: true })).toHaveValue(
    "Hello world",
  );
  let fail = true;
  await page.route("**/api/jobs/*/subtitles", async (route) => {
    if (fail && route.request().method() === "PUT")
      await route.fulfill({
        status: 503,
        json: { error: "Temporary save failure" },
      });
    else await route.continue();
  });
  await page.getByLabel("Text 1", { exact: true }).fill("Retained draft");
  await expect(
    page.getByRole("region", { name: "Subtitle editor" }).getByRole("alert"),
  ).toHaveText("Temporary save failure");
  fail = false;
  await page.getByRole("button", { name: "Save edits", exact: true }).click();
  await expect(page.getByRole("status", { name: "Save status" })).toHaveText(
    "Saved",
  );
  await page.reload();
  await expect(page.getByLabel("Text 1", { exact: true })).toHaveValue(
    "Retained draft",
  );
});
test("API rejects foreign jobs and malformed or overlapping cues", async ({
  page,
  request,
}) => {
  const { foreignId } = await (await request.post(fixture + "/__seed")).json();
  expect(
    (await page.request.get(`/api/jobs/${foreignId}/subtitles`)).status(),
  ).toBe(404);
  expect(
    (
      await page.request.put(`/api/jobs/${foreignId}/subtitles`, {
        headers: { origin: "http://localhost:3100" },
        data: { cues: [] },
      })
    ).status(),
  ).toBe(404);
  const id = await finish(page, request);
  for (const cues of [
    [{ start: "1", end: 2, text: "bad" }],
    [
      { start: 0, end: 3, text: "a" },
      { start: 2, end: 4, text: "b" },
    ],
  ])
    expect(
      (
        await page.request.put(`/api/jobs/${id}/subtitles`, {
          headers: { origin: "http://localhost:3100" },
          data: { cues },
        })
      ).status(),
    ).toBe(400);
});

test("newly completed job opens after polling and audio preview seeks/highlights cues", async ({
  page,
  request,
}, info) => {
  await page.goto("/subs");
  const response = await page.request.post("/api/jobs", {
    headers: { origin: "http://localhost:3100" },
    data: {
      file_name: "live.wav",
      input_path: `${owner}/${crypto.randomUUID()}.wav`,
      type: "subtitles",
      settings: { language: "English", formats: ["srt"] },
    },
  });
  const { id } = await response.json();
  await page.reload();
  const wave = Buffer.alloc(160044);
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
  wave.writeUInt32LE(wave.length - 44, 40);
  await page.route("**/api/jobs/*/subtitles", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({
      json: {
        ...data,
        audioUrl: "data:audio/wav;base64," + wave.toString("base64"),
      },
    });
  });
  const path = `${owner}/${id}/subtitles.srt`;
  await request.post(fixture + "/__job", {
    data: {
      id,
      status: "done",
      output_paths: [path],
      subtitleOutputs: { [path]: srt },
    },
  });
  await expect(page.getByLabel("Text 1", { exact: true })).toHaveValue(
    "Hello world",
    { timeout: 20000 },
  );
  await page.getByText("Cue 2", { exact: true }).click();
  await expect
    .poll(() =>
      page
        .getByLabel("Source audio preview")
        .evaluate((element: HTMLAudioElement) => element.currentTime),
    )
    .toBe(4);
  await expect(page.locator(".subtitle-cue").nth(1)).toHaveClass(/is-playing/);
  await page
    .getByRole("region", { name: "Subtitle editor" })
    .screenshot({ path: info.outputPath("subtitle-editor-desktop.png") });
  await page.setViewportSize({ width: 375, height: 812 });
  await page
    .getByRole("region", { name: "Subtitle editor" })
    .screenshot({ path: info.outputPath("subtitle-editor-mobile.png") });
});
