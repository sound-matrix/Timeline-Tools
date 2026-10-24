export type VideoClock = { time: number; playing: boolean; gap: boolean };
/** Correct drift from the audio clock. A pending seek must settle before another. */
export function syncVideo(
  video: HTMLVideoElement,
  time: number,
  playing: boolean,
) {
  if (!playing) video.pause();
  if (video.readyState < 1) return;
  const target = Math.max(
    0,
    Math.min(time, Math.max(0, video.duration - 0.001)),
  );
  if (
    !video.seeking &&
    Math.abs(video.currentTime - target) > (playing ? 0.25 : 0.001)
  )
    video.currentTime = target;
  if (playing && !video.seeking) {
    const drift = target - video.currentTime;
    // Native media decoding stays continuous; small drift changes rate instead of seeking every frame.
    video.playbackRate =
      Math.abs(drift) < 0.008 ? 1 : Math.max(0.9, Math.min(1.1, 1 + drift));
  } else if (!playing) video.playbackRate = 1;
  if (playing && video.paused) void video.play().catch(() => {});
}
