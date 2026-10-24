import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { blankArrangement, importPlacement } from "../lib/editor/model.ts";
const bundled = await build({
  entryPoints: ["lib/daw/playback.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
});
const { DawPlayback } = await import(
  "data:text/javascript;base64," +
    Buffer.from(bundled.outputFiles[0].text).toString("base64")
);
function context() {
  const sources = [];
  const param = () => ({
    value: 1,
    setTargetAtTime() {},
    setValueCurveAtTime() {},
    cancelScheduledValues() {},
  });
  const node = () => ({
    connect() {
      return arguments[0];
    },
    disconnect() {},
    gain: param(),
  });
  return {
    currentTime: 10,
    sampleRate: 48000,
    sources,
    destination: node(),
    resume: async () => {},
    close: async () => {},
    createGain: node,
    createAnalyser: node,
    createChannelSplitter: node,
    createChannelMerger: node,
    createBufferSource() {
      const n = {
        ...node(),
        start(...args) {
          this.started = args;
        },
        stop(...args) {
          this.stopped = args;
        },
      };
      sources.push(n);
      return n;
    },
  };
}
test("seek schedules the requested source offset and live gain edits leave other voices running", async () => {
  const frames = [];
  globalThis.requestAnimationFrame = (fn) => {
    frames.push(fn);
    return frames.length;
  };
  globalThis.cancelAnimationFrame = () => {};
  const id = "33333333-3333-4333-8333-333333333333";
  let a = importPlacement(
    blankArrangement(id),
    { id: "voice", name: "voice.wav", duration: 2 },
    { time: 0 },
  );
  a.duration = 2;
  a.loop.end = 2;
  a.regions.push({ ...a.regions[0], id: "other" });
  const engine = new DawPlayback(),
    ctx = context();
  engine.context = ctx;
  engine.reader = async () => ({
    duration: 2,
    length: 96000,
    sampleRate: 48000,
  });
  try {
    await engine.play(
      a,
      1.2,
      { voice: "fixture.wav" },
      () => {},
      () => {},
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(ctx.sources.length, 2);
    for (const source of ctx.sources) {
      assert.ok(Math.abs(source.started[1] - 1.2) < 1e-9);
      assert.ok(source.started[0] >= 10.039);
    }
    const next = {
      ...a,
      regions: a.regions.map((r, i) => (i ? r : { ...r, gain_db: -3 })),
    };
    engine.update(next);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(ctx.sources[0].stopped);
    assert.equal(ctx.sources[1].stopped, undefined);
  } finally {
    engine.stop();
    delete globalThis.requestAnimationFrame;
    delete globalThis.cancelAnimationFrame;
  }
});
