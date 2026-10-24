import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
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
}) => {
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
  await page.getByLabel("Import audio files", { exact: true }).setInputFiles({
    name: "recover.wav",
    mimeType: "audio/wav",
    buffer: wave(2, 550),
  });
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
