"use client";
import { useRef, useState } from "react";
import type { AlignmentReport, ScriptLine } from "@/lib/audio-studio";
import type { ProcessingState } from "@/lib/job-status";

export default function StudioTimeline({
  report,
  lines,
  voices,
  guide,
  bed,
  state,
  mixHref,
}: {
  report: AlignmentReport | null;
  lines: ScriptLine[];
  voices: { name: string; speaker: string }[];
  guide: string;
  bed?: string;
  state?: ProcessingState["status"];
  mixHref?: string;
}) {
  const [selected, setSelected] = useState<number | null>(null);
  const [paused, setPaused] = useState(false);
  const player = useRef<HTMLAudioElement>(null);
  const tracks =
    report?.tracks ??
    voices.map((voice, i) => ({ id: `voice-${i}`, ...voice }));
  const active = state === "processing";
  function select(i: number) {
    setSelected(i);
    if (player.current && report)
      player.current.currentTime = report.lines[i].start;
  }
  const time = (n: number) =>
    `${Math.floor(n / 60)}:${(n % 60).toFixed(2).padStart(5, "0")}`;
  return (
    <section
      className={`card studio-timeline${active && !paused ? " studio-aligning" : ""}`}
      aria-label="Multitrack timeline"
    >
      <div className="processing-heading">
        <div>
          <p className="eyebrow">02 · ALIGNMENT DESK</p>
          <h3>Every voice in its place</h3>
        </div>
        {active && (
          <button
            type="button"
            className="btn ghost live-motion-toggle"
            aria-pressed={paused}
            onClick={() => setPaused(!paused)}
          >
            {paused ? "Resume clip motion" : "Pause clip motion"}
          </button>
        )}
      </div>
      <p className="muted">
        {report
          ? "Select a clip or script row to seek the finished mix. Timing is heuristic: review before publishing."
          : active
            ? "Clip motion shows worker activity. Measured timing appears when processing finishes."
            : "Your tracks are ready for alignment. Clip positions and confidence appear after processing."}
      </p>
      <div className="studio-lanes" role="group" aria-label="Audio tracks">
        <div className="studio-ruler">
          <span>{report ? "0:00" : "Start"}</span>
          <span>{report ? time(report.duration / 2) : "Guide timing"}</span>
          <span>{report ? time(report.duration) : "End"}</span>
        </div>
        <div className="studio-lane">
          <div className="studio-track-label">
            <b>Guide</b>
            <small>{guide || "Reference track"}</small>
          </div>
          <div className="studio-track">
            <div className="studio-guide-clip">
              {report
                ? `${time(report.duration)} · reference only`
                : "Reference only · not in final mix"}
            </div>
          </div>
        </div>
        {tracks.map((track) => (
          <div className="studio-lane" key={track.id}>
            <div className="studio-track-label">
              <b>{track.speaker || "Voice / dub"}</b>
              <small>{track.name}</small>
            </div>
            <div className="studio-track">
              {report ? (
                report.lines.map(
                  (line, i) =>
                    line.track === track.id && (
                      <button
                        type="button"
                        className={`studio-clip${line.confidence < 0.7 ? " low" : ""}${selected === i ? " selected" : ""}`}
                        key={i}
                        style={{
                          left: `${(100 * line.start) / report.duration}%`,
                          width: `${Math.max(0.7, (100 * (line.end - line.start)) / report.duration)}%`,
                        }}
                        title={`${line.text} · heuristic ${Math.round(line.confidence * 100)} / 100`}
                        aria-label={`Cue ${i + 1}: ${line.text}`}
                        aria-pressed={selected === i}
                        onClick={() => select(i)}
                      >
                        {i + 1} · {line.text}
                      </button>
                    ),
                )
              ) : (
                <div className="studio-pending-clip">
                  {active ? "Aligning…" : "Awaiting alignment"}
                </div>
              )}
            </div>
          </div>
        ))}
        {bed && (
          <div className="studio-lane">
            <div className="studio-track-label">
              <b>Music / SFX</b>
              <small>{bed}</small>
            </div>
            <div className="studio-track">
              <div className="studio-bed-clip">Music / SFX bed</div>
            </div>
          </div>
        )}
      </div>
      {mixHref && (
        <div className="studio-mix-player">
          <label htmlFor="studio-mix">Review your finished mix</label>
          <audio
            id="studio-mix"
            aria-label="Finished studio mix"
            ref={player}
            controls
            preload="none"
            src={mixHref}
          />
        </div>
      )}
      <div className="table-scroll studio-script-table">
        <table>
          <caption>Script alignment · heuristic confidence scores</caption>
          <thead>
            <tr>
              <th>Line</th>
              <th>Speaker</th>
              <th>Script</th>
              <th>Guide timing</th>
              <th>Confidence</th>
            </tr>
          </thead>
          <tbody>
            {report
              ? report.lines.map((line, i) => (
                  <tr
                    key={i}
                    className={selected === i ? "studio-selected-row" : ""}
                  >
                    <td>
                      <button
                        type="button"
                        className="btn ghost sm"
                        onClick={() => select(i)}
                        aria-label={`Review line ${i + 1}`}
                      >
                        {i + 1}
                      </button>
                    </td>
                    <td>{line.speaker || "Voice"}</td>
                    <td>
                      {line.text}
                      {line.flags.length > 0 && (
                        <small className="block muted">
                          {line.flags.join(" · ")}
                        </small>
                      )}
                    </td>
                    <td>
                      {time(line.start)} – {time(line.end)}
                    </td>
                    <td>
                      <span
                        className={`tag ${line.confidence < 0.7 ? "y" : "g"}`}
                      >
                        {Math.round(line.confidence * 100)} / 100
                        {line.confidence < 0.7
                          ? " · Low confidence"
                          : " · Review"}
                      </span>
                    </td>
                  </tr>
                ))
              : lines.map((line, i) => (
                  <tr key={i}>
                    <td>{i + 1}</td>
                    <td>{line.speaker || "Voice"}</td>
                    <td>{line.text}</td>
                    <td>
                      {line.start !== undefined
                        ? `${time(line.start)} – ${time(line.end!)}`
                        : "Pending"}
                    </td>
                    <td>Not measured</td>
                  </tr>
                ))}
          </tbody>
        </table>
      </div>
      {report && <p className="muted studio-method-note">{report.note}</p>}
    </section>
  );
}
