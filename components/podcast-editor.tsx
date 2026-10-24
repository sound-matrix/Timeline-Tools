"use client";
import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import {
  transcriptSchema,
  editsSchema,
  cutRanges,
  editedDuration,
  remapTime,
  outputToSource,
  type PodcastTranscript,
  type PodcastEdits,
} from "@/lib/podcast";
import { podcastExportSchema } from "@/lib/settings";
import { withDefaults } from "@/lib/defaults";
import ProcessingStatus from "./processing-status";
import type { ProcessingState } from "@/lib/job-status";
import DawTimeline, { type DawTransport } from "./daw/daw-timeline";
import { arrangementSchema } from "@/lib/arrangement";
import {
  podcastRenderArrangement,
  localPodcastEdits,
  podcastViewTime,
  podcastOutputTime,
  podcastWindow,
} from "@/lib/daw/podcast-audio";
import OpenEditor from "./editor/open-editor";
import VideoPreview from "./daw/video-preview";
import type { VideoClock } from "@/lib/daw/video-sync";
type Media = {
  index: number;
  name: string;
  offset: number;
  duration: number;
  proxy: string | null;
  audio?: string | null;
  peaks?: string | null;
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
    [viewHead, setViewHead] = useState(0),
    [outputHead, setOutputHead] = useState(0),
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
  const transport = useRef<DawTransport | null>(null);
  const videoClock = useRef<VideoClock>({
    time: 0,
    playing: false,
    gap: false,
  });
  const revision = useRef(1),
    lastSaved = useRef(""),
    current = useRef(edits),
    history = useRef<PodcastEdits[]>([]),
    future = useRef<PodcastEdits[]>([]),
    saving = useRef(false),
    conflict = useRef(false),
    anchor = useRef<number | null>(null);
  current.current = edits;
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
    const timer = setTimeout(() => void save(), 2000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [jobId, session, edits]);
  const seek = useCallback((seconds: number) => {
    setPlayhead(seconds);
    const a = current.current.timeline,
      r = a?.regions.find((r) => {
        const c = a.clips.find((c) => c.id === r.clip);
        return (
          seconds >= (c?.offset ?? 0) + r.src_start &&
          seconds < (c?.offset ?? 0) + r.src_end
        );
      });
    const c = a?.clips.find((c) => c.id === r?.clip),
      view = r ? r.start + seconds - (c?.offset ?? 0) - r.src_start : seconds;
    setViewHead(view);
    transport.current?.seek(view);
  }, []);
  async function flushEditor() {
    const deadline=Date.now()+15000;
    while(saving.current && Date.now()<deadline)await new Promise(r=>setTimeout(r,25));
    if(saving.current || conflict.current)throw Error("Resolve the save conflict before opening Editor Studio.");
    saving.current=true;
    try {
      const snapshot=JSON.stringify(current.current);
      const r=await fetch(`/api/podcast/${jobId}`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({revision:revision.current,edits:current.current})});
      if(!r.ok)throw Error("Could not save the latest word edits. Retry opening Editor Studio.");
      revision.current=(await r.json()).revision;lastSaved.current=snapshot;setSaved("Saved");
    } finally {saving.current=false;}
  }
  function toggle() {
    transport.current?.toggle();
  }
  function commit(next: PodcastEdits, previous = current.current) {
    if (
      session &&
      (editedDuration(session.duration, next) <= 0 ||
        editedDuration(session.duration, next) > 14400)
    ) {
      setMessage(
        "Keep an output length greater than zero and at most four hours.",
      );
      return;
    }
    transport.current?.stop();
    history.current.push(structuredClone(previous));
    if (history.current.length > 200) history.current.shift();
    future.current = [];
    setHistorySize(history.current.length);
    setFutureSize(0);
    setEdits(next);
    setSaved("Unsaved");
  }
  function undo() {
    transport.current?.stop();
    const prev = history.current.pop();
    if (!prev) return;
    future.current.push(structuredClone(current.current));
    setEdits(prev);
    setHistorySize(history.current.length);
    setFutureSize(future.current.length);
    setSaved("Unsaved");
  }
  function redo() {
    transport.current?.stop();
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
  const podcastTimeline = useMemo(() => {
    if (!session) return null;
    if (edits.timeline) return edits.timeline;
    const speakers = session.transcript.speakers;
    const laneFor = new Map<number, string>();
    for (const m of session.media) {
      const counts = new Map<string, number>();
      for (const w of session.transcript.words)
        if (w.start >= m.offset && w.start < m.offset + m.duration)
          counts.set(w.speaker, (counts.get(w.speaker) ?? 0) + 1);
      laneFor.set(
        m.index,
        [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? speakers[0].id,
      );
    }
    return arrangementSchema.parse({
      version: 2,
      job_id: jobId,
      sample_rate: 48000,
      pan_law: session.media.every((m) => m.audio) ? "equal_power" : "legacy",
      duration: session.duration,
      snap: true,
      lanes: speakers.map((s, i) => ({
        id: s.id,
        name: edits.speaker_names[s.id] ?? s.name,
        color: ["#818CF8", "#A78BFA", "#67E8F9"][i % 3],
        gain_db: 0,
        mute: false,
        solo: false,
      })),
      clips: session.media.every((m) => m.audio)
        ? session.media.map((m) => ({
            id: `c${m.index}`,
            name: m.name,
            duration: m.duration,
            offset: m.offset,
          }))
        : [
            {
              id: "source",
              name: "Podcast source",
              duration: session.duration,
            },
          ],
      regions: (session.media.every((m) => m.audio)
        ? session.media
        : [{ ...session.media[0], offset: 0, duration: session.duration }]
      ).map((m, i) => ({
        id: `media_${i}`,
        lane: laneFor.get(m.index) ?? speakers[0].id,
        kind: "clip",
        clip: session.media.every((m) => m.audio) ? `c${m.index}` : "source",
        src_start: session.media.every((m) => m.audio) ? 0 : m.offset,
        src_end: session.media.every((m) => m.audio)
          ? m.duration
          : Math.min(session.duration, m.offset + m.duration),
        start: m.offset,
        gain_db: 0,
        line: 0,
        confidence: 1,
        lines: [],
      })),
      lines: [{ index: 0, speaker: "", text: "Podcast source" }],
      missing: [],
      unplaced: [],
    });
  }, [session, edits.timeline, edits.speaker_names, jobId]);
  useEffect(() => {
    if (podcastTimeline && !edits.timeline) {
      setEdits({ ...current.current, timeline: podcastTimeline });
      setSaved("Unsaved");
    }
  }, [podcastTimeline, edits.timeline]);
  const podcastAssets = useMemo<Record<string, { key: string; url: string }>>(
    () =>
      session
        ? Object.fromEntries([
            ["source", { key: `${jobId}/podcast-source`, url: session.peaks }],
            ...session.media
              .filter((m) => m.peaks)
              .map((m) => [
                `c${m.index}`,
                { key: `${jobId}/podcast-c${m.index}`, url: m.peaks! },
              ]),
          ])
        : ({} as Record<string, { key: string; url: string }>),
    [session, jobId],
  );
  const podcastAudio = useMemo<Record<string, string>>(
    () =>
      session
        ? Object.fromEntries([
            ["source", session.audio],
            ...session.media
              .filter((m) => m.audio)
              .map((m) => [`c${m.index}`, m.audio!]),
          ])
        : ({} as Record<string, string>),
    [session],
  );
  const podcastVideos = useMemo(
    () =>
      session?.media
        .filter((m) => m.proxy)
        .map((m) => ({
          id: String(m.index),
          start: m.offset,
          duration: m.duration,
          url: m.proxy!,
        })) ?? [],
    [session],
  );
  const podcastOverlays = useMemo(
    () =>
      session?.transcript.words.map((w, i) => ({
        id: String(i),
        lane: w.speaker,
        start: w.start,
        end: w.end,
        text: edits.corrections[String(i)] ?? w.w,
        selected: selected.includes(i),
        muted: edits.operations.some(
          (o) => o.op !== "insert" && o.start < w.end && o.end > w.start,
        ),
        onSelect: (extend: boolean) => select(i, extend),
      })) ?? [],
    [session, edits, selected],
  );
  const podcastRender = useMemo(
    () =>
      podcastTimeline
        ? podcastRenderArrangement(podcastTimeline, edits)
        : undefined,
    [podcastTimeline, edits],
  );
  const readPodcast = useCallback(
    (ctx: AudioContext, url: string, start: number, length: number) =>
      podcastWindow(
        ctx,
        url,
        start,
        length,
        session?.media.find((m) => m.audio === url)?.duration ??
          session?.duration ??
          0,
        session?.media.find((m) => m.audio === url)
          ? localPodcastEdits(
              edits,
              session.media.find((m) => m.audio === url)!.offset,
              session.media.find((m) => m.audio === url)!.duration,
            )
          : edits,
      ),
    [session?.duration, edits],
  );
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
          {stamp(outputHead)} / {stamp(length)}
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
      {message && <p role="alert">{message}</p>}
      <div className="studio-workspace">
        <div className="podcast-workspace-main">
          <VideoPreview
            media={session.media}
            playhead={playhead}
            clock={videoClock}
            playing={playing}
          />
          <DawTimeline
            arrangement={podcastTimeline!}
            transport={transport}
            onPlayingChange={setPlaying}
            onUndo={undo}
            onRedo={redo}
            onPreview={(next) => setEdits({ ...edits, timeline: next })}
            onChange={(next, before) =>
              commit(
                { ...edits, timeline: next },
                before ? { ...edits, timeline: before } : current.current,
              )
            }
            assets={podcastAssets}
            audioUrls={podcastAudio}
            overlays={podcastOverlays}
            videos={podcastVideos}
            playhead={viewHead}
            playbackPosition={outputHead}
            onSeek={(t) => {
              const mapped = podcastViewTime(
                podcastTimeline!,
                current.current,
                t,
              );
              setViewHead(t);
              setOutputHead(mapped.output);
              setPlayhead(mapped.source);
              videoClock.current = {
                time: mapped.source,
                playing: false,
                gap: false,
              };
              return mapped.output;
            }}
            onPlaybackFrame={(t) => {
              const mapped = podcastOutputTime(
                podcastTimeline!,
                podcastRender!,
                current.current,
                t,
              );
              videoClock.current = {
                time: mapped.source,
                playing: true,
                gap: mapped.gap,
              };
              return mapped.view;
            }}
            onPlaybackTick={(t) => {
              const mapped = podcastOutputTime(
                podcastTimeline!,
                podcastRender!,
                current.current,
                t,
              );
              setOutputHead(t);
              setViewHead(mapped.view);
              setPlayhead(mapped.source);
            }}
            playbackArrangement={podcastRender}
            readWindow={readPodcast}
          />
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
      <OpenEditor source="podcast" jobId={jobId} flush={flushEditor} />
    </section>
  );
}
