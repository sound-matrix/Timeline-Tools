"use client";
import type { AlignmentReport } from "@/lib/audio-studio";
/** Read-only compatibility view for completed heuristic-v1 jobs. */
export default function StudioTimeline({
  report,
}: {
  report: AlignmentReport;
}) {
  return (
    <section className="card" aria-label="Legacy timeline">
      <h3>Previous alignment</h3>
      <p className="muted">
        This completed job uses the earlier alignment format. New sessions open
        in the editable DAW.
      </p>
      <div className="studio-lanes">
        {report.tracks.map((t) => (
          <div key={t.id} className="studio-lane">
            <b>{t.speaker || t.name}</b>
            <div className="studio-track">
              {report.lines
                .filter((l) => l.track === t.id)
                .map((l, i) => (
                  <span
                    className="studio-clip"
                    key={i}
                    style={{
                      left: `${(l.start / report.duration) * 100}%`,
                      width: `${((l.end - l.start) / report.duration) * 100}%`,
                    }}
                  >
                    {l.text}
                  </span>
                ))}
            </div>
          </div>
        ))}
      </div>
      <div className="table-scroll">
        <table>
          <caption>Previous match report</caption>
          <thead>
            <tr>
              <th>Script</th>
              <th>Timing</th>
              <th>Confidence</th>
            </tr>
          </thead>
          <tbody>
            {report.lines.map((l, i) => (
              <tr key={i}>
                <td>{l.text}</td>
                <td>
                  {l.start.toFixed(2)}–{l.end.toFixed(2)}
                </td>
                <td>{Math.round(l.confidence * 100)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted">{report.note}</p>
    </section>
  );
}
