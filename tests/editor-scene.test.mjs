import test from "node:test";
import assert from "node:assert/strict";
import { ClipScene } from "../public/daw/clip-scene.js";

test("visible repeated clips share zoom-level bitmaps and reuse image elements while scrolling", () => {
  const previous = globalThis.document;
  const context = new Proxy(
    {},
    { get: (target, key) => target[key] ?? (() => {}) },
  );
  let images = 0,
    encodes = 0;
  const element = (tag) => ({
    style: {},
    children: [],
    width: 0,
    height: 0,
    append(node) {
      node.remove();
      this.children.push(node);
      node.parent = this;
    },
    prepend(node) {
      node.remove();
      this.children.unshift(node);
      node.parent = this;
    },
    remove() {
      if (this.parent)
        this.parent.children = this.parent.children.filter((n) => n !== this);
      this.parent = null;
    },
    querySelectorAll() {
      return [];
    },
    getContext() {
      return context;
    },
    toDataURL() {
      encodes++;
      return `data:image/png;base64,${this.width}`;
    },
  });
  globalThis.document = {
    createElement(tag) {
      if (tag === "img") images++;
      return element(tag);
    },
  };
  const scene = new ClipScene();
  try {
    const a = {
      regions: Array.from({ length: 50 }, (_, i) => ({
        id: `r${i}`,
        lane: "track",
        clip: "voice",
        start: i * 8,
        src_start: 0,
        src_end: 3,
        fade_in: 0,
        fade_out: 0,
        lines: [],
        gain_db: 0,
      })),
      clips: [{ id: "voice", name: "Voice" }],
      derived_clips: [],
      missing: [],
      markers: [],
      loop: { enabled: false },
      tempo: 120,
      time_signature: [4, 4],
    };
    const root = element("div"),
      state = {
        a,
        view: { x: 0, y: 0, w: 900, h: 400 },
        zoom: 50,
        dpr: 1,
        headerWidth: 200,
        peaks: {},
        selection: [],
        rows: [{ id: "track", y: 36, height: 96, color: "#818CF8" }],
        overlays: [],
        videos: [],
        ruler: "minsec",
        range: null,
      };
    for (let i = 0; i < 240; i++) {
      scene.draw(root, {
        ...state,
        zoom: i % 40 < 20 ? 50 : 48.039473,
        view: { ...state.view, x: i * 60 },
      });
      assert.ok(scene.attached.size <= 3);
    }
    assert.ok(images <= 5, `created ${images} images for 50 clips`);
    assert.equal(encodes, 1, "small zoom changes reuse one raster level");
    assert.equal(scene.cache.items.size, 1);
    scene.draw(root, { ...state, zoom: 80 });
    assert.equal(encodes, 2, "a different raster level gets a new bitmap");
  } finally {
    scene.close();
    if (previous) globalThis.document = previous;
    else delete globalThis.document;
  }
});
