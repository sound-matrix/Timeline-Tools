import test from "node:test";
import assert from "node:assert/strict";
import { syncVideo } from "../lib/daw/video-sync.ts";

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
