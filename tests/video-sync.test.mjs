import test from "node:test";
import assert from "node:assert/strict";
import { syncVideo } from "../lib/daw/video-sync.ts";
import { outputClockTime } from "../lib/daw/output-clock.ts";

test("paused seeks are exact and metadata/loading never starts playback", () => {
  const video = {
    readyState: 0,
    duration: 8,
    currentTime: 0,
    paused: true,
    seeking: false,
    pause() {
      this.paused = true;
    },
    play() {
      throw Error("must stay paused");
    },
  };
  syncVideo(video, 2.4, false);
  assert.equal(video.currentTime, 0);
  video.readyState = 4;
  syncVideo(video, 2.4, false);
  assert.equal(video.currentTime, 2.4);
  assert.equal(video.paused, true);
});

test("clock drift seeks wait for an in-flight seek and inserted silence holds the source frame", () => {
  const video = {
    readyState: 4,
    duration: 8,
    currentTime: 1,
    paused: true,
    seeking: true,
    pause() {
      this.paused = true;
    },
    async play() {
      this.paused = false;
    },
  };
  syncVideo(video, 3, true);
  assert.equal(video.currentTime, 1);
  assert.equal(video.paused, false);
  video.seeking = false;
  syncVideo(video, 3, true);
  assert.equal(video.currentTime, 3);
  assert.equal(video.paused, false);
  syncVideo(video, 3, false);
  assert.equal(video.currentTime, 3);
  assert.equal(video.paused, true);
});

test("one native play request can unblock a pending seek without repeated starts", async () => {
  let finish,
    calls = 0;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const v = {
    readyState: 4,
    duration: 8,
    currentTime: 2,
    paused: true,
    seeking: true,
    playbackRate: 1,
    pause() {},
    play() {
      calls++;
      return pending;
    },
  };
  for (let i = 0; i < 20; i++) syncVideo(v, 3, true, i * 16);
  assert.equal(calls, 1);
  assert.equal(v.currentTime, 2, "the in-flight seek is preserved");
  finish();
  await pending;
});

test("continuous drift corrections cannot restart native decoding faster than the proxy frame rate", () => {
  const video = {
    readyState: 4,
    duration: 8,
    currentTime: 2,
    paused: false,
    seeking: false,
    playbackRate: 1,
    pause() {},
    async play() {},
  };
  syncVideo(video, 2.04, true, 0);
  assert.equal(video.currentTime, 2.04);
  syncVideo(video, 2.08, true, 16);
  assert.equal(video.currentTime, 2.04);
  syncVideo(video, 2.12, true, 67);
  assert.equal(video.currentTime, 2.12);
  syncVideo(video, 4, true, 68);
  assert.equal(
    video.currentTime,
    4,
    "a cut jump bypasses the continuous-drift throttle",
  );
});

test("small clock drift adjusts native playback rate without restarting decoding", () => {
  const video = {
    readyState: 4,
    duration: 8,
    currentTime: 2,
    paused: false,
    seeking: false,
    playbackRate: 1,
    pause() {
      this.paused = true;
    },
    async play() {
      this.paused = false;
    },
  };
  for (let i = 0; i < 60; i++) syncVideo(video, 2.03, true);
  assert.equal(video.currentTime, 2);
  assert.ok(video.playbackRate > 1 && video.playbackRate <= 1.1);
  syncVideo(video, 2, false);
  assert.equal(video.playbackRate, 1);
});

test("presentation time uses the device timestamp rather than the render-ahead cursor", () => {
  const context = {
    currentTime: 10.5,
    getOutputTimestamp: () => ({ contextTime: 10, performanceTime: 1000 }),
  };
  assert.ok(Math.abs(outputClockTime(context, 1100) - 10.1) < 1e-9);
  assert.ok(Math.abs(outputClockTime(context, 1016) - 10.016) < 1e-9);
});
test("presentation clock falls back before an output timestamp is available", () => {
  assert.equal(outputClockTime({ currentTime: 2 }, 1000), 2);
  assert.equal(
    outputClockTime(
      {
        currentTime: 2,
        getOutputTimestamp: () => ({ contextTime: 0, performanceTime: 0 }),
      },
      1000,
    ),
    2,
  );
});

test("a zero device timestamp uses reported output latency instead of freezing video", () => {
  const c = {
    currentTime: 2,
    baseLatency: 0.05,
    outputLatency: 0.1,
    getOutputTimestamp: () => ({ contextTime: 0, performanceTime: 1000 }),
  };
  assert.ok(Math.abs(outputClockTime(c, 1100) - 1.85) < 1e-9);
});

test("a timestamp from a foreign time origin cannot pin the presentation clock to zero", () => {
  const c = {
    currentTime: 4,
    baseLatency: 0.01,
    outputLatency: 0,
    getOutputTimestamp: () => ({ contextTime: 1, performanceTime: 100000 }),
  };
  assert.equal(outputClockTime(c, 1000), 3.99);
});

test("drift beyond the 66.7 ms clock budget is corrected rather than slowly accumulated", () => {
  const v = {
    readyState: 4,
    duration: 8,
    currentTime: 2,
    paused: false,
    seeking: false,
    playbackRate: 1,
    pause() {},
    async play() {},
  };
  syncVideo(v, 2.08, true);
  assert.equal(v.currentTime, 2.08);
});

test("a future device timestamp is rejected even when its projection looks plausible", () => {
  const c = {
    currentTime: 2,
    baseLatency: 0.01,
    getOutputTimestamp: () => ({ contextTime: 2.8, performanceTime: 2000 }),
  };
  assert.equal(outputClockTime(c, 1200), 1.99);
});
