"use client";
import { useEffect, useRef, useState } from "react";
/** Media-element playback stays on the audio clock; seeks converge within one 30fps frame. */
export default function VideoPreview({
  media,
  playhead,
  playing,
}: {
  media: {
    index: number;
    offset: number;
    duration: number;
    proxy: string | null;
  }[];
  playhead: number;
  playing: boolean;
}) {
  const [floating, setFloating] = useState(false),
    video = useRef<HTMLVideoElement>(null);
  const active = media.find(
    (m) => m.proxy && playhead >= m.offset && playhead < m.offset + m.duration,
  );
  const clock = useRef({ playhead, at: 0, playing });
  useEffect(() => {
    clock.current = { playhead, at: performance.now(), playing };
    const v = video.current;
    if (!v || !active) return;
    const target = playhead - active.offset;
    if (Math.abs(v.currentTime - target) > 1 / 30) v.currentTime = target;
    if (playing) void v.play().catch(() => {});
    else v.pause();
  }, [playhead, playing, active?.index, active?.offset]);
  return (
    <div className={floating ? "pro-video-floating" : ""}>
      <button
        type="button"
        className="btn ghost"
        onClick={() => setFloating((x) => !x)}
      >
        {floating ? "Dock preview" : "Float preview"}
      </button>
      <div className="pro-video-preview">
        {active ? (
          <video
            key={active.index}
            ref={video}
            src={active.proxy!}
            muted
            playsInline
            preload="auto"
            aria-label="Podcast video preview"
          />
        ) : (
          <p className="muted">
            {media.some((m) => m.proxy)
              ? "No video at this time."
              : "Audio session"}
          </p>
        )}
      </div>
    </div>
  );
}
