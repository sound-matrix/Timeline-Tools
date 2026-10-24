"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  arrangementSchema,
  arrangementDuration,
  exportSettingsSchema,
  type Arrangement,
} from "@/lib/arrangement";
import { withDefaults } from "@/lib/defaults";
import { alignmentReportSchema } from "@/lib/audio-studio";
import { pcmWindow } from "@/lib/studio-preview";
import Peaks from "./waveform-peaks";
import StudioTimeline from "./studio-timeline";
import ProcessingStatus from "./processing-status";
import type { ProcessingState } from "@/lib/job-status";

type Region = Arrangement["regions"][number];
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
    [playing, setPlaying] = useState(false),
    [zoom, setZoom] = useState(50),
    [modal, setModal] = useState(false),
    [exportLive, setExportLive] = useState<ProcessingState | null>(null),
    [saveTick, setSaveTick] = useState(0);
  const [peaks, setPeaks] = useState<Record<string, number[][]>>({}),
    [exportChoices, setExportChoices] = useState<
      Record<string, string | boolean>
    >({});
  const revisionRef = useRef(1),
    lastSaved = useRef(""),
    saving = useRef(false),
    conflict = useRef(false),
    current = useRef(a),
    history = useRef<Arrangement[]>([]),
    future = useRef<Arrangement[]>([]),
    generation = useRef(0),
    context = useRef<AudioContext | null>(null),
    sources = useRef<AudioBufferSourceNode[]>([]),
    buffers = useRef(new Map<string, AudioBuffer>()),
    head = useRef(0);
  const scroll = useRef<HTMLDivElement>(null);
  const dragging = useRef<{
    id: string;
    mode: string;
    x: number;
    y: number;
    region: Region;
    before: Arrangement;
  } | null>(null);
  current.current = a;
  head.current = playhead;
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
                const raw = await fetch(media.peaks);
                if (!raw.ok) throw Error();
                const p = await raw.json();
                if (!Array.isArray(p.peaks) || p.peaks.length > 360001)
                  throw Error();
                if (!cancelled) setPeaks((v) => ({ ...v, [clip.id]: p.peaks }));
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
    const el = scroll.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        setZoom((z) =>
          Math.max(5, Math.min(300, z * (e.deltaY < 0 ? 1.1 : 0.9))),
        );
      }
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, [!!a]);
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
  const stop = useCallback(() => {
    generation.current++;
    sources.current.forEach((s) => {
      try {
        s.stop();
      } catch {}
    });
    sources.current = [];
    setPlaying(false);
  }, []);
  useEffect(
    () => () => {
      generation.current++;
      sources.current.forEach((s) => {
        try {
          s.stop();
        } catch {}
      });
      void context.current?.close();
    },
    [],
  );
  function commit(next: Arrangement) {
    if (!a || conflict.current) return;
    stop();
    history.current = [...history.current.slice(-49), a];
    future.current = [];
    next = {
      ...next,
      duration: Math.max(arrangementDuration(next), a.duration),
    };
    setA(next);
  }
  function undo() {
    if (!a || !history.current.length || conflict.current) return;
    stop();
    future.current.push(a);
    setA(history.current.pop()!);
  }
  function redo() {
    if (!a || !future.current.length || conflict.current) return;
    stop();
    history.current.push(a);
    setA(future.current.pop()!);
  }
  function seek(value: number) {
    stop();
    setPlayhead(Math.max(0, Math.min(a?.duration ?? 0, value)));
  }
  async function play() {
    if (!a) return;
    if (playing) {
      stop();
      return;
    }
    try {
      const ctx = context.current ?? new AudioContext();
      context.current = ctx;
      await ctx.resume();
      const start = head.current >= a.duration ? 0 : head.current;
      setPlayhead(start);
      const epoch = ++generation.current;
      const origin = ctx.currentTime - start;
      const scheduled = new Set<string>(),
        loading = new Set<string>();
      setPlaying(true);
      const schedule = async () => {
        if (epoch !== generation.current) return;
        const now = ctx.currentTime - origin;
        const solo = a.lanes.some((l) => l.solo);
        for (const r of a.regions) {
          const lane = a.lanes.find((l) => l.id === r.lane)!;
          const length = r.src_end - r.src_start;
          if (
            lane.mute ||
            (solo && !lane.solo) ||
            r.start + length <= now ||
            r.start > now + 5
          )
            continue;
          const first = Math.max(0, Math.floor((now - r.start) / 5));
          const last = Math.min(
            Math.ceil(length / 5) - 1,
            Math.floor((now + 5 - r.start) / 5),
          );
          for (let chunk = first; chunk <= last; chunk++) {
            const key = `${r.id}/${chunk}`;
            if (scheduled.has(key) || loading.has(key)) continue;
            loading.add(key);
            try {
              const offset = chunk * 5,
                span = Math.min(5, length - offset),
                cacheKey = `${r.clip}/${r.src_start + offset}/${span}`;
              let buffer = buffers.current.get(cacheKey);
              if (!buffer) {
                const response = await fetch(
                  `/api/studio/${jobId}/media?clip=${r.clip}`,
                );
                if (!response.ok) throw Error();
                const media = await response.json();
                buffer = await pcmWindow(
                  ctx,
                  media.stem,
                  r.src_start + offset,
                  span,
                );
                buffers.current.set(cacheKey, buffer);
                if (buffers.current.size > 8)
                  buffers.current.delete(buffers.current.keys().next().value!);
              }
              if (epoch !== generation.current) return;
              const at = r.start + offset,
                late = Math.max(0, ctx.currentTime - origin - at);
              if (late >= buffer.duration) {
                scheduled.add(key);
                continue;
              }
              const source = ctx.createBufferSource(),
                gain = ctx.createGain();
              source.buffer = buffer;
              gain.gain.value = 10 ** ((r.gain_db + lane.gain_db) / 20);
              source.connect(gain).connect(ctx.destination);
              source.onended = () => {
                source.disconnect();
                gain.disconnect();
                sources.current = sources.current.filter((s) => s !== source);
              };
              source.start(
                Math.max(ctx.currentTime, origin + at),
                late,
                buffer.duration - late,
              );
              sources.current.push(source);
              scheduled.add(key);
            } catch {
              setError("Preview audio could not load. Pause and retry.");
            } finally {
              loading.delete(key);
            }
          }
        }
      };
      void schedule();
      const tick = setInterval(() => {
        if (epoch !== generation.current) {
          clearInterval(tick);
          return;
        }
        const t = ctx.currentTime - origin;
        if (t >= a.duration) {
          clearInterval(tick);
          stop();
          setPlayhead(a.duration);
          return;
        }
        setPlayhead(t);
        void schedule();
      }, 100);
    } catch {
      setError(
        "Audio preview is unavailable in this browser. You can still edit and export.",
      );
      stop();
    }
  }
  function changeRegion(id: string, patch: Partial<Region>) {
    if (!a) return;
    commit({
      ...a,
      regions: a.regions.map((r) => (r.id === id ? { ...r, ...patch } : r)),
    });
  }
  function split() {
    if (!a) return;
    const r = a.regions.find((r) => r.id === selected);
    if (!r) return;
    const offset = playhead - r.start;
    if (offset <= 0.01 || offset >= r.src_end - r.src_start - 0.01) return;
    commit({
      ...a,
      regions: a.regions.flatMap((x) =>
        x.id !== r.id
          ? [x]
          : [
              { ...r, src_end: r.src_start + offset },
              {
                ...r,
                id: crypto.randomUUID(),
                start: playhead,
                src_start: r.src_start + offset,
              },
            ],
      ),
    });
  }
  function remove() {
    if (a && selected)
      commit({ ...a, regions: a.regions.filter((r) => r.id !== selected) });
  }
  function snap(time: number, id: string) {
    if (!a?.snap) return Math.max(0, time);
    const edges = a.regions
      .filter((r) => r.id !== id)
      .flatMap((r) => [
        r.start,
        r.start +
          r.src_end -
          r.src_start +
          (a.line_gap_ms !== undefined ? a.line_gap_ms / 1000 : lineGap),
      ]);
    const closest = edges.find((t) => Math.abs(t - time) < 8 / zoom);
    return Math.max(0, closest ?? time);
  }
  function pointerDown(e: React.PointerEvent, id: string, mode: string) {
    if (!a || matchMedia("(max-width:700px)").matches || conflict.current)
      return;
    e.stopPropagation();
    stop();
    const r = a.regions.find((r) => r.id === id)!;
    setSelected(id);
    e.currentTarget.setPointerCapture(e.pointerId);
    dragging.current = {
      id,
      mode,
      x: e.clientX,
      y: e.clientY,
      region: r,
      before: a,
    };
  }
  function pointerMove(e: React.PointerEvent) {
    const d = dragging.current;
    if (!d || !a) return;
    const delta = (e.clientX - d.x) / zoom;
    let patch: Partial<Region> = {};
    if (d.mode === "start") {
      const v = Math.max(
        0,
        Math.min(d.region.src_end - 0.02, d.region.src_start + delta),
      );
      patch = {
        src_start: v,
        start: Math.max(0, d.region.start + v - d.region.src_start),
      };
    } else if (d.mode === "end") {
      const duration = a.clips.find((c) => c.id === d.region.clip)!.duration;
      patch = {
        src_end: Math.min(
          duration,
          Math.max(d.region.src_start + 0.02, d.region.src_end + delta),
        ),
      };
    } else {
      const laneIndex = d.before.lanes.findIndex((l) => l.id === d.region.lane);
      const index = Math.max(
        0,
        Math.min(
          a.lanes.length - 1,
          laneIndex + Math.round((e.clientY - d.y) / 120),
        ),
      );
      patch = {
        start: snap(d.region.start + delta, d.id),
        lane: a.lanes[index].id,
      };
    }
    const next = {
      ...a,
      regions: a.regions.map((r) =>
        r.id === d.id ? { ...d.region, ...patch } : r,
      ),
    };
    setA({
      ...next,
      duration: Math.max(a.duration, arrangementDuration(next)),
    });
  }
  function pointerUp() {
    const d = dragging.current;
    if (!d) return;
    history.current.push(d.before);
    future.current = [];
    dragging.current = null;
  }
  const selectedRegion = a?.regions.find((r) => r.id === selected);
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
    if (!a || !validExport.success || saved !== "Saved" || conflict.current)
      return;
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
    <section
      className="card daw"
      aria-label="DAW timeline"
      tabIndex={0}
      onKeyDown={(e) => {
        if (
          (e.target as HTMLElement).matches("input,select,textarea,button") ||
          modal
        )
          return;
        const mobile = matchMedia("(max-width:700px)").matches;
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
          e.preventDefault();
          if (!mobile) e.shiftKey ? redo() : undo();
          return;
        }
        if (e.key === " ") {
          e.preventDefault();
          void play();
        } else if (e.key === "Home") {
          e.preventDefault();
          seek(0);
        } else if (e.key === "End") {
          e.preventDefault();
          seek(a.duration);
        } else if (e.key === "+" || e.key === "=") {
          e.preventDefault();
          setZoom((z) => Math.min(300, z * 1.3));
        } else if (e.key === "-") {
          e.preventDefault();
          setZoom((z) => Math.max(5, z / 1.3));
        } else if (
          !mobile &&
          ["ArrowLeft", "ArrowRight"].includes(e.key) &&
          selectedRegion
        ) {
          e.preventDefault();
          changeRegion(selected, {
            start: Math.max(
              0,
              selectedRegion.start +
                (e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 0.1 : 0.01),
            ),
          });
        } else if (!mobile && e.key.toLowerCase() === "s") {
          e.preventDefault();
          split();
        } else if (!mobile && (e.key === "Delete" || e.key === "Backspace")) {
          e.preventDefault();
          remove();
        }
      }}
    >
      <div className="row">
        <h3>Script timeline</h3>
        <span className="tag" role="status" aria-label="Autosave">
          {saved} · r{revision}
        </span>
        <span className="muted">Preview playback only</span>
      </div>
      {error && <p role="alert">{error}</p>}
      <div className="row daw-toolbar">
        <button className="btn" onClick={() => void play()}>
          {playing ? "Pause" : "Play"}
        </button>
        <output aria-label="Current time">{stamp(playhead)}</output>
        <button
          className="btn ghost"
          aria-label="Zoom in"
          onClick={() => setZoom((z) => Math.min(300, z * 1.3))}
        >
          +
        </button>
        <button
          className="btn ghost"
          aria-label="Zoom out"
          onClick={() => setZoom((z) => Math.max(5, z / 1.3))}
        >
          −
        </button>
        <button
          className="btn ghost daw-edit"
          onClick={undo}
          disabled={!history.current.length}
        >
          Undo
        </button>
        <button
          className="btn ghost daw-edit"
          onClick={redo}
          disabled={!future.current.length}
        >
          Redo
        </button>
        <button
          className="btn ghost daw-edit"
          onClick={split}
          disabled={!selected}
        >
          Split at playhead (S)
        </button>
        <button
          className="btn ghost daw-edit"
          onClick={remove}
          disabled={!selected}
        >
          Delete region
        </button>
        <label className="daw-edit">
          <input
            type="checkbox"
            checked={a.snap}
            onChange={(e) => commit({ ...a, snap: e.target.checked })}
          />
          Snap to gap
        </label>
        <button
          className="btn"
          disabled={
            saved !== "Saved" ||
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
      <p className="muted daw-mobile-note">
        Mobile: listen, seek and inspect. Editing is available on desktop.
      </p>
      <div className="studio-workspace">
        <div className="daw-scroll" ref={scroll}>
          <div
            className="daw-surface"
            style={{ width: 180 + a.duration * zoom }}
          >
            <div
              className="daw-ruler"
              aria-label="Time ruler"
              role="slider"
              tabIndex={0}
              aria-valuenow={playhead}
              aria-valuemin={0}
              aria-valuemax={a.duration}
              onKeyDown={(e) => {
                if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                  e.preventDefault();
                  e.stopPropagation();
                  seek(playhead + (e.key === "ArrowLeft" ? -1 : 1));
                }
              }}
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId);
                seek(
                  (e.clientX - e.currentTarget.getBoundingClientRect().left) /
                    zoom,
                );
              }}
              onPointerMove={(e) => {
                if (e.buttons)
                  seek(
                    (e.clientX - e.currentTarget.getBoundingClientRect().left) /
                      zoom,
                  );
              }}
            >
              {Array.from(
                {
                  length: Math.min(
                    200,
                    Math.ceil(a.duration / (zoom < 15 ? 60 : 5)),
                  ),
                },
                (_, i) => (
                  <span
                    key={i}
                    style={{ left: i * (zoom < 15 ? 60 : 5) * zoom }}
                  >
                    {stamp(i * (zoom < 15 ? 60 : 5))}
                  </span>
                ),
              )}
            </div>
            {a.lanes.map((l) => (
              <div
                className="daw-lane"
                data-lane={l.id}
                key={l.id}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  const i = Number(e.dataTransfer.getData("text/plain"));
                  const u = a.unplaced[i];
                  if (!u || matchMedia("(max-width:700px)").matches) return;
                  commit({
                    ...a,
                    regions: [
                      ...a.regions,
                      {
                        id: crypto.randomUUID(),
                        lane: l.id,
                        kind: "clip",
                        clip: u.clip,
                        src_start: u.src_start,
                        src_end: u.src_end,
                        start: Math.max(
                          0,
                          (e.clientX -
                            e.currentTarget.getBoundingClientRect().left -
                            180) /
                            zoom,
                        ),
                        gain_db: 0,
                        line: 0,
                        confidence: 0,
                      },
                    ],
                    unplaced: a.unplaced.filter((_, j) => j !== i),
                  });
                }}
              >
                <div
                  className="daw-lane-controls"
                  style={{ borderLeft: `3px solid ${l.color}` }}
                >
                  <b>{l.name}</b>
                  <div className="daw-edit">
                    <label>
                      <input
                        type="checkbox"
                        aria-label={`Mute ${l.name}`}
                        checked={l.mute}
                        onChange={(e) =>
                          commit({
                            ...a,
                            lanes: a.lanes.map((x) =>
                              x.id === l.id
                                ? { ...x, mute: e.target.checked }
                                : x,
                            ),
                          })
                        }
                      />
                      Mute
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        aria-label={`Solo ${l.name}`}
                        checked={l.solo}
                        onChange={(e) =>
                          commit({
                            ...a,
                            lanes: a.lanes.map((x) =>
                              x.id === l.id
                                ? { ...x, solo: e.target.checked }
                                : x,
                            ),
                          })
                        }
                      />
                      Solo
                    </label>
                    <label>
                      Gain
                      <input
                        type="number"
                        min={-60}
                        max={24}
                        aria-label={`Gain ${l.name}`}
                        value={l.gain_db}
                        onChange={(e) => {
                          if (e.target.value.trim())
                            commit({
                              ...a,
                              lanes: a.lanes.map((x) =>
                                x.id === l.id
                                  ? {
                                      ...x,
                                      gain_db: Math.min(
                                        24,
                                        Math.max(-60, Number(e.target.value)),
                                      ),
                                    }
                                  : x,
                              ),
                            });
                        }}
                      />
                    </label>
                  </div>
                </div>
                <div
                  className="daw-lane-track"
                  onPointerDown={(e) => {
                    if (e.target === e.currentTarget)
                      seek(
                        (e.clientX -
                          e.currentTarget.getBoundingClientRect().left) /
                          zoom,
                      );
                  }}
                >
                  {a.regions
                    .filter((r) => r.lane === l.id)
                    .map((r) => (
                      <div
                        key={r.id}
                        role="button"
                        tabIndex={0}
                        aria-label={`Region ${a.lines[r.line]?.text ?? r.id}`}
                        aria-pressed={selected === r.id}
                        className={
                          "daw-region" + (selected === r.id ? " selected" : "")
                        }
                        style={{
                          left: r.start * zoom,
                          width: Math.max(4, (r.src_end - r.src_start) * zoom),
                          borderColor: l.color,
                        }}
                        onFocus={() => setSelected(r.id)}
                        onClick={() => setSelected(r.id)}
                        onPointerDown={(e) => pointerDown(e, r.id, "move")}
                        onPointerMove={pointerMove}
                        onPointerUp={pointerUp}
                        onPointerCancel={pointerUp}
                      >
                        <span
                          className="daw-trim start daw-edit"
                          role="button"
                          tabIndex={0}
                          aria-label={`Trim start ${r.id}`}
                          onPointerDown={(e) => pointerDown(e, r.id, "start")}
                          onKeyDown={(e) => {
                            if (
                              e.key === "ArrowRight" ||
                              e.key === "ArrowLeft"
                            ) {
                              e.stopPropagation();
                              e.preventDefault();
                              const v = Math.max(
                                0,
                                Math.min(
                                  r.src_end - 0.02,
                                  r.src_start +
                                    (e.key === "ArrowRight" ? 0.01 : -0.01),
                                ),
                              );
                              changeRegion(r.id, {
                                src_start: v,
                                start: Math.max(0, r.start + v - r.src_start),
                              });
                            }
                          }}
                        />
                        {peaks[r.clip] ? (
                          <Peaks
                            values={peaks[r.clip]}
                            start={r.src_start}
                            end={r.src_end}
                            color={l.color}
                            zoom={zoom}
                          />
                        ) : (
                          <span className="muted">Loading waveform…</span>
                        )}
                        <small>{a.lines[r.line]?.text}</small>
                        <span
                          className="daw-trim end daw-edit"
                          role="button"
                          tabIndex={0}
                          aria-label={`Trim end ${r.id}`}
                          onPointerDown={(e) => pointerDown(e, r.id, "end")}
                          onKeyDown={(e) => {
                            if (
                              e.key === "ArrowRight" ||
                              e.key === "ArrowLeft"
                            ) {
                              e.stopPropagation();
                              e.preventDefault();
                              changeRegion(r.id, {
                                src_end: Math.max(
                                  r.src_start + 0.02,
                                  Math.min(
                                    a.clips.find((c) => c.id === r.clip)!
                                      .duration,
                                    r.src_end +
                                      (e.key === "ArrowRight" ? 0.01 : -0.01),
                                  ),
                                ),
                              });
                            }
                          }}
                        />
                      </div>
                    ))}
                  {a.missing
                    .filter((m) => m.lane === l.id)
                    .map((m) => (
                      <div
                        key={m.line}
                        className="daw-missing"
                        style={{ left: m.start * zoom, width: m.length * zoom }}
                      >
                        Missing line: {m.text}
                      </div>
                    ))}
                </div>
              </div>
            ))}
            <div
              className="daw-playhead"
              style={{ left: 180 + playhead * zoom }}
              role="slider"
              tabIndex={0}
              aria-label="Playhead"
              aria-valuenow={playhead}
              aria-valuemin={0}
              aria-valuemax={a.duration}
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId);
                stop();
              }}
              onPointerMove={(e) => {
                if (e.buttons)
                  seek(
                    (e.clientX -
                      e.currentTarget.parentElement!.getBoundingClientRect()
                        .left -
                      180) /
                      zoom,
                  );
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                  e.stopPropagation();
                  e.preventDefault();
                  seek(playhead + (e.key === "ArrowLeft" ? -0.1 : 0.1));
                }
              }}
            />
          </div>
        </div>
        {selectedRegion && (
          <label className="daw-edit">
            Region gain (dB)
            <input
              type="number"
              min={-60}
              max={24}
              value={selectedRegion.gain_db}
              onChange={(e) => {
                if (e.target.value.trim())
                  changeRegion(selected, {
                    gain_db: Math.min(
                      24,
                      Math.max(-60, Number(e.target.value)),
                    ),
                  });
              }}
            />
          </label>
        )}
        <aside className="card daw-transcript" aria-label="Session transcript">
          <h3>Transcript</h3>
          <p className="muted">Read-only · select a line to seek.</p>
          {a.lines.map((line) => {
            const region = a.regions.find((r) => r.line === line.index);
            return (
              <button
                type="button"
                className="btn ghost"
                key={line.index}
                aria-current={
                  region &&
                  playhead >= region.start &&
                  playhead < region.start + region.src_end - region.src_start
                    ? "true"
                    : undefined
                }
                onClick={() => {
                  seek(region?.start ?? 0);
                  setSelected(region?.id ?? "");
                }}
              >
                {line.speaker ? `${line.speaker}: ` : ""}
                {line.text}
              </button>
            );
          })}
        </aside>
      </div>
      <details open={a.unplaced.length > 0}>
        <summary>Unplaced segments ({a.unplaced.length})</summary>
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
              const regions = a.regions.filter((r) => r.line === line.index),
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
                disabled={!validExport.success || saved !== "Saved"}
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
          <option value="">Select…</option>
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
