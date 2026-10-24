import { test as base, expect } from "@playwright/test";
import { readFile, writeFile, mkdir } from "node:fs/promises";
// WebKit's ephemeral sessions cannot persist IDB File/Blob values (upstream
// microsoft/playwright#42795). A fresh persistent profile models normal Safari.
const test = base.extend({
  context: async (
    {
      context,
      browserName,
      playwright,
      launchOptions,
      baseURL,
      viewport,
      headless,
    },
    use,
  ) => {
    if (browserName !== "webkit") {
      await use(context);
      return;
    }
    const regular = await playwright.webkit.launchPersistentContext("", {
      ...launchOptions,
      baseURL,
      viewport,
      headless,
      acceptDownloads: true,
    });
    try {
      await use(regular);
    } finally {
      await regular.close();
    }
  },
});
test.skip(!process.env.DESK_FIXTURE, "Use fixture config");
test.beforeEach(async ({ page }) => {
  page.on("pageerror", (error) =>
    console.log("EDITOR_PAGE_ERROR", error.stack ?? error.message),
  );
  page.on("console", (message) => {
    if (message.type() === "error")
      console.log("EDITOR_CONSOLE_ERROR", message.text());
  });
});
test.afterEach(async ({ page }, info) => {
  if (info.status !== info.expectedStatus && !page.isClosed()) {
    console.log(
      "EDITOR_VIDEO_FAILURE",
      JSON.stringify(
        await page.evaluate(() => ({
          errors: (window as any).__videoPlayErrors,
          video: Array.from(document.querySelectorAll("video")).map((v) => ({
            src: v.currentSrc,
            time: v.currentTime,
            paused: v.paused,
            muted: v.muted,
            ready: v.readyState,
            seeking: v.seeking,
          })),
          audio: ((window as any).__audioStarts ?? []).map((s: any) => ({
            offset: s.offset,
            when: s.when,
            now: s.context.currentTime,
            state: s.context.state,
            timestamp: s.context.getOutputTimestamp?.(),
            baseLatency: s.context.baseLatency,
            outputLatency: s.context.outputLatency,
          })),
        })),
      ),
    );
    console.log(
      "EDITOR_FAILURE_STATE",
      await page.locator(".editor-upload, [role=alert]").allTextContents(),
    );
  }
});
function wave(seconds = 2, frequency = 440) {
  const rate = 48000,
    n = seconds * rate,
    b = Buffer.alloc(44 + n * 2);
  b.write("RIFF");
  b.writeUInt32LE(b.length - 8, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++)
    b.writeInt16LE(
      Math.round(Math.sin((i / rate) * frequency * Math.PI * 2) * 10000),
      44 + i * 2,
    );
  return b;
}
async function signin(page: any, request: any) {
  await request.post("http://127.0.0.1:54331/__reset");
  await page.goto("/signin");
  await page.getByLabel("Email", { exact: true }).fill("desk@example.test");
  await page.getByLabel("Password", { exact: true }).fill("desk-test-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/dashboard/);
}
test("blank Editor: OS drop three clips, split/move/fade/history, save/reload, free WAV download", async ({
  page,
  request,
}, info) => {
  await page.setViewportSize({ width: 1600, height: 1100 });
  await signin(page, request);
  await page.getByRole("link", { name: "New Editor project" }).click();
  await expect(page).toHaveURL(/editor\/[0-9a-f-]{36}/);
  await expect(page.getByRole("main", { name: "Editor Studio" })).toBeVisible();
  await expect(page.locator(".side")).toHaveCount(0);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("response", async (r) => {
    if (r.status() >= 400)
      console.log(
        "EDITOR_FAILED_REQUEST",
        r.status(),
        r.url(),
        (await r.text()).slice(0, 400),
      );
  });
  const canvas = page.getByLabel("Timeline waveform canvas");
  const data = await page.evaluateHandle(
    (files) => {
      const transfer = new DataTransfer();
      files.forEach((data, i) =>
        transfer.items.add(
          new File([new Uint8Array(data)], `voice-${i}.wav`, {
            type: "audio/wav",
          }),
        ),
      );
      return transfer;
    },
    [
      Array.from(wave(2, 220)),
      Array.from(wave(2, 330)),
      Array.from(wave(2, 440)),
    ],
  );
  const box = (await canvas.boundingBox())!;
  await canvas.dispatchEvent("drop", {
    dataTransfer: data,
    clientX: box.x + 190,
    clientY: box.y + 100,
  });
  await expect(page.locator(".pro-header")).toHaveCount(3);
  await expect(page.getByRole("status", { name: "Editor save status" }))
    .toHaveText("Saved", { timeout: 20000 })
    .catch(async (e) => {
      console.log(
        "EDITOR_IMPORT_STATE",
        await page.locator(".editor-upload").allTextContents(),
      );
      throw e;
    });
  await page.getByRole("region", { name: "DAW timeline", exact: true }).focus();
  await page.keyboard.press("n");
  const b = (await canvas.boundingBox())!;
  await page.mouse.click(b.x + 230, b.y + 15);
  await page.getByRole("region", { name: "DAW timeline", exact: true }).focus();
  await page.keyboard.press("s");
  await expect(
    page.getByText("Regions (6) · select with keyboard"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(
    page.getByText("Regions (3) · select with keyboard"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await page.mouse.move(b.x + 205, b.y + 80);
  await page.mouse.down();
  await page.mouse.move(b.x + 220, b.y + 80, { steps: 5 });
  await page.mouse.up();
  await page.getByLabel("Fade in (default 0 s)", { exact: true }).fill("0.1");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByRole("status", { name: "Editor save status" }),
  ).toHaveText("Saved");
  await page.reload();
  await expect(
    page.getByText("Regions (6) · select with keyboard"),
  ).toBeVisible();
  await page.screenshot({ path: info.outputPath("editor-studio.png") });
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download local mix · free" }).click();
  const result = await download;
  const path = await result.path();
  const bytes = await readFile(path!);
  expect(bytes.toString("ascii", 0, 4)).toBe("RIFF");
  expect(bytes.readUInt32LE(24)).toBe(48000);
  expect(bytes.readUInt16LE(34)).toBe(24);
  const seconds = bytes.readUInt32LE(40) / (48000 * 6);
  expect(seconds).toBeGreaterThan(1.9);
  expect(seconds).toBeLessThan(2.6);
  expect(errors).toEqual([]);
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Export Editor project" })
    .getByRole("combobox", { name: "Format", exact: true })
    .selectOption("mp3");
  const mp3 = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download local mix · free" }).click();
  const encoded = await mp3;
  expect(encoded.suggestedFilename()).toMatch(/\.mp3$/);
  const { execFileSync } = await import("node:child_process");
  const probe = JSON.parse(
    execFileSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "stream=codec_name,sample_rate,bit_rate",
        "-of",
        "json",
        (await encoded.path())!,
      ],
      { encoding: "utf8" },
    ),
  );
  expect(probe.streams[0].codec_name).toBe("mp3");
  expect(probe.streams[0].sample_rate).toBe("48000");
});

test("client OfflineAudioContext matches the actual Python worker fixture below -60 dB RMS", async ({
  page,
  request,
}, info) => {
  const { build } = await import("esbuild");
  const { execFileSync } = await import("node:child_process");
  const result = await build({
    stdin: {
      contents: 'export {offlineBlock} from "./lib/editor/mixdown.ts";',
      resolveDir: process.cwd(),
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
  });
  const fixture = JSON.parse(
    execFileSync(
      "python",
      [
        "-c",
        `import json,tempfile,base64
from pathlib import Path
import numpy as np,soundfile as sf
from workers.tests.test_editor import fixture,ASSET
from workers.editor_export import render_editor
a=fixture();rate=48000;t=np.arange(rate*2)/rate
signal=np.column_stack([np.sin(t*440*2*np.pi)*.1,np.sin(t*660*2*np.pi)*.1]).astype('float32')
with tempfile.TemporaryDirectory() as tmp:
 p=Path(tmp);src=p/'input.wav';sf.write(src,signal,rate,subtype='FLOAT')
 out=render_editor({ASSET:src},a,p,dict(revision=1,range=[0,2],options=dict(format='wav',rate=rate,depth=24,bitrate=320,normalize=False),subtitles=[]))[0]
 expected,_=sf.read(out,dtype='float32',always_2d=True)
 print(json.dumps(dict(arrangement=a,expected=base64.b64encode(expected.tobytes()).decode())))`,
      ],
      { maxBuffer: 4 * 1024 * 1024, encoding: "utf8" },
    ),
  );
  await signin(page, request);
  const rms = await page.evaluate(
    async ({ source, fixture }) => {
      const url = URL.createObjectURL(
        new Blob([source], { type: "text/javascript" }),
      );
      const { offlineBlock } = await import(url);
      URL.revokeObjectURL(url);
      const ctx = new AudioContext(),
        reader = async (_url: string, start: number, length: number) => {
          const b = ctx.createBuffer(2, Math.round(length * 48000), 48000);
          for (let ch = 0; ch < 2; ch++) {
            const data = b.getChannelData(ch);
            for (let i = 0; i < data.length; i++)
              data[i] =
                Math.sin(
                  ((Math.round(start * 48000) + i) / 48000) *
                    (ch === 0 ? 440 : 660) *
                    Math.PI *
                    2,
                ) * 0.1;
          }
          return b;
        };
      const b = await offlineBlock(
        fixture.arrangement,
        0,
        2,
        48000,
        reader,
        {},
      );
      const bytes = Uint8Array.from(atob(fixture.expected), (c) =>
          c.charCodeAt(0),
        ),
        expected = new Float32Array(bytes.buffer);
      let error = 0;
      for (let i = 0; i < b.length; i++)
        for (let ch = 0; ch < 2; ch++) {
          const diff = b.getChannelData(ch)[i] - expected[i * 2 + ch];
          error += diff * diff;
        }
      await ctx.close();
      return (
        20 * Math.log10(Math.max(1e-20, Math.sqrt(error / expected.length)))
      );
    },
    { source: result.outputFiles[0].text, fixture },
  );
  console.log("EDITOR_PARITY_RMS_DB " + rms);
  await info.attach("client-worker-parity.json", {
    body: JSON.stringify({ rms_difference_db: rms }),
    contentType: "application/json",
  });
  expect(rms).toBeLessThan(-60);
});

test("reload during peak generation resumes the original file and saves exactly one region", async ({
  page,
  request,
}, info) => {
  await signin(page, request);
  await page.getByRole("link", { name: "New Editor project" }).click();
  await expect(page).toHaveURL(/editor\/[0-9a-f-]{36}/);
  const { readFileSync } = await import("node:fs");
  const source = readFileSync("public/daw/import-worker.js", "utf8");
  await page.route("**/daw/import-worker.js", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: `const post=self.postMessage.bind(self);self.postMessage=(data,...args)=>{if(data.waveform)return;post(data,...args);};\n${source}`,
    }),
  );
  // Keep the OS file alive across reload; WebKit can invalidate protocol-created temporary Files.
  await mkdir(info.outputDir, { recursive: true });
  const sourcePath = info.outputPath("recover.wav");
  await writeFile(sourcePath, wave(2, 550));
  await page
    .getByLabel("Import audio files", { exact: true })
    .setInputFiles(sourcePath);
  await expect(
    page.getByText("Regions (1) · select with keyboard"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "still uploading" }),
  ).toBeVisible();
  await expect(
    page.getByRole("status", { name: "Editor save status" }),
  ).toHaveText("Saving…");
  await page.unroute("**/daw/import-worker.js");
  await page.reload();
  await expect(
    page.getByRole("status", { name: "Editor save status" }),
  ).toHaveText("Saved", { timeout: 20000 });
  await expect(
    page.getByText("Regions (1) · select with keyboard"),
  ).toBeVisible();
  await expect(page.locator(".pro-header")).toHaveCount(1);
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download local mix · free" }).click();
  const file = await download;
  const bytes = await readFile((await file.path())!);
  expect(bytes.readUInt32LE(40) / (48000 * 6)).toBeCloseTo(2, 3);
  expect(bytes.subarray(44).some((v) => v !== 0)).toBe(true);
});

