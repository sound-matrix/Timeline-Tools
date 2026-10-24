"use client";
import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import {
  transcriptSchema,
  editsSchema,
  cutRanges,
  editedDuration,
  remapTime,
  type PodcastTranscript,
  type PodcastEdits,
} from "@/lib/podcast";
import { podcastExportSchema } from "@/lib/settings";
import { withDefaults } from "@/lib/defaults";
import ProcessingStatus from "./processing-status";
import type { ProcessingState } from "@/lib/job-status";
import Peaks from "./waveform-peaks";
type Media = {
  index: number;
  name: string;
  offset: number;
  duration: number;
  proxy: string | null;
};
type Session = {
  transcript: PodcastTranscript;
  edits: PodcastEdits;
  duration: number;
  revision: number;
  exports_count: number;
  media: Media[];
  audio: string;
  peaks: string;
};
const stamp = (n: number) =>
  `${Math.floor(n / 60)}:${(n % 60).toFixed(2).padStart(5, "0")}`;
export default function PodcastEditor({ jobId }: { jobId: string }) {
  const [visible, setVisible] = useState({ start: 0, end: 60 });
  const [session, setSession] = useState<Session | null>(null),
    [edits, setEdits] = useState<PodcastEdits>({
      operations: [],
      corrections: {},
      speaker_names: {},
    }),
    [message, setMessage] = useState(""),
    [saved, setSaved] = useState("Loading"),
    [selected, setSelected] = useState<number[]>([]),
    [playhead, setPlayhead] = useState(0),
    [playing, setPlaying] = useState(false),
    [peaks, setPeaks] = useState<number[][]>([]),
    [zoom, setZoom] = useState(30),
    [page, setPage] = useState(0),
    [rangeStart, setRangeStart] = useState(""),
    [rangeEnd, setRangeEnd] = useState(""),
    [gap, setGap] = useState(""),
    [bleepDb, setBleepDb] = useState(""),
    [historySize, setHistorySize] = useState(0),
    [futureSize, setFutureSize] = useState(0),
    [choices, setChoices] = useState<Record<string, string | boolean>>({}),
    [exportsCount, setExportsCount] = useState(0),
    [exportBusy, setExportBusy] = useState(false),
    [exportLive, setExportLive] = useState<ProcessingState | null>(null);
  const audio = useRef<HTMLAudioElement>(null),
    video = useRef<HTMLVideoElement>(null),
    ruler = useRef<HTMLDivElement>(null),
    scroller = useRef<HTMLDivElement>(null),
    revision = useRef(1),
    lastSaved = useRef(""),
    current = useRef(edits),
    history = useRef<PodcastEdits[]>([]),
    future = useRef<PodcastEdits[]>([]),
    saving = useRef(false),
    conflict = useRef(false),
    playingRef = useRef(false),
    playheadRef = useRef(0),
    gapsPlayed = useRef(new Set<number>()),
    waiting = useRef(0),
    context = useRef<AudioContext | null>(null),
    tone = useRef<GainNode | null>(null),
    anchor = useRef<number | null>(null);
  current.current = edits;
  playheadRef.current = playhead;
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const response = await fetch(`/api/podcast/${jobId}`, {
          cache: "no-store",
        });
        if (!response.ok) throw Error("Podcast unavailable");
        const data = await response.json();
        const t = transcriptSchema.parse(data.transcript),
          e = editsSchema.parse(data.edits);
        if (cancelled) return;
        revision.current = data.revision;
        lastSaved.current = JSON.stringify(e);
        setSession({ ...data, duration: Number(data.duration), transcript: t });
        setEdits(e);
        setExportsCount(data.exports_count);
        setSaved("Saved");
        const p = await fetch(data.peaks);
        if (p.ok) {
          const values = await p.json();
          if (!cancelled && Array.isArray(values.peaks)) setPeaks(values.peaks);
        }
      } catch (e) {
        if (!cancelled) setMessage((e as Error).message);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [jobId]);
  // Serialize saves; a late reply never marks newer edits Saved. Revision conflicts
  // stop saving/export instead of overwriting another browser's work.
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    async function save() {
      if (conflict.current || saving.current) return;
      const snapshot = JSON.stringify(current.current);
      if (snapshot === lastSaved.current) return;
      saving.current = true;
      setSaved("Saving…");
      try {
        const response = await fetch(`/api/podcast/${jobId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            revision: revision.current,
            edits: JSON.parse(snapshot),
          }),
        });
        const data = await response.json();
        if (!response.ok) {
          if (response.status === 409) conflict.current = true;
          throw Error(data.error ?? "Could not save");
        }
        revision.current = data.revision;
        lastSaved.current = snapshot;
        if (!cancelled)
          setSaved(
            JSON.stringify(current.current) === snapshot ? "Saved" : "Unsaved",
          );
      } catch (e) {
        if (!cancelled) {
          setSaved("Not saved");
          setMessage((e as Error).message);
        }
      } finally {
        saving.current = false;
      }
    }
    const timer = setInterval(() => void save(), 800);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [jobId, session]);
  useEffect(() => {
    if (!playingRef.current && session && video.current) {
      const m = session.media.find(
        (m) =>
          m.proxy && playhead >= m.offset && playhead < m.offset + m.duration,
      );
      if (m) {
        try {
          video.current.currentTime = playhead - m.offset;
        } catch {}
        video.current.pause();
      }
    }
  }, [playhead, session]);
  const seek = useCallback(
    (seconds: number) => {
      if (!session) return;
      const t = Math.max(0, Math.min(session.duration, seconds));
      if (audio.current) audio.current.currentTime = t;
      setPlayhead(t);
      gapsPlayed.current.clear();
      waiting.current = 0;
      if (playingRef.current) void audio.current?.play().catch(() => {});
    },
    [session],
  );
  useEffect(() => {
    if (!session) return;
    let frame = 0,
      previous = 0,
      lastDraw = 0;
    function tick() {
      const a = audio.current;
      if (a && playingRef.current) {
        let t = a.currentTime;
        const now = performance.now();
        if (waiting.current) {
          if (now >= waiting.current) {
            waiting.current = 0;
            if (a.currentTime < session!.duration - 0.005)
              void a
                .play()
                .catch(() => setMessage("Press play to resume audio."));
          }
        } else {
          const removed = cutRanges(current.current);
          const cut = removed.find(([s, e]) => t >= s && t < e);
          if (cut) {
            t = cut[1];
            a.currentTime = t;
          }
          const insert = current.current.operations.find(
            (o, i) =>
              o.op === "insert" &&
              !removed.some(([a, b]) => o.at > a && o.at < b) &&
              !gapsPlayed.current.has(i) &&
              o.at >= previous - 0.02 &&
              o.at <= t + 0.02,
          );
          if (insert && insert.op === "insert") {
            const index = current.current.operations.indexOf(insert);
            gapsPlayed.current.add(index);
            a.currentTime = insert.at;
            t = insert.at;
            a.pause();
            waiting.current = now + insert.duration * 1000;
          }
        }
        const active = current.current.operations.filter(
          (o) =>
            o.op !== "insert" && o.op !== "delete" && t >= o.start && t < o.end,
        );
        const bleep = active.at(-1);
        a.volume = waiting.current || active.length ? 0 : 1;
        if (tone.current)
          tone.current.gain.value =
            bleep && bleep.op === "bleep" && !waiting.current
              ? 10 ** (bleep.db / 20)
              : 0;
        if (now - lastDraw > 60) {
          setPlayhead(t);
          lastDraw = now;
        }
        previous = t;
        const v = video.current;
        if (v) {
          const m = session!.media.find(
            (m) => m.proxy && t >= m.offset && t < m.offset + m.duration,
          );
          if (m) {
            const local = t - m.offset;
            if (Math.abs(v.currentTime - local) > 0.15) v.currentTime = local;
            if (waiting.current) v.pause();
            else if (v.paused) void v.play().catch(() => {});
          } else v.pause();
        }
        if (t >= session!.duration - 0.005 && !waiting.current) {
          playingRef.current = false;
          setPlaying(false);
          a.pause();
          video.current?.pause();
          if (tone.current) tone.current.gain.value = 0;
        }
      }
      frame = requestAnimationFrame(tick);
    }
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [session]);
  useEffect(
    () => () => {
      playingRef.current = false;
      void context.current?.close();
    },
    [],
  );
  function toggle() {
    if (!audio.current) return;
    if (playingRef.current) {
      audio.current.pause();
      video.current?.pause();
      if (tone.current) tone.current.gain.value = 0;
      playingRef.current = false;
      setPlaying(false);
      return;
    }
    if (playhead >= (session?.duration ?? 0) - 0.01) seek(0);
    if (!context.current) {
      try {
        const ctx = new AudioContext();
        context.current = ctx;
        const osc = ctx.createOscillator(),
          gain = ctx.createGain();
        osc.frequency.value = 1000;
        gain.gain.value = 0;
        osc.connect(gain).connect(ctx.destination);
        osc.start();
        tone.current = gain;
      } catch {
        setMessage(
          "Bleep preview is unavailable in this browser; audio export still applies bleeps.",
        );
      }
    }
    void context.current?.resume();
    playingRef.current = true;
    setPlaying(true);
    void audio.current.play().catch(() => {
      playingRef.current = false;
      setPlaying(false);
      setMessage("Could not play audio. Reload the session and try again.");
    });
  }
  function commit(next: PodcastEdits) {
    history.current.push(structuredClone(current.current));
    if (history.current.length > 100) history.current.shift();
    future.current = [];
    setHistorySize(history.current.length);
    setFutureSize(0);
    setEdits(next);
    setSaved("Unsaved");
  }
  function undo() {
    const prev = history.current.pop();
    if (!prev) return;
    future.current.push(structuredClone(current.current));
    setEdits(prev);
    setHistorySize(history.current.length);
    setFutureSize(future.current.length);
    setSaved("Unsaved");
  }
  function redo() {
    const next = future.current.pop();
    if (!next) return;
    history.current.push(structuredClone(current.current));
    setEdits(next);
    setHistorySize(history.current.length);
    setFutureSize(future.current.length);
    setSaved("Unsaved");
  }
  function select(index: number, extend: boolean) {
    let next: number[];
    if (extend && anchor.current !== null) {
      const lo = Math.min(anchor.current, index),
        hi = Math.max(anchor.current, index);
      next = Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
    } else {
      next = selected.includes(index)
        ? selected.filter((i) => i !== index)
        : [...selected, index];
      anchor.current = index;
    }
    setSelected(next);
    const word = session!.transcript.words[index];
    seek(word.start);
    setPage(Math.floor(index / 200));
  }
  const chosen = useMemo(
    () =>
      session
        ? selected.map((i) => session.transcript.words[i]).filter(Boolean)
        : [],
    [selected, session],
  );
  function add(op: "mute" | "delete" | "bleep" | "insert", explicit = false) {
    if (!session) return;
    setMessage("");
    let operation: PodcastEdits["operations"][number];
    if (op === "insert") {
      const amount = gap.trim() ? Number(gap) : 0.3;
      if (!Number.isFinite(amount) || amount <= 0 || amount > 60) {
        setMessage("Gap must be greater than 0 and at most 60 seconds.");
        return;
      }
      operation = { op, at: playhead, duration: amount };
    } else {
      const start = explicit
          ? Number(rangeStart)
          : Math.min(...chosen.map((w) => w.start)),
        end = explicit
          ? Number(rangeEnd)
          : Math.max(...chosen.map((w) => w.end));
      if (
        (explicit && (!rangeStart.trim() || !rangeEnd.trim())) ||
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        start < 0 ||
        end <= start ||
        end > session.duration
      ) {
        setMessage("Select words or enter a valid start and end range.");
        return;
      }
      if (op === "bleep") {
        const db = bleepDb.trim() ? Number(bleepDb) : -12;
        if (!Number.isFinite(db) || db < -60 || db > 0) {
          setMessage("Bleep level must be −60 to 0 dB.");
          return;
        }
        operation = { op, start, end, db };
      } else operation = { op, start, end };
    }
    let additions: PodcastEdits["operations"] = [operation];
    if (!explicit && operation.op !== "insert") {
      const groups: number[][] = [];
      for (const i of [...selected].sort((a, b) => a - b)) {
        const last = groups.at(-1);
        if (last && i === last.at(-1)! + 1) last.push(i);
        else groups.push([i]);
      }
      const template = operation;
      additions = groups.map((g) => ({
        ...template,
        start: session.transcript.words[g[0]].start,
        end: session.transcript.words[g.at(-1)!].end,
      }));
    }
    const next = { ...edits, operations: [...edits.operations, ...additions] };
    if (next.operations.length > 2000) {
      setMessage("Use at most 2000 edit operations per session.");
      return;
    }
    if (
      editedDuration(session.duration, next) <= 0 ||
      editedDuration(session.duration, next) > 14400
    ) {
      setMessage("Edits must leave between 0 and 4 hours of audio.");
      return;
    }
    commit(next);
  }
  const value = (key: string) => String(choices[key] ?? "");
  const set = (key: string, v: string | boolean) =>
    setChoices((s) => ({ ...s, [key]: v }));
  const exportSettings = withDefaults("podcast_export", {
    revision: revision.current,
    formats: ["mp3", "wav"].filter((f) => choices[f] === true),
    ...(choices.mp3
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
    ...(choices.wav
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
      choices.srt || choices.vtt
        ? ["srt", "vtt"].filter((f) => choices[f] === true)
        : [],
    speaker_labels: choices.labels === true,
  });
  const parsedExport = podcastExportSchema.safeParse(exportSettings);
  async function exportAudio() {
    if (!session || exportBusy) return;
    setMessage("");
    if (saved !== "Saved" || conflict.current) {
      setMessage("Save your edits before exporting.");
      return;
    }
    if (!parsedExport.success) {
      setMessage(
        parsedExport.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; "),
      );
      return;
    }
    setExportBusy(true);
    try {
      const cost = exportsCount
        ? Math.ceil(editedDuration(session.duration, edits) / 60)
        : 0;
      const response = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "podcast_export",
          parent_job_id: jobId,
          expected_cost: cost,
          settings: { ...parsedExport.data, revision: revision.current },
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        if (response.status === 409) conflict.current = true;
        throw Error(data.error ?? "Could not export");
      }
      setExportLive({
        id: data.id,
        fileName: "Podcast export",
        status: "queued",
        error: null,
        downloads: [],
        durationSec: null,
      });
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setExportBusy(false);
    }
  }
  const wasDone = useRef("");
  useEffect(() => {
    if (
      exportLive?.status === "done" &&
      exportLive.id &&
      wasDone.current !== exportLive.id
    ) {
      wasDone.current = exportLive.id;
      setExportsCount((n) => n + 1);
    }
  }, [exportLive]);
  const visibleWords = useMemo(
    () =>
      session?.transcript.words.flatMap((w, i) =>
        w.end >= visible.start && w.start <= visible.end ? [{ w, i }] : [],
      ) ?? [],
    [session, visible],
  );
  useEffect(() => {
    const el = scroller.current;
    if (el)
      setVisible({
        start: el.scrollLeft / zoom,
        end: (el.scrollLeft + el.clientWidth) / zoom,
      });
  }, [zoom, session]);
  if (!session)
    return (
      <div role="status" className="card">
        {message || "Loading Podcast editor…"}
      </div>
    );
  const t = session.transcript,
    cuts = cutRanges(edits),
    length = editedDuration(session.duration, edits);
  const activeVideo = session.media.find(
    (m) => m.proxy && playhead >= m.offset && playhead < m.offset + m.duration,
  );
  const pageWords = t.words.slice(page * 200, (page + 1) * 200);
  const dropdown = (
    label: string,
    key: string,
    options: (string | number)[],
    fallback: string,
  ) => (
    <label>
      {label}
      <select value={value(key)} onChange={(e) => set(key, e.target.value)}>
        <option value="">Select… Default ({fallback})</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <section
      className="card podcast-editor"
      aria-label="Podcast editor"
      onKeyDown={(e) => {
        if ((e.target as HTMLElement).matches("input,textarea,select")) return;
        if (e.code === "Space") {
          e.preventDefault();
          toggle();
        }
        if ((e.ctrlKey || e.metaKey) && e.key === "z") {
          e.preventDefault();
          e.shiftKey ? redo() : undo();
        }
      }}
      tabIndex={0}
    >
      <div className="daw-transport">
        <h3>Podcast desk</h3>
        <button type="button" className="btn" onClick={toggle}>
          {playing ? "Pause" : "Play"}
        </button>
        <output aria-label="Podcast current time">
          {stamp(remapTime(playhead, edits))} / {stamp(length)}
        </output>
        <button
          type="button"
          className="btn ghost"
          onClick={undo}
          disabled={!historySize}
        >
          Undo
        </button>
        <button
          type="button"
          className="btn ghost"
          onClick={redo}
          disabled={!futureSize}
        >
          Redo
        </button>
        <span role="status" aria-label="Podcast save status">
          {saved}
        </span>
      </div>
      <audio
        ref={audio}
        src={session.audio}
        preload="metadata"
        onEnded={() => {
          const hasTail = current.current.operations.some(
            (o, i) =>
              o.op === "insert" &&
              o.at >= session.duration - 0.01 &&
              !gapsPlayed.current.has(i),
          );
          if (hasTail) return;
          playingRef.current = false;
          setPlaying(false);
          video.current?.pause();
          if (tone.current) tone.current.gain.value = 0;
        }}
        onError={() =>
          setMessage(
            "Audio preview unavailable. Reload to renew the private media link.",
          )
        }
      />
      {message && <p role="alert">{message}</p>}
      <div className="studio-workspace">
        <div className="podcast-workspace-main">
          {activeVideo ? (
            <video
              ref={video}
              key={activeVideo.index}
              src={activeVideo.proxy!}
              muted
              playsInline
              preload="metadata"
              aria-label="Podcast video preview"
              className="podcast-video"
            />
          ) : (
            <div className="card muted">
              {session.media.some((m) => m.proxy)
                ? "No video in this part of the session."
                : "Audio session · waveform preview"}
            </div>
          )}
          <label>
            Timeline zoom
            <input
              type="range"
              min={2}
              max={100}
              value={zoom}
              onChange={(e) => setZoom(Number(e.target.value))}
            />
          </label>
          <div
            className="daw-scroll"
            ref={scroller}
            onScroll={(e) => {
              const el = e.currentTarget;
              setVisible({
                start: el.scrollLeft / zoom,
                end: (el.scrollLeft + el.clientWidth) / zoom,
              });
            }}
          >
            <div
              className="podcast-timeline"
              style={{ width: Math.max(600, session.duration * zoom) }}
            >
              <div
                className="daw-ruler"
                ref={ruler}
                role="slider"
                aria-label="Podcast time ruler"
                aria-valuemin={0}
                aria-valuemax={session.duration}
                aria-valuenow={playhead}
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                    e.preventDefault();
                    seek(playhead + (e.key === "ArrowRight" ? 0.1 : -0.1));
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
                      (e.clientX -
                        e.currentTarget.getBoundingClientRect().left) /
                        zoom,
                    );
                }}
              >
                {Array.from(
                  { length: Math.ceil(session.duration / 30) },
                  (_, i) => (
                    <span
                      key={i}
                      style={{ position: "absolute", left: i * 30 * zoom }}
                    >
                      {stamp(i * 30)}
                    </span>
                  ),
                )}
              </div>
              {t.speakers.map((s) => (
                <div
                  className="podcast-lane"
                  key={s.id}
                  aria-label={`Speaker lane ${edits.speaker_names[s.id] ?? s.name}`}
                >
                  <b className="podcast-lane-label">
                    {edits.speaker_names[s.id] ?? s.name}
                  </b>
                  <div className="podcast-wave">
                    <Peaks
                      values={peaks}
                      start={0}
                      end={session.duration}
                      color="#818CF8"
                      zoom={zoom}
                    />
                  </div>
                  {visibleWords.map(({ w, i }) =>
                    w.speaker === s.id ? (
                      <button
                        type="button"
                        key={i}
                        className={`podcast-word${selected.includes(i) ? " selected" : ""}${cuts.some(([a, b]) => w.start < b && w.end > a) ? " cut" : ""}`}
                        style={{
                          left: w.start * zoom,
                          width: Math.max(4, (w.end - w.start) * zoom),
                        }}
                        aria-pressed={selected.includes(i)}
                        aria-label={`Timeline word ${i + 1}: ${edits.corrections[String(i)] ?? w.w}`}
                        onClick={(e) => select(i, e.shiftKey)}
                      >
                        {edits.corrections[String(i)] ?? w.w}
                      </button>
                    ) : null,
                  )}
                </div>
              ))}
              <div
                className="podcast-playhead"
                role="slider"
                tabIndex={0}
                aria-label="Podcast playhead"
                aria-valuemin={0}
                aria-valuemax={session.duration}
                aria-valuenow={playhead}
                style={{ left: playhead * zoom }}
                onKeyDown={(e) => {
                  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                    e.preventDefault();
                    seek(playhead + (e.key === "ArrowRight" ? 0.1 : -0.1));
                  }
                }}
                onPointerDown={(e) =>
                  e.currentTarget.setPointerCapture(e.pointerId)
                }
                onPointerMove={(e) => {
                  if (e.buttons && ruler.current)
                    seek(
                      (e.clientX - ruler.current.getBoundingClientRect().left) /
                        zoom,
                    );
                }}
              />
            </div>
          </div>
        </div>
        <aside
          className="card podcast-transcript"
          aria-label="Editable Podcast transcript"
        >
          <h3>Transcript</h3>
          <p className="muted">
            Select words in either panel; Shift selects a range. Edit spelling
            in the fields. Speaker method: {t.method}.
          </p>
          {pageWords.map((w, j) => {
            const i = page * 200 + j;
            return (
              <span
                key={i}
                className={`podcast-text-word${selected.includes(i) ? " selected" : ""}`}
              >
                <button
                  type="button"
                  className="btn ghost sm"
                  aria-pressed={selected.includes(i)}
                  onClick={(e) => select(i, e.shiftKey)}
                  aria-label={`Select transcript word ${i + 1}`}
                >
                  {edits.speaker_names[w.speaker] ??
                    t.speakers.find((s) => s.id === w.speaker)?.name}{" "}
                  · {stamp(w.start)}
                </button>
                <input
                  aria-label={`Transcript word ${i + 1}`}
                  value={edits.corrections[String(i)] ?? w.w}
                  maxLength={300}
                  onChange={(e) => {
                    if (e.target.value.trim())
                      commit({
                        ...edits,
                        corrections: {
                          ...edits.corrections,
                          [i]: e.target.value,
                        },
                      });
                  }}
                />
              </span>
            );
          })}
          <div className="row">
            <button
              className="btn ghost"
              type="button"
              disabled={!page}
              onClick={() => setPage((p) => p - 1)}
            >
              Previous words
            </button>
            <span>
              {page + 1}/{Math.ceil(t.words.length / 200)}
            </span>
            <button
              className="btn ghost"
              type="button"
              disabled={(page + 1) * 200 >= t.words.length}
              onClick={() => setPage((p) => p + 1)}
            >
              Next words
            </button>
          </div>
        </aside>
      </div>
      <section className="card">
        <h3>Edit selection ({selected.length} words)</h3>
        <div className="row">
          <button
            type="button"
            className="btn ghost"
            onClick={() => add("mute")}
          >
            Mute words
          </button>
          <button
            type="button"
            className="btn ghost"
            onClick={() => add("delete")}
          >
            Delete words · ripple
          </button>
          <button
            type="button"
            className="btn ghost"
            onClick={() => add("bleep")}
          >
            Bleep words
          </button>
          <button
            type="button"
            className="btn ghost"
            onClick={() => setSelected([])}
          >
            Clear selection
          </button>
        </div>
        <div className="desk-grid">
          <label>
            Bleep level (dB)
            <input
              type="number"
              value={bleepDb}
              placeholder="Default (−12)"
              onChange={(e) => setBleepDb(e.target.value)}
            />
          </label>
          <label>
            Range start (seconds)
            <input
              type="number"
              value={rangeStart}
              onChange={(e) => setRangeStart(e.target.value)}
            />
          </label>
          <label>
            Range end (seconds)
            <input
              type="number"
              value={rangeEnd}
              onChange={(e) => setRangeEnd(e.target.value)}
            />
          </label>
          <button
            type="button"
            className="btn ghost"
            onClick={() => add("delete", true)}
          >
            Cut range between dialogues
          </button>
          <label>
            Insert gap at playhead (seconds)
            <input
              type="number"
              value={gap}
              placeholder="Default (0.3)"
              onChange={(e) => setGap(e.target.value)}
            />
          </label>
          <button
            type="button"
            className="btn ghost"
            onClick={() => add("insert")}
          >
            Insert silence
          </button>
        </div>
        <p className="muted">
          Edits preserve the source. Preview skips cuts, silences muted words
          and plays bleeps. Export applies a 10 ms transition at cuts.
        </p>
        <details>
          <summary>{edits.operations.length} edit operations</summary>
          {edits.operations.map((o, i) => (
            <p key={i}>
              {JSON.stringify(o)}{" "}
              <button
                type="button"
                className="btn ghost sm"
                onClick={() =>
                  commit({
                    ...edits,
                    operations: edits.operations.filter((_, j) => j !== i),
                  })
                }
              >
                Remove edit {i + 1}
              </button>
            </p>
          ))}
        </details>
      </section>
      <section className="card">
        <h3>Speaker names</h3>
        <div className="desk-grid">
          {t.speakers.map((s) => (
            <label key={s.id}>
              {s.id}
              <input
                maxLength={60}
                value={edits.speaker_names[s.id] ?? s.name}
                onChange={(e) => {
                  if (e.target.value.trim())
                    commit({
                      ...edits,
                      speaker_names: {
                        ...edits.speaker_names,
                        [s.id]: e.target.value,
                      },
                    });
                }}
              />
            </label>
          ))}
        </div>
      </section>
      <section className="card" aria-label="Podcast export">
        <h3>Export audio & transcript</h3>
        <p className="muted">
          First export included. Re-exports: {Math.ceil(length / 60)} minutes
          for {stamp(length)} of output. Blank settings use MP3 320 kbps/48 kHz,
          WAV 24-bit/48 kHz.
        </p>
        <div className="desk-grid">
          {["mp3", "wav", "srt", "vtt"].map((f) => (
            <label key={f}>
              <input
                type="checkbox"
                checked={choices[f] === true}
                onChange={(e) => set(f, e.target.checked)}
              />
              {f.toUpperCase()}
            </label>
          ))}
          {dropdown(
            "MP3 bitrate (kbps)",
            "bitrate",
            [128, 192, 256, 320],
            "320",
          )}
          {dropdown("MP3 sample rate (Hz)", "mp3rate", [44100, 48000], "48000")}
          {dropdown("WAV bit depth", "depth", [16, 24, "32f"], "24")}
          {dropdown("WAV sample rate (Hz)", "wavrate", [44100, 48000], "48000")}
          <label>
            <input
              type="checkbox"
              checked={choices.labels === true}
              onChange={(e) => set("labels", e.target.checked)}
            />
            Speaker labels in subtitles
          </label>
          <label>
            <input type="checkbox" disabled />
            Video export · Coming soon
          </label>
        </div>
        <button
          type="button"
          className="btn"
          disabled={
            exportBusy ||
            exportLive?.status === "queued" ||
            exportLive?.status === "processing"
          }
          onClick={() => void exportAudio()}
        >
          Export audio ·{" "}
          {exportsCount === 0
            ? "included"
            : `${Math.ceil(length / 60)} minutes`}
        </button>
      </section>
      {exportLive && (
        <ProcessingStatus
          type="podcast_export"
          state={exportLive}
          setState={setExportLive}
        />
      )}
    </section>
  );
}
