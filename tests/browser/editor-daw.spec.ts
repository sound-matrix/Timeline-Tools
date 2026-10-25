import { expect, type Page } from "@playwright/test";
import { test } from "./editor-fixture";
import { readFile, mkdir } from "node:fs/promises";
import { build } from "esbuild";

test.skip(!process.env.DESK_FIXTURE, "Use desk fixture");
function wave() {
  const n = 48000 * 3,
    b = Buffer.alloc(44 + n * 2);
  b.write("RIFF");
  b.writeUInt32LE(b.length - 8, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(48000, 24);
  b.writeUInt32LE(96000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++)
    b.writeInt16LE(
      Math.round(Math.sin((i / 48000) * 440 * 2 * Math.PI) * 18000),
      44 + 2 * i,
    );
  return b;
}
async function open(page: Page, request: any, tracks = 3) {
  await request.post("http://127.0.0.1:54331/__reset");
  await page.goto("/signin");
  await page.getByLabel("Email", { exact: true }).fill("desk@example.test");
  await page.getByLabel("Password", { exact: true }).fill("desk-test-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/dashboard/);
  await page.getByRole("link", { name: "New Editor project" }).click();
  await expect(page.getByRole("main", { name: "Editor Studio" })).toBeVisible();
  await page.getByLabel("Import audio files", { exact: true }).setInputFiles(
    Array.from({ length: tracks }, (_, i) => ({
      name: `voice-${i}.wav`,
      mimeType: "audio/wav",
      buffer: wave(),
    })),
  );
  await expect(page.locator(".pro-header")).toHaveCount(tracks);
  await expect(
    page.getByRole("status", { name: "Editor save status" }),
  ).toHaveText("Saved", { timeout: 20000 });
}
test("full page DAW proportions, closed drawers, rename and screenshots at both desktop sizes", async ({
  page,
  request,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, request, 6);
  await expect(
    page.getByRole("region", { name: "Bottom dock", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("complementary", { name: "Clip bin" }),
  ).toBeHidden();
  for (const [width, height] of [
    [1440, 900],
    [1280, 800],
  ]) {
    await page.setViewportSize({ width, height });
    const timeline = await page.locator(".pro-scroll").boundingBox();
    expect(timeline!.height).toBeGreaterThanOrEqual(height * 0.65);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollHeight <= innerHeight,
      ),
    ).toBe(true);
    await page.screenshot({
      path: info.outputPath(`daw-${width}x${height}.png`),
    });
  }
  await page.getByLabel("Project name", { exact: true }).fill("Evening mix");
  await page.getByLabel("Project name", { exact: true }).press("Tab");
  await expect
    .poll(() =>
      page.request
        .get(page.url().replace("/editor/", "/api/editor/"))
        .then((r) => r.json())
        .then((p) => p.name),
    )
    .toBe("Evening mix");
  await page.reload();
  await expect(page.getByLabel("Project name", { exact: true })).toHaveValue(
    "Evening mix",
  );
});
test("clip, track, empty timeline and ruler menus support keyboard and flip at screen edges", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, request, 1);
  const canvas = page.getByLabel("Timeline waveform canvas"),
    box = (await canvas.boundingBox())!;
  await page.mouse.click(box.x + 240, box.y + 65, { button: "right" });
  const menu = page.getByRole("menu");
  await expect(
    menu.getByRole("menuitem", { name: "Cut", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(
    menu.getByRole("menuitem", { name: "Copy", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(menu).toHaveCount(0);
  await page.getByRole("region", { name: "DAW timeline", exact: true }).focus();
  await page.keyboard.press("Shift+F10");
  await expect(menu).toBeVisible();
  await page.keyboard.press("End");
  await expect(
    menu.getByRole("menuitem", { name: "Add effect to clip" }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await page.locator(".pro-header").click({ button: "right" });
  await expect(
    menu.getByRole("menuitem", { name: "Freeze (later)", exact: true }),
  ).toBeDisabled();
  await menu.getByRole("menuitem", { name: "Height L", exact: true }).click();
  await expect(page.locator(".pro-header")).toHaveCSS("height", "180px");
  const rulerBox = (await canvas.boundingBox())!;
  await page.mouse.click(rulerBox.x + 350, rulerBox.y + 15, {
    button: "right",
  });
  await expect(
    menu.getByRole("menuitem", { name: "Set loop start", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.mouse.click(1420, 850, { button: "right" });
  await expect(
    menu.getByRole("menuitem", { name: "Add track", exact: true }),
  ).toBeVisible();
  const b = (await menu.boundingBox())!;
  expect(b.x + b.width).toBeLessThanOrEqual(1440);
  expect(b.y + b.height).toBeLessThanOrEqual(900);
  await menu.getByRole("menuitem", { name: "Paste", exact: true }).click();
  await expect(page.locator(".daw-toolstrip")).toContainText("2 clips");
});
test("effect add, bypass, keyboard reorder and parameters persist; local export processes effects", async ({
  page,
  request,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, request, 1);
  await page.getByRole("button", { name: "FX voice-0", exact: true }).click();
  await page
    .getByLabel("Add effect", { exact: true })
    .selectOption("saturation");
  await page.getByLabel("Add effect", { exact: true }).selectOption("eq");
  await page.getByRole("slider", { name: "Drive", exact: true }).press("End");
  await page
    .getByRole("button", { name: "Move Shape EQ left", exact: true })
    .click();
  await expect(page.locator(".fx-card").first()).toContainText("1. Shape EQ");
  await page
    .getByRole("button", { name: "Bypass Shape EQ", exact: true })
    .click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByRole("status", { name: "Editor save status" }),
  ).toHaveText("Saved");
  await page.reload();
  await page.getByRole("button", { name: "FX voice-0", exact: true }).click();
  await expect(page.locator(".fx-card").first()).toContainText("1. Shape EQ");
  await expect(
    page.getByRole("button", { name: "Bypass Shape EQ", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("slider", { name: "Drive", exact: true }),
  ).toHaveAttribute("aria-valuenow", "16");
  await page.screenshot({ path: info.outputPath("daw-effects-rack.png") });
  const downloadMix = async () => {
    await page.getByRole("button", { name: "Export", exact: true }).click();
    const wait = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "Download local mix · free" })
      .click();
    const file = await wait;
    return readFile((await file.path())!);
  };
  const wet = await downloadMix();
  await page
    .getByRole("button", { name: "Bypass Warmth", exact: true })
    .click();
  const dry = await downloadMix();
  expect(wet.length).toBe(dry.length);
  let difference = 0;
  for (let i = 44; i < wet.length; i++) if (wet[i] !== dry[i]) difference++;
  expect(difference).toBeGreaterThan(10000);
});
test("offline Web Audio and Python agree for EQ, space, echo and warmth across processing blocks", async ({
  page,
  request,
}) => {
  await open(page, request, 1);
  const bundled = await build({
    entryPoints: ["lib/daw/effects.ts"],
    bundle: true,
    format: "iife",
    globalName: "TestEffects",
    write: false,
  });
  await page.addScriptTag({ content: bundled.outputFiles[0].text });
  const result = await page.evaluate(async () => {
    const lib = (window as any).TestEffects,
      rate = 8000,
      n = 16000;
    const slots = ["eq", "reverb", "delay", "saturation"].map((type, i) => ({
      id: "fx" + i,
      type,
      enabled: true,
      parameters: lib.effectDefaults(type),
    }));
    slots[0].parameters.g2 = 5;
    const ctx = new OfflineAudioContext(2, n, rate),
      src = ctx.createBufferSource(),
      b = ctx.createBuffer(2, n, rate);
    for (let c = 0; c < 2; c++) {
      const v = b.getChannelData(c);
      for (let i = 0; i < n; i++)
        v[i] = 0.2 * Math.sin((i / rate) * (c ? 660 : 440) * 2 * Math.PI);
    }
    src.buffer = b;
    const fx = lib.createEffectChain(ctx, slots, 120);
    src.connect(fx.input);
    fx.output.connect(ctx.destination);
    src.start();
    const output = await ctx.startRendering();
    return {
      slots,
      channels: [
        Array.from(output.getChannelData(0)),
        Array.from(output.getChannelData(1)),
      ],
    };
  });
  const { spawnSync } = await import("node:child_process");
  const py = spawnSync(
    "python",
    [
      "-c",
      `import sys,json,numpy as np\nfrom workers.editor_dsp import InsertChain\nx=json.load(sys.stdin);t=np.arange(16000)/8000;a=np.column_stack([.2*np.sin(t*440*2*np.pi),.2*np.sin(t*660*2*np.pi)]).astype('float32');chain=InsertChain(x['slots'],8000,120);out=np.concatenate([chain.process(a[i:i+137]) for i in range(0,len(a),137)]);ref=np.array(x['channels']).T;print(np.max(np.abs(out-ref)))`,
    ],
    {
      input: JSON.stringify(result),
      encoding: "utf8",
      env: { ...process.env, PYTHONPATH: process.cwd() },
    },
  );
  expect(py.status, py.stderr).toBe(0);
  expect(Number(py.stdout)).toBeLessThan(0.005);
});
test("16 tracks × 50 clips keep the desk scroll and zoom frame budget", async ({
  page,
  request,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, request, 1);
  const url = page.url().replace("/editor/", "/api/editor/"),
    data = await (await page.request.get(url)).json(),
    a = data.arrangement;
  a.duration = 3600;
  a.loop.end = 3600;
  a.lanes = Array.from({ length: 16 }, (_, i) => ({
    ...a.lanes[0],
    id: `track${i}`,
    name: `Track ${i + 1}`,
    height: 96,
  }));
  a.regions = Array.from({ length: 800 }, (_, i) => ({
    ...a.regions[0],
    id: `region${i}`,
    lane: `track${i % 16}`,
    start: Math.floor(i / 16) * 8,
    src_start: 0,
    src_end: 3,
  }));
  await page.route("**/api/editor/*", async (route) => {
    if (
      route.request().method() === "GET" &&
      !route.request().url().includes("/media")
    )
      await route.fulfill({ json: { ...data, arrangement: a } });
    else await route.continue();
  });
  await page.reload();
  await expect(page.locator(".daw-toolstrip")).toContainText("800 clips");
  const samples = await page.locator(".pro-scroll").evaluate(async (el) => {
    const samples: number[] = [];
    let previous = performance.now();
    for (let i = 0; i < 240; i++)
      await new Promise<void>((resolve) =>
        requestAnimationFrame((t) => {
          if (i >= 60) samples.push(t - previous);
          previous = t;
          el.scrollLeft = (i * 90) % 16000;
          el.scrollTop = (i * 13) % 1200;
          if (i % 20 === 0)
            el.dispatchEvent(
              new WheelEvent("wheel", {
                deltaY: i % 40 === 0 ? 8 : -8,
                ctrlKey: true,
                bubbles: true,
                cancelable: true,
              }),
            );
          resolve();
        }),
      );
    return samples.sort((a, b) => a - b);
  });
  const report = {
    tracks: 16,
    clips: 800,
    p50: samples[Math.floor(samples.length * 0.5)],
    p95: samples[Math.floor(samples.length * 0.95)],
    max: samples.at(-1),
  };
  console.log("EDITOR_DAW_PERF", JSON.stringify(report));
  await info.attach("editor-daw-performance.json", {
    body: JSON.stringify(report),
    contentType: "application/json",
  });
  // rAF timestamps are quantized to 0.1 ms: a 60 Hz interval can read 16.8.
  // Count refresh intervals instead of treating that quantization as dropped frames.
  const refresh = 1000 / 60,
    frameBudget = Math.round(report.p95 / refresh) * refresh;
  expect(frameBudget).toBeLessThanOrEqual(16.7);
  expect(
    samples.filter((t) => t > refresh * 1.5).length / samples.length,
  ).toBeLessThanOrEqual(0.05);
});

test("section keyboard reorder/duplicate moves its audio and dock tabs remain separate", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, request, 1);
  await page.getByRole("button", { name: "+ Section", exact: true }).click();
  await page.getByRole("button", { name: "+ Section", exact: true }).click();
  const first = page.getByRole("button", {
    name: "Section Section 1",
    exact: true,
  });
  await first.focus();
  await first.press("Alt+ArrowRight");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const url = page.url().replace("/editor/", "/api/editor/");
  await expect
    .poll(async () => {
      const p = await (await page.request.get(url)).json();
      return p.arrangement.regions[0].start;
    })
    .toBe(8);
  await first.focus();
  await first.press("Alt+d");
  await expect(page.locator(".daw-toolstrip")).toContainText("2 clips");
  await first.press("Enter");
  await expect(
    page.getByRole("button", { name: "Loop", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Dock · X", exact: true }).click();
  await page.getByRole("tab", { name: "Markers", exact: true }).click();
  await page
    .getByRole("button", { name: "Add marker (M)", exact: true })
    .click();
  await expect(page.getByRole("tabpanel", { name: "Markers" })).toContainText(
    "Markers (1)",
  );
  await expect(
    page.getByRole("tabpanel", { name: "Markers" }),
  ).not.toContainText("Regions (");
  await page.getByRole("tab", { name: "Regions", exact: true }).click();
  await expect(page.getByRole("tabpanel", { name: "Regions" })).toContainText(
    "Regions (2)",
  );
  await expect(
    page.getByRole("tabpanel", { name: "Regions" }),
  ).not.toContainText("Markers (");
});