test("an interrupted local storage write leaves Editor usable and import can be retried", async ({
  page,
  request,
}) => {
  await signin(page, request);
  await page.getByRole("link", { name: "New Editor project" }).click();
  await expect(page.getByRole("main", { name: "Editor Studio" })).toBeVisible();
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    (window as any).__restorePut = () => {
      IDBObjectStore.prototype.put = original;
    };
    IDBObjectStore.prototype.put = function (value, key) {
      const result = original.call(this, value, key);
      if (typeof key === "string" && key.startsWith("import-source/"))
        this.transaction.abort();
      return result;
    };
  });
  const input = page.getByLabel("Import audio files", { exact: true });
  const file = {
    name: "retry.wav",
    mimeType: "audio/wav",
    buffer: wave(2, 770),
  };
  await input.setInputFiles(file);
  await expect(page.locator(".editor-upload [role=alert]")).toBeVisible();
  await expect(page.getByRole("main", { name: "Editor Studio" })).toBeVisible();
  await expect(
    page.getByText("Regions (0) · select with keyboard"),
  ).toBeVisible();
  await page.evaluate(() => {
    (window as any).__restorePut();
    delete (window as any).__restorePut;
  });
  await input.setInputFiles(file);
  await expect(
    page.getByText("Regions (1) · select with keyboard"),
  ).toBeVisible();
  await expect(
    page.getByRole("status", { name: "Editor save status" }),
  ).toHaveText("Saved", { timeout: 20000 });
});

