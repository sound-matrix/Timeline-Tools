"use client";
import { useEffect, useRef, useState, type RefObject } from "react";
import { syncVideo, type VideoClock } from "@/lib/daw/video-sync";
/** The preview follows audio-clock samples without React updates on every frame. */
export default function VideoPreview({
  media,
  playhead,
  playing,
  clock,
}: {
  media: {
    index: number;
    offset: number;
    duration: number;
    proxy: string | null;
  }[];
  playhead: number;
  playing: boolean;
  clock?: RefObject<VideoClock>;
}) {
  const [floating, setFloating] = useState(false),
    [activeIndex, setActiveIndex] = useState<number | null>(null),
    video = useRef<HTMLVideoElement>(null);
  const latest = useRef({ media, playhead, playing, clock });
  latest.current = { media, playhead, playing, clock };
  const selected = useRef<number | null>(null);
  const active = media.find((m) => m.index === activeIndex);
  useEffect(() => {
    let frame = 0;
    const update = () => {
      const current = latest.current,
        sample = current.clock?.current ?? {
          time: current.playhead,
          playing: current.playing,
          gap: false,
        },
        clip = current.media.find(
          (m) =>
            m.proxy &&
            sample.time >= m.offset &&
            sample.time < m.offset + m.duration,
        ),
        index = clip?.index ?? null;
      if (selected.current !== index) {
        selected.current = index;
        setActiveIndex(index);
      }
      const v = video.current;
      if (v && clip && v.dataset.mediaIndex === String(clip.index))
        syncVideo(
          v,
          sample.time - clip.offset,
          current.playing && sample.playing && !sample.gap,
        );
      frame = requestAnimationFrame(update);
    };
    frame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frame);
  }, []);
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
            data-media-index={active.index}
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
