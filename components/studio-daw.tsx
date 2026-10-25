"use client";
import { useEffect, useRef, useState } from "react";
import {
  arrangementSchema,
  exportSettingsSchema,
  type Arrangement,
} from "@/lib/arrangement";
import { withDefaults } from "@/lib/defaults";
import { alignmentReportSchema } from "@/lib/audio-studio";
import DawTimeline from "./daw/daw-timeline";
import type { ComponentProps } from "react";
import OpenEditor from "./editor/open-editor";
import StudioTimeline from "./studio-timeline";
import ProcessingStatus from "./processing-status";
import type { ProcessingState } from "@/lib/job-status";

const stamp = (seconds: number) => {
  const ms = Math.round(seconds * 1000);
  return `${String(Math.floor(ms / 60000)).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}`;
};
export default function StudioDaw({
  jobId,
  lineGap,
}: {
  jobId: string;
  lineGap: number;
}) {
  const [a, setA] = useState<Arrangement | null>(null),
    [legacy, setLegacy] = useState<
      Parameters<typeof StudioTimeline>[0]["report"] | null
    >(null),
    [error, setError] = useState(""),
    [saved, setSaved] = useState("Saved"),
    [revision, setRevision] = useState(1),
    [exportsCount, setExportsCount] = useState(0);
  const [selected, setSelected] = useState(""),
    [playhead, setPlayhead] = useState(0),
    [modal, setModal] = useState(false),
    [exportLive, setExportLive] = useState<ProcessingState | null>(null),
    [saveTick, setSaveTick] = useState(0);
  const [assets, setAssets] = useState<
      NonNullable<ComponentProps<typeof DawTimeline>["assets"]>
    >({}),
    [audioUrls, setAudioUrls] = useState<Record<string, string>>({}),
    [exportChoices, setExportChoices] = useState<
      Record<string, string | boolean>
    >({});
  const revisionRef = useRef(1),
    lastSaved = useRef(""),
    saving = useRef(false),
    conflict = useRef(false),
    current = useRef(a);
  current.current = a;
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch(`/api/studio/${jobId}/arrangement`, {
          cache: "no-store",
        });
        if (!r.ok) {
          const old = await fetch(`/api/jobs/${jobId}/alignment`);
          const report = alignmentReportSchema.safeParse(await old.json());
          if (report.success) {
            if (!cancelled) setLegacy(report.data);
            return;
          }
          throw Error(
            "Arrangement unavailable. Your report is still available in Downloads.",
          );
        }
        const data = await r.json();
        const parsed = arrangementSchema.parse(data.arrangement);
        if (cancelled) return;
        revisionRef.current = data.revision;
        lastSaved.current = JSON.stringify(parsed);
        setRevision(data.revision);
        setExportsCount(data.exports_count);
        setA(parsed);
        let index = 0;
        await Promise.all(
          Array.from({ length: Math.min(4, parsed.clips.length) }, async () => {
            while (index < parsed.clips.length) {
              const clip = parsed.clips[index++];
              try {
                const media = await fetch(
                  `/api/studio/${jobId}/media?clip=${clip.id}`,
                ).then((r) => r.json());
                if (!cancelled) {
                  setAssets((v) => ({
                    ...v,
                    [clip.id]: {
                      key: `${jobId}/${clip.id}`,
                      url: `/api/studio/${jobId}/media?clip=${clip.id}&kind=peaks`,
                    },
                  }));
                  setAudioUrls((v) => ({
                    ...v,
                    [clip.id]: `/api/studio/${jobId}/media?clip=${clip.id}&kind=stem`,
                  }));
                }
              } catch {
                if (!cancelled)
                  setError(
                    "Some waveforms could not load. Reopen the session to retry.",
                  );
              }
            }
          }),
        );
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [jobId]);
  useEffect(() => {
    if (!a || conflict.current || JSON.stringify(a) === lastSaved.current)
      return;
    setSaved("Saving…");
    const timer = setTimeout(async () => {
      if (saving.current) {
        setSaveTick((n) => n + 1);
        return;
      }
      saving.current = true;
      const snapshot = JSON.stringify(current.current);
      try {
        const r = await fetch(`/api/studio/${jobId}/arrangement`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            revision: revisionRef.current,
            arrangement: JSON.parse(snapshot),
          }),
        });
        if (r.status === 409) {
          conflict.current = true;
          throw Error(
            "This session changed elsewhere. Reload before editing or exporting.",
          );
        }
        if (!r.ok)
          throw Error(
            "Could not save. Your edits remain here; retry by making another edit.",
          );
        const result = await r.json();
        revisionRef.current = result.revision;
        setRevision(result.revision);
        lastSaved.current = snapshot;
        setSaved(
          JSON.stringify(current.current) === snapshot ? "Saved" : "Saving…",
        );
        setSaveTick((n) => n + 1);
      } catch (e) {
        setSaved("Not saved");
        setError((e as Error).message);
      } finally {
        saving.current = false;
      }
    }, 2000);
    return () => clearTimeout(timer);
  }, [a, jobId, saveTick]);
  useEffect(() => {
    if (!exportLive || !["done", "failed"].includes(exportLive.status)) return;
    let cancelled = false;
    void fetch(`/api/studio/${jobId}/arrangement`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data && !cancelled) setExportsCount(data.exports_count);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [exportLive?.status, jobId]);
  async function flushEditor() {
    const deadline = Date.now() + 15000;
    while (saving.current && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 25));
    if (saving.current || conflict.current)
      throw Error("Resolve the save conflict before opening Editor Studio.");
    saving.current = true;
    try {
      const snapshot = JSON.stringify(current.current);
      const r = await fetch(`/api/studio/${jobId}/arrangement`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          revision: revisionRef.current,
          arrangement: current.current,
        }),
      });
      if (!r.ok)
        throw Error(
          "Could not save the latest arrangement. Retry opening Editor Studio.",
        );
      const data = await r.json();
      revisionRef.current = data.revision;
      lastSaved.current = snapshot;
      setRevision(data.revision);
      setSaved("Saved");
    } finally {
      saving.current = false;
    }
  }
  function commit(next: Arrangement) {
    if (conflict.current) {
      setError("This session changed elsewhere. Reload before editing.");
      return;
    }
    setA(next);
  }
  function seek(value: number) {
    setPlayhead(Math.max(0, Math.min(a?.duration ?? 0, value)));
  }
  const value = (key: string) => String(exportChoices[key] ?? "");
  const ex = (key: string, v: string | boolean) =>
    setExportChoices((s) => ({ ...s, [key]: v }));
  const exportSettings = {
    revision,
    formats: ["mp3", "wav"].filter((f) => exportChoices[f] === true),
    ...(exportChoices.mp3
      ? {
          mp3: {
            bitrate_kbps: value("bitrate")
              ? Number(value("bitrate"))
              : undefined,
            sample_rate: value("mp3rate")
              ? Number(value("mp3rate"))
              : undefined,
          },
        }
      : {}),
    ...(exportChoices.wav
      ? {
          wav: {
            bit_depth:
              value("depth") === "32f"
                ? "32f"
                : value("depth")
                  ? Number(value("depth"))
                  : undefined,
            sample_rate: value("wavrate")
              ? Number(value("wavrate"))
              : undefined,
          },
        }
      : {}),
    subtitles:
      value("subs") === "none"
        ? []
        : value("subs") === "both"
          ? ["srt", "vtt"]
          : value("subs")
            ? [value("subs")]
            : undefined,
    missing_lines: value("missing") || undefined,
  };
  const validExport = exportSettingsSchema.safeParse(
    withDefaults("studio_export", exportSettings),
  );
  async function exportMix() {
    if (!a) return;
    if (!validExport.success) {
      setError("Check the export settings.");
      return;
    }
    if (saved !== "Saved" || conflict.current) {
      setError(
        "Wait for your edits to save, or resolve the displayed save conflict, before exporting.",
      );
      return;
    }
    setModal(false);
    setExportLive({
      fileName: "Studio export",
      status: "starting",
      error: null,
      durationSec: null,
      downloads: [],
    });
    try {
      const r = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "studio_export",
          parent_job_id: jobId,
          expected_cost: exportsCount === 0 ? 0 : Math.ceil(a.duration / 60),
          settings: validExport.data,
        }),
      });
      if (!r.ok) {
        const failure = await r.json();
        if (r.status === 409 && failure.reason === "price_changed")
          setExportsCount(failure.expected_cost > 0 ? 1 : 0);
        if (r.status === 409 && failure.reason === "revision_conflict") {
          conflict.current = true;
          setSaved("Not saved");
        }
        throw Error(failure.error || "Could not queue export");
      }
      const result = await r.json();
      setExportLive({
        fileName: "Studio export",
        id: result.id,
        status: "queued",
        error: null,
        durationSec: null,
        downloads: [],
      });
      setExportsCount((n) => n + 1);
    } catch (e) {
      setExportLive({
        fileName: "Studio export",
        status: "failed",
        error: (e as Error).message,
        durationSec: null,
        downloads: [],
      });
    }
  }
  if (legacy) return <StudioTimeline report={legacy} />;
  if (!a)
    return (
      <div className="card" role="status">
        {error || "Loading arrangement…"}
      </div>
    );
  return (
    <section className="card daw" aria-label="Audio Studio session">
      <div className="row">
        <h3>Script timeline</h3>
        <span role="status" aria-label="Autosave">
          {saved} · r{revision}
        </span>
        <button
          type="button"
          className="btn"
          disabled={
            !!(
              exportLive &&
              ["queued", "processing", "starting"].includes(exportLive.status)
            )
          }
          onClick={() => setModal(true)}
        >
          Export mix
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      <DawTimeline
        arrangement={a}
        onChange={commit}
        assets={assets}
        audioUrls={audioUrls}
        playhead={playhead}
        onSeek={setPlayhead}
      />
      <details open={a.unplaced.length > 0}>
        <summary>Unplaced clips ({a.unplaced.length})</summary>
        <div className="daw-unplaced">
          {a.unplaced.map((u, i) => (
            <div
              key={i}
              draggable
              className="daw-bin-item"
              onDragStart={(e) =>
                e.dataTransfer.setData("text/plain", String(i))
              }
            >
              <p>{u.transcript}</p>
              <label className="daw-edit">
                Place on lane
                <select
                  aria-label="Place on lane"
                  value=""
                  onChange={(e) => {
                    if (!e.target.value) return;
                    commit({
                      ...a,
                      regions: [
                        ...a.regions,
                        {
                          id: crypto.randomUUID(),
                          lane: e.target.value,
                          kind: "clip",
                          clip: u.clip,
                          src_start: u.src_start,
                          src_end: u.src_end,
                          start: playhead,
                          gain_db: 0,
                          line: 0,
                          confidence: 0,
                          lines: [],
                          fade_in: 0,
                          fade_out: 0,
                          fade_curve: "linear",
                          reverse: false,
                          inserts: [],
                          mute: false,
                        },
                      ],
                      unplaced: a.unplaced.filter((_, j) => i !== j),
                    });
                  }}
                >
                  <option value="">Select…</option>
                  {a.lanes.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          ))}
        </div>
      </details>
      <div className="table-scroll">
        <table>
          <caption>Match report</caption>
          <thead>
            <tr>
              <th>Line</th>
              <th>Clip / segment</th>
              <th>Confidence</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {a.lines.map((line) => {
              const regions = a.regions.filter((r) =>
                  r.lines.some((l) => l.line === line.index),
                ),
                missing = a.missing.find((m) => m.line === line.index),
                low = regions.some(
                  (r) =>
                    r.confidence <
                    { strict: 0.85, normal: 0.7, loose: 0.5 }[
                      a.match_strictness ?? "normal"
                    ],
                );
              return (
                <tr key={line.index}>
                  <td>
                    <button
                      className="btn ghost"
                      onClick={() => {
                        seek(regions[0]?.start ?? missing?.start ?? 0);
                        setSelected(regions[0]?.id ?? "");
                      }}
                    >
                      {line.speaker && `${line.speaker}: `}
                      {line.text}
                    </button>
                  </td>
                  <td>
                    {regions
                      .map(
                        (r) =>
                          `${a.clips.find((c) => c.id === r.clip)?.name} ${stamp(r.src_start)}–${stamp(r.src_end)}`,
                      )
                      .join(", ") || "—"}
                  </td>
                  <td>
                    {regions.length
                      ? Math.round(
                          Math.min(...regions.map((r) => r.confidence)) * 100,
                        ) + "%"
                      : "—"}
                  </td>
                  <td>
                    {!regions.length
                      ? "missing"
                      : low
                        ? "Low confidence"
                        : "matched"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {modal && (
        <div
          className="daw-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="export-title"
          onKeyDown={(e) => {
            if (e.key === "Escape") setModal(false);
            if (e.key === "Tab") {
              const nodes = Array.from(
                e.currentTarget.querySelectorAll<HTMLElement>(
                  "button:not(:disabled),input,select",
                ),
              );
              const i = nodes.indexOf(document.activeElement as HTMLElement);
              if (e.shiftKey && i === 0) {
                e.preventDefault();
                nodes.at(-1)?.focus();
              } else if (!e.shiftKey && i === nodes.length - 1) {
                e.preventDefault();
                nodes[0]?.focus();
              }
            }
          }}
        >
          <div className="card">
            <h3 id="export-title">Export your mix</h3>
            {error && <p role="alert">{error}</p>}
            <p>
              {exportsCount === 0
                ? "First export included."
                : `Re-export: ${Math.ceil(a.duration / 60)} processing minutes.`}
            </p>
            <p className="muted">
              Rendering happens on the server. Choose every format and encoding
              option.
            </p>
            {["mp3", "wav"].map((f) => (
              <label key={f}>
                <input
                  type="checkbox"
                  autoFocus={f === "mp3"}
                  checked={exportChoices[f] === true}
                  onChange={(e) => ex(f, e.target.checked)}
                />
                {f.toUpperCase()}
              </label>
            ))}
            {exportChoices.mp3 && (
              <>
                {exportSelect("MP3 bitrate (kbps)", "bitrate", [
                  "128",
                  "192",
                  "256",
                  "320",
                ])}
                {exportSelect("MP3 sample rate (Hz)", "mp3rate", [
                  "44100",
                  "48000",
                ])}
              </>
            )}
            {exportChoices.wav && (
              <>
                {exportSelect("WAV bit depth", "depth", ["16", "24", "32f"])}
                {exportSelect("WAV sample rate (Hz)", "wavrate", [
                  "44100",
                  "48000",
                  "96000",
                ])}
              </>
            )}
            {exportSelect("Export subtitles", "subs", [
              "none",
              "srt",
              "vtt",
              "both",
            ])}
            {exportSelect("Missing lines in subtitles", "missing", [
              "exclude",
              "mark",
            ])}
            <div className="row">
              <button
                className="btn"

                onClick={() => void exportMix()}
              >
                Confirm export
              </button>
              <button className="btn ghost" onClick={() => setModal(false)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
      <OpenEditor source="studio" jobId={jobId} flush={flushEditor} />
      {exportLive && (
        <ProcessingStatus
          state={exportLive}
          setState={setExportLive}
          type="studio_export"
        />
      )}
    </section>
  );
  function exportSelect(label: string, key: string, values: string[]) {
    return (
      <label>
        {label}
        <select
          aria-label={label}
          value={value(key)}
          onChange={(e) => ex(key, e.target.value)}
        >
          <option value="">
            Default (
            {
              (
                {
                  bitrate: "320 kbps",
                  mp3rate: "48000 Hz",
                  depth: "24 bit",
                  wavrate: "48000 Hz",
                  subs: "none",
                  missing: "exclude",
                } as Record<string, string>
              )[key]
            }
            )
          </option>
          {values.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      </label>
    );
  }
}