test("Podcast fork preview follows paused seeks, live jumps and inserted silence", async ({
  page,
  request,
  browserName,
}, info) => {
  await signin(page, request);
  const fixture = "http://127.0.0.1:54331",
    owner = "11111111-1111-4111-8111-111111111111";
  const created = await request.post(fixture + "/rest/v1/jobs", {
    data: { type: "podcast", settings: {} },
  });
  const id = (await created.json()).id;
  await request.post(fixture + "/__job", {
    data: {
      id,
      status: "done",
      duration_sec: 8,
      output_paths: [
        `${owner}/${id}/podcast-clip-0.wav`,
        `${owner}/${id}/podcast-clip-0-peaks.json`,
        `${owner}/${id}/proxy-0.mp4`,
      ],
      podcast: {
        duration: 8,
        revision: 1,
        exports_count: 0,
        transcript: {
          speakers: [{ id: "s0", name: "Speaker 1" }],
          words: [{ w: "voice", start: 0, end: 4, speaker: "s0", conf: 0.9 }],
          segments: [],
          method: "synthetic",
        },
        edits: {
          operations: [
            { op: "delete", start: 1, end: 2 },
            { op: "insert", at: 3, duration: 1 },
          ],
          corrections: {},
          speaker_names: {},
        },
        media: [
          {
            media_index: 0,
            name: "conversation.mp4",
            offset_sec: 0,
            duration: 8,
            audio_path: `${owner}/${id}/podcast-clip-0.wav`,
            peaks_path: `${owner}/${id}/podcast-clip-0-peaks.json`,
            proxy_path: `${owner}/${id}/proxy-0.mp4`,
          },
        ],
      },
    },
  });
  await page.addInitScript(() => {
    const Original = window.AudioContext;
    (window as any).__videoPlayErrors = [];
    const nativePlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      return nativePlay.call(this).catch((e) => {
        (window as any).__videoPlayErrors.push({
          name: e.name,
          message: e.message,
          muted: this.muted,
        });
        throw e;
      });
    };
    (window as any).__audioStarts = [];
    window.AudioContext = new Proxy(Original, {
      construct(Target, args) {
        const context = Reflect.construct(Target, args);
        const create = context.createBufferSource.bind(context);
        context.createBufferSource = () => {
          const source = create(),
            start = source.start.bind(source);
          source.start = (when: number, offset: number, duration: number) => {
            (window as any).__audioStarts.push({ context, when, offset });
            return start(when, offset, duration);
          };
          return source;
        };
        return context;
      },
    });
  });
  await page.goto(`/editor/new?source=podcast&job=${id}`);
  const video = page.getByLabel("Podcast video preview", { exact: true });
  await expect(video).toBeVisible();
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState))
    .toBeGreaterThanOrEqual(2);
  const canvas = page.getByLabel("Timeline waveform canvas"),
    box = (await canvas.boundingBox())!;
  const seek = (time: number) =>
    page.mouse.click(box.x + 180 + time * 50, box.y + 15);
  await seek(2.4);
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime))
    .toBeCloseTo(2.4, 2);
  await video.evaluate((v: HTMLVideoElement) => {
    (window as any).__previewStarted = false;
    v.addEventListener(
      "playing",
      () => {
        (window as any).__previewStarted = true;
      },
      { once: true },
    );
  });
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).__previewStarted))
    .toBe(true);
  await expect
    .poll(() => page.evaluate(() => (window as any).__audioStarts[0]?.offset))
    .toBeCloseTo(1.4, 2);
  await page.evaluate(() => {
    (window as any).__audioStarts = [];
  });
  await seek(2.1);
  await expect
    .poll(() => page.evaluate(() => (window as any).__audioStarts[0]?.offset))
    .toBeCloseTo(1.1, 2);
  // Restart near the cut, then measure decoded frames across the jump and silence.
  await page.evaluate(() => {
    (window as any).__audioStarts = [];
  });
  await seek(0.5);
  await expect
    .poll(() => page.evaluate(() => (window as any).__audioStarts.length))
    .toBeGreaterThan(0);
  const offset = await page.evaluate(
    () => (window as any).__audioStarts[0].offset,
  );
  expect(offset).toBeCloseTo(0.5, 2);
  const result = await video.evaluate(async (v: HTMLVideoElement) => {
    const start = (window as any).__audioStarts[0],
      samples: number[] = [],
      clockSamples: number[] = [],
      frames: object[] = [];
    let invalidDeviceClock = false;
    let cutAt: number | null = null;
    const outputAt = (wall: number) => {
      const ctx = start.context,
        stamp = ctx.getOutputTimestamp?.();
      const latency = (ctx.baseLatency ?? 0) + (ctx.outputLatency ?? 0);
      if (stamp?.performanceTime > wall + 100) invalidDeviceClock = true;
      const projected =
        stamp?.contextTime > 0 && stamp?.performanceTime > 0
          ? stamp.contextTime + (wall - stamp.performanceTime) / 1000
          : -1;
      const audioTime =
        !invalidDeviceClock &&
        projected >= 0 &&
        stamp.performanceTime <= wall + 100 &&
        projected <= ctx.currentTime + 0.1 &&
        ctx.currentTime - projected <= Math.max(1, latency + 0.25)
          ? projected
          : Math.max(0, ctx.currentTime - latency);
      return Math.max(0.5, audioTime - start.when + 0.5);
    };
    const waitFor = async (stage: string, condition: () => boolean) => {
      const deadline = performance.now() + 10000;
      for (;;) {
        if (cutAt === null && outputAt(performance.now()) >= 1)
          cutAt = performance.now();
        if (condition()) break;
        if (performance.now() >= deadline)
          throw Error(
            `Preview ${stage}: ${JSON.stringify({ output: outputAt(performance.now()), time: v.currentTime, paused: v.paused, seeking: v.seeking, ready: v.readyState, connected: v.isConnected })}`,
          );
        await new Promise(requestAnimationFrame);
      }
    };
    await waitFor(
      "initial presentation",
      () =>
        outputAt(performance.now()) >= 0.7 && !v.seeking && v.readyState >= 2,
    );
    let stopped = false;
    const sample = (_now: number, meta: VideoFrameCallbackMetadata) => {
      if (stopped) return;
      const output = outputAt(meta.expectedDisplayTime);
      const source =
        output < 1 ? output : output < 2 ? output + 1 : output < 3 ? 3 : output;
      if (!v.seeking) {
        samples.push(Math.abs(meta.mediaTime - source));
        clockSamples.push(Math.abs(v.currentTime - source));
        frames.push({
          output,
          source,
          pts: meta.mediaTime,
          time: v.currentTime,
          display: meta.expectedDisplayTime,
          wall: performance.now(),
          paused: v.paused,
        });
      }
      v.requestVideoFrameCallback(sample);
    };
    v.requestVideoFrameCallback(sample);
    await waitFor("inserted silence", () => {
      const output = outputAt(performance.now());
      return output >= 2.2 && output < 2.8 && v.paused && !v.seeking;
    });
    const held = { paused: v.paused, time: v.currentTime };
    await waitFor(
      "resume after silence",
      () => outputAt(performance.now()) >= 3.4 && !v.paused && !v.seeking,
    );
    const transitionSamples = [...samples],
      transitionClockSamples = [...clockSamples];
    // Include sustained playback after the two discontinuities, not just their recovery frames.
    await waitFor(
      "sustained playback",
      () => outputAt(performance.now()) >= 5.5 && !v.paused && !v.seeking,
    );
    stopped = true;
    return {
      samples,
      clockSamples,
      frames,
      transitionSamples,
      transitionClockSamples,
      invalidDeviceClock,
      cutAt,
      held,
      resumed: !v.paused,
      timestamp: start.context.getOutputTimestamp?.(),
      renderTime: start.context.currentTime,
      wallTime: performance.now(),
      baseLatency: start.context.baseLatency,
      outputLatency: start.context.outputLatency,
    };
  });
  expect(result.held.paused).toBe(true);
  expect(result.held.time).toBeCloseTo(3, 2);
  expect(result.resumed).toBe(true);
  expect(result.samples.length).toBeGreaterThan(8);
  const sorted = result.samples.toSorted((a, b) => a - b),
    p95 = sorted[Math.floor(sorted.length * 0.95)];
  const clockP95 = result.clockSamples.toSorted((a, b) => a - b)[
    Math.floor(result.clockSamples.length * 0.95)
  ];
  const invalidDeviceTimestamp = result.invalidDeviceClock;
  const ciPresentationAllowance =
    !!process.env.CI && browserName === "webkit" && invalidDeviceTimestamp;
  // CI WebKit's foreign time origin cannot support an exact compositor/device-clock comparison.
  // Keep bounded diagnostics for both reported clocks; CI-NOTES.md records the runner evidence.
  const decodedBudget = ciPresentationAllowance ? 0.2 : 1 / 15;
  // CI WebKit reports displayed PTS ~125 ms ahead of currentTime; keep this diagnostic within two frames.
  const clockBudget = ciPresentationAllowance ? 2 / 15 : 1 / 15;
  const recovered = result.frames.find(
    (f: any) =>
      result.cutAt !== null &&
      f.wall >= result.cutAt &&
      f.output >= 1 &&
      Math.abs(f.pts - f.source) <= decodedBudget &&
      (!ciPresentationAllowance || Math.abs(f.time - f.source) <= clockBudget),
  ) as any;
  const cutRecoveryMs =
    recovered && result.cutAt !== null
      ? recovered.wall - result.cutAt
      : Infinity;
  const percentile = (values: number[]) =>
    values.toSorted((a, b) => a - b)[Math.floor(values.length * 0.95)];
  const transitionP95 = percentile(result.transitionSamples),
    transitionClockP95 = percentile(result.transitionClockSamples);
  console.log(
    "EDITOR_VIDEO_SYNC",
    JSON.stringify({
      fps: 15,
      decoded_budget_seconds: decodedBudget,
      clock_budget_seconds: clockBudget,
      ci_invalid_timestamp_allowance: ciPresentationAllowance,
      samples: sorted.length,
      p95_seconds: p95,
      transition_p95_seconds: transitionP95,
      transition_clock_p95_seconds: transitionClockP95,
      max_seconds: sorted.at(-1),
      timestamp: result.timestamp,
      renderTime: result.renderTime,
      wallTime: result.wallTime,
      baseLatency: result.baseLatency,
      outputLatency: result.outputLatency,
      clock_p95_seconds: result.clockSamples.toSorted((a, b) => a - b)[
        Math.floor(result.clockSamples.length * 0.95)
      ],
      reported_pts_clock_offset_p95_seconds: percentile(
        result.frames.map((f: any) => Math.abs(f.pts - f.time)),
      ),
      cut_recovery_ms: cutRecoveryMs,
      cut_recovery_budget_ms: 250,
    }),
  );
  await writeFile(
    info.outputPath("editor-video-sync.json"),
    JSON.stringify(result),
  );
  console.log("EDITOR_VIDEO_FRAMES", JSON.stringify(result.frames));
  await info.attach("editor-video-sync.json", {
    body: JSON.stringify(result),
    contentType: "application/json",
  });
  expect(p95).toBeLessThanOrEqual(decodedBudget);
  expect(cutRecoveryMs).toBeLessThanOrEqual(250);
  if (ciPresentationAllowance) {
    expect(clockP95).toBeLessThanOrEqual(clockBudget);
  }
  await page
    .getByRole("button", { name: "Stop / return", exact: true })
    .click();
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime))
    .toBeCloseTo(0, 2);
});

