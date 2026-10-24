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
    Math.abs(video.currentTime - target) > (playing ? 1 / 60 : 0.001)
  )
    video.currentTime = target;
  if (playing && video.paused)
    void video.play().catch(() => {});
}
