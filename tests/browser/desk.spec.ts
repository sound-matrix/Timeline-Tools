import {
  test,
  expect,
  type Page,
  type APIRequestContext,
} from "@playwright/test";

test.skip(
  !process.env.DESK_FIXTURE,
  "Run using playwright.desk.config.ts and the local fixture build.",
);
const fixture = "http://127.0.0.1:54331";
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
async function upload(page: Page) {
  await page
    .getByLabel("Choose audio or video")
    .setInputFiles({ name: "desk.wav", mimeType: "audio/wav", buffer: wave });
}
async function complete(
  request: APIRequestContext,
  id: string,
  status = "done",
) {
  await request.post(fixture + "/__job", {
    data: {
      id,
      status,
      error: status === "failed" ? "The media could not be decoded." : null,
      duration_sec: 1,
      output_paths: ["11111111-1111-4111-8111-111111111111/private/output.wav"],
    },
  });
}

test.beforeEach(async ({ page, request }) => {
  await request.post(fixture + "/__reset");
  await page.goto("/signin");
  await page.getByLabel("Email", { exact: true }).fill("desk@example.test");
  await page.getByLabel("Password", { exact: true }).fill("desk-test-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/dashboard/);
});

test("upload-first cleanup desk, independent choices, live wave and download on the same page", async ({
  page,
  request,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/cleanup");
  await expect(
    page.getByRole("region", { name: "Processing options" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Start Processing" }),
  ).toBeDisabled();
  await expect(page.getByText("Choose a file to continue.")).toBeVisible();
  await upload(page);
  const options = page.getByRole("region", { name: "Processing options" });
  await expect(options).toBeVisible();
  expect((await options.boundingBox())!.y).toBeGreaterThan(
    (await page.getByRole("region", { name: "Upload file" }).boundingBox())!.y,
  );
  await expect(
    page.getByRole("button", { name: "Start Processing" }),
  ).toBeDisabled();
  await expect(page.getByText("Select your options above.")).toBeVisible();
  await page.getByLabel("Noise removal", { exact: true }).check();
  await expect(page.getByLabel("Denoising method")).toHaveValue("");
  await expect(page.getByLabel("Remove noise", { exact: true })).toHaveValue(
    "",
  );
  await page.getByLabel("Denoising method").selectOption("speech_music");
  await expect(
    page.getByRole("button", { name: "Start Processing" }),
  ).toBeDisabled();
  await page.getByLabel("Remove noise", { exact: true }).selectOption("60");
  await page.getByLabel("De-hum", { exact: true }).check();
  await expect(
    page.getByRole("button", { name: "Start Processing" }),
  ).toBeDisabled();
  await page.getByLabel("De-hum amount").selectOption("30");
  await expect(
    page.getByRole("button", { name: "Start Processing" }),
  ).toBeEnabled();
  await page.screenshot({
    path: info.outputPath("cleanup-desktop.png"),
    fullPage: true,
  });
  let releaseUpload!: () => void, releaseStart!: () => void;
  const uploadGate = new Promise<void>((resolve) => {
    releaseUpload = resolve;
  });
  const startGate = new Promise<void>((resolve) => {
    releaseStart = resolve;
  });
  await page.route("**/storage/v1/object/uploads/**", async (route) => {
    await uploadGate;
    await route.continue();
  });
  await page.route("**/api/jobs", async (route) => {
    await startGate;
    await route.continue();
  });
  const queued = page.waitForResponse(
    (r) => r.url().endsWith("/api/jobs") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Start Processing" }).click();
  const liveUpload = page.getByRole("region", { name: "Live processing" });
  await expect(liveUpload.getByRole("status")).toContainText("Uploading");
  await expect(
    page.getByRole("button", { name: "Uploading…", exact: true }),
  ).toBeDisabled();
  releaseUpload();
  await expect(liveUpload.getByRole("status")).toHaveText("Starting");
  releaseStart();
  const response = await queued;
  expect(response.status()).toBe(201);
  expect(response.request().postDataJSON().settings).toEqual({
    noise: { enabled: true, method: "speech_music", amount: 60 },
    hum: { enabled: true, amount: 30 },
    reverb: { enabled: false },
    voice: false,
  });
  const { id } = await response.json();
  const live = page.getByRole("region", { name: "Live processing" });
  await expect(live.getByRole("status")).toHaveText("Queued");
  await expect(page.locator(".studio-motion")).toHaveClass(/motion-stopped/);
  await complete(request, id, "processing");
  await expect(live.getByRole("status")).toHaveText("Processing", {
    timeout: 10000,
  });
  await expect(live.locator(".wave-processing")).toBeVisible();
  await expect(live.locator(".wave-clean")).toHaveCSS(
    "animation-name",
    "reveal-clean",
  );
  await live.getByRole("button", { name: "Pause live motion" }).click();
  await expect(live.locator(".wave-clean")).toHaveCSS(
    "animation-play-state",
    "paused",
  );
  await page.setViewportSize({ width: 375, height: 812 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: info.outputPath("cleanup-live-mobile.png"),
    fullPage: true,
  });
  await complete(request, id);
  await expect(live.getByRole("status")).toHaveText("Done", { timeout: 10000 });
  await expect(
    live.getByRole("link", { name: "Download WAV" }),
  ).toHaveAttribute("href", `/api/jobs/${id}/download?index=0`);
  await expect(live.locator(".wave-clean")).toHaveCSS("animation-name", "none");
  await expect(page).toHaveURL(/cleanup/);
  expect(errors).toEqual([]);
});

for (const route of ["dashboard", "master", "subs"])
  test(`${route}: no defaults, Start Processing and live failure`, async ({
    page,
    request,
  }) => {
    await page.goto("/" + route);
    await upload(page);
    await expect(
      page.getByRole("button", { name: "Start Processing" }),
    ).toBeDisabled();
    if (route === "dashboard") {
      await page.getByLabel("De-reverb", { exact: true }).check();
      await expect(page.getByLabel("De-reverb amount")).toHaveValue("");
      await page.getByLabel("De-reverb amount").selectOption("100");
    } else if (route === "master") {
      await page.getByLabel("Apply loudness", { exact: true }).check();
      await expect(
        page.getByLabel("Target integrated loudness (LUFS)", { exact: true }),
      ).toHaveValue("");
      await page
        .getByLabel("Target integrated loudness (LUFS)", { exact: true })
        .fill("-18.5");
    } else {
      await expect(page.getByLabel("Language", { exact: true })).toHaveValue(
        "",
      );
      await expect(page.getByLabel("SRT", { exact: true })).not.toBeChecked();
      await page.getByLabel("Language", { exact: true }).selectOption("Telugu");
      await page.getByLabel("SRT", { exact: true }).check();
    }
    await page.emulateMedia({ reducedMotion: "reduce" });
    const queued = page.waitForResponse(
      (r) => r.url().endsWith("/api/jobs") && r.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Start Processing" }).click();
    const response = await queued;
    const result = await response.json();
    expect(response.status(), JSON.stringify(result)).toBe(201);
    const { id } = result;
    await complete(request, id, "processing");
    const live = page.getByRole("region", { name: "Live processing" });
    await expect(live.getByRole("status")).toHaveText("Processing", {
      timeout: 10000,
    });
    await expect(live.locator(".wave-clean")).toHaveCSS(
      "animation-name",
      "none",
    );
    await expect(
      live.getByRole("button", { name: "Pause live motion" }),
    ).toBeHidden();
    await complete(request, id, "failed");
    await expect(live.getByRole("alert")).toContainText(
      "The media could not be decoded.",
      { timeout: 10000 },
    );
    await expect(
      page.getByRole("button", { name: "Start Processing" }),
    ).toBeEnabled();
  });

test("status API requires ownership and returns private uncached download routes", async ({
  page,
  request,
}) => {
  const { jobId, foreignId } = await (
    await request.post(fixture + "/__seed")
  ).json();
  const own = await page.request.get(`/api/jobs/${jobId}`);
  expect(own.status()).toBe(200);
  expect(own.headers()["cache-control"]).toBe("private, no-store");
  const data = await own.json();
  expect(data.status).toBe("done");
  expect(data.downloads).toHaveLength(2);
  expect(JSON.stringify(data)).not.toContain("private/");
  expect(JSON.stringify(data)).not.toContain("output_paths");
  expect((await page.request.get(`/api/jobs/${foreignId}`)).status()).toBe(404);
  expect((await page.request.get("/api/jobs/not-an-id")).status()).toBe(404);
  const reads = await (await request.get(fixture + "/__requests")).json();
  expect(
    reads
      .filter(
        (r: { path: string; query: { id?: string } }) =>
          r.path === "/rest/v1/jobs" && r.query.id,
      )
      .every(
        (r: { query: { user_id: string } }) =>
          r.query.user_id === "eq.11111111-1111-4111-8111-111111111111",
      ),
  ).toBe(true);
});

test("polling interruptions preserve the job and recover to done; invalid replacement files cannot submit", async ({
  page,
  request,
}) => {
  await page.goto("/cleanup");
  await upload(page);
  await page.getByLabel("Voice enhance", { exact: true }).check();
  await page.getByLabel("Choose audio or video").setInputFiles({
    name: "bad.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("invalid"),
  });
  await expect(
    page.getByRole("region", { name: "Upload file" }).getByRole("alert"),
  ).toContainText("Choose a supported");
  await expect(
    page.getByRole("button", { name: "Start Processing" }),
  ).toBeDisabled();
  await upload(page);
  let fail = true,
    polls = 0;
  await page.route(/\/api\/jobs\/[^/]+$/, async (route) => {
    polls++;
    if (fail)
      await route.fulfill({ status: 503, json: { error: "temporary" } });
    else await route.continue();
  });
  const queue = page.waitForResponse(
    (r) => r.url().endsWith("/api/jobs") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Start Processing" }).click();
  const response = await queue;
  expect(response.status()).toBe(201);
  const { id } = await response.json();
  const live = page.getByRole("region", { name: "Live processing" });
  await expect(live.getByRole("alert")).toContainText(
    "Could not check progress",
  );
  await expect(live.getByRole("status")).toHaveText("Queued");
  fail = false;
  await complete(request, id);
  await expect(live.getByRole("status")).toHaveText("Done", { timeout: 10000 });
  expect(polls).toBeGreaterThan(1);
  await expect(live.getByRole("alert")).toHaveCount(0);
  // Controlled timers prove terminal jobs do not keep polling.
  await page.clock.install();
  const terminalPolls = polls;
  await page.clock.runFor(6000);
  expect(polls).toBe(terminalPolls);
});