test("twenty independent one-hour PCM sources retain a bounded decoded window cache", async ({
  page,
  request,
  browserName,
}, info) => {
  test.skip(
    browserName !== "chromium",
    "Memory reporting uses Chromium CDP; functional import/export runs on all engines.",
  );
  const { build } = await import("esbuild");
  const bundle = await build({
    stdin: {
      contents:
        'export {DawPlayback} from "./lib/daw/playback.ts";export {blankArrangement,importPlacement} from "./lib/editor/model.ts";',
      resolveDir: process.cwd(),
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
  });
  await signin(page, request);
  const ranges: number[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/__hour/")) {
      const m = /bytes=(\d+)-(\d+)/.exec(r.headers().range ?? "");
      if (m) ranges.push(Number(m[2]) - Number(m[1]) + 1);
    }
  });
  const measurement = await page.evaluate(async (source) => {
    const moduleUrl = URL.createObjectURL(
      new Blob([source], { type: "text/javascript" }),
    );
    const { DawPlayback, blankArrangement, importPlacement } = await import(
      moduleUrl
    );
    URL.revokeObjectURL(moduleUrl);
    let a = blankArrangement("33333333-3333-4333-8333-333333333333");
    a.duration = 3600;
    a.loop.end = 3600;
    const urls: Record<string, string> = {};
    for (let i = 0; i < 20; i++) {
      a = importPlacement(
        a,
        { id: "c" + i, name: `Hour ${i + 1}.wav`, duration: 3600 },
        { time: 0 },
      );
      urls["c" + i] = `http://127.0.0.1:54331/__hour/c${i}.wav`;
    }
    const engine = new DawPlayback();
    (window as any).__memoryEngine = engine;
    for (const time of [0, 1200, 2400]) {
      await engine.play(
        a,
        time,
        urls,
        () => {},
        () => {},
      );
      await new Promise((resolve) => setTimeout(resolve, 80));
      engine.stop();
    }
    const bytes = Array.from(
      engine.buffers.values() as Iterable<AudioBuffer>,
    ).reduce((sum, b) => sum + b.length * b.numberOfChannels * 4, 0);
    return {
      tracks: 20,
      source_duration_seconds: 3600,
      total_source_hours: 20,
      decoded_cache_bytes: bytes,
      decoded_cache_windows: engine.buffers.size,
    };
  }, bundle.outputFiles[0].text);
  await page.requestGC();
  const session = await page.context().newCDPSession(page),
    heap = await session.send("Runtime.getHeapUsage");
  await session.detach();
  const result = {
    ...measurement,
    max_range_bytes: Math.max(...ranges),
    range_requests: ranges.length,
    js_heap_bytes: heap.usedSize,
    scope:
      "Chromium shared Linux container; three seeks across twenty logical one-hour range-served WAV sources; not total browser RSS or an 8 GB Mac certification",
  };
  console.log("EDITOR_STREAMING_MEMORY " + JSON.stringify(result));
  await info.attach("editor-streaming-memory.json", {
    body: JSON.stringify(result, null, 2),
    contentType: "application/json",
  });
  expect(result.decoded_cache_windows).toBeLessThanOrEqual(64);
  expect(result.decoded_cache_bytes).toBeLessThanOrEqual(
    64 * 5 * 48000 * 2 * 4,
  );
  expect(result.max_range_bytes).toBeLessThanOrEqual(1048576);
  expect(result.range_requests).toBeGreaterThan(100);
  await page.evaluate(async () => {
    await (window as any).__memoryEngine.close();
    delete (window as any).__memoryEngine;
  });
});
