const rateUpdates = new WeakMap<HTMLVideoElement, number>();
const seeks = new WeakMap<HTMLVideoElement, number>();
const starts = new WeakMap<HTMLVideoElement, Promise<void>>();
export type VideoClock = { time: number; playing: boolean; gap: boolean };
/** Correct drift from the audio clock. A pending seek must settle before another. */
export function syncVideo(
  video: HTMLVideoElement,
  time: number,
  playing: boolean,
  now = performance.now(),
) {
  if (!video.muted) video.muted = true;
  if (!video.defaultMuted) video.defaultMuted = true;
  if (!playing) video.pause();
  if (video.readyState < 1) return;
  const target = Math.max(
    0,
    Math.min(time, Math.max(0, video.duration - 0.001)),
  );
  const driftBeforeSeek = Math.abs(video.currentTime - target);
  if (
    !video.seeking &&
    driftBeforeSeek > (playing ? 1 / 30 : 0.001) &&
    (!playing ||
      driftBeforeSeek > 0.25 ||
      now - (seeks.get(video) ?? -Infinity) >= 1000 / 15)
  ) {
    video.currentTime = target;
    seeks.set(video, now);
  }
  if (playing && !video.seeking) {
    const drift = target - video.currentTime;
    // Native media decoding stays continuous; small drift changes rate instead of seeking every frame.
    const rate =
      Math.round(
        (Math.abs(drift) < 0.008
          ? 1
          : Math.max(0.9, Math.min(1.1, 1 + drift))) * 100,
      ) / 100;
    if (
      rate !== video.playbackRate &&
      now - (rateUpdates.get(video) ?? -Infinity) >= 50
    ) {
      video.playbackRate = rate;
      rateUpdates.set(video, now);
    }
  } else if (!playing) {
    video.playbackRate = 1;
    rateUpdates.delete(video);
  }
  if (playing && video.paused && !video.seeking && !starts.has(video)) {
    const pending = video
      .play()
      .catch(() => {})
      .finally(() => {
        if (starts.get(video) === pending) starts.delete(video);
      });
    starts.set(video, pending);
  }
}
