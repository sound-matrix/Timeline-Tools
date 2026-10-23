"use client";
import { useState } from "react";
export function ProcessingWave() {
  return (
    <span className="processing-wave" aria-hidden="true">
      {Array.from({ length: 7 }, (_, i) => (
        <i key={i} style={{ "--i": i } as React.CSSProperties} />
      ))}
    </span>
  );
}
export default function StudioMotion({ type }: { type: string }) {
  const [paused, setPaused] = useState(false);
  return (
    <div className={"studio-motion" + (paused ? " motion-stopped" : "")}>
      {type === "master" ? (
        <span className="studio-meter" aria-hidden="true">
          <i />
        </span>
      ) : type === "subtitles" ? (
        <span className="sub-cues" aria-hidden="true">
          ≋
        </span>
      ) : (
        <ProcessingWave />
      )}
      <div>
        <b>
          {type === "master"
            ? "Loudness, with intention"
            : type === "subtitles"
              ? "Make room for every word"
              : "Focus on the voice"}
        </b>
        <p>
          {type === "master"
            ? "Illustrative meter · actual LUFS and true peak arrive in your report."
            : type === "subtitles"
              ? "Choose a language and review the generated subtitles before publishing."
              : "Tune noise reduction to your recording. Progress appears in Recent jobs."}
        </p>
      </div>
      <button
        type="button"
        aria-pressed={paused}
        onClick={() => setPaused(!paused)}
      >
        {paused ? "Resume motion" : "Pause motion"}
      </button>
    </div>
  );
}
