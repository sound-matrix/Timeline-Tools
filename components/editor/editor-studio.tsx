"use client";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import DawTimeline, { type DawTransport } from "../daw/daw-timeline";
import VideoPreview from "../daw/video-preview";
import type { VideoClock } from "@/lib/daw/video-sync";
import { arrangementSchema, type Arrangement } from "@/lib/arrangement";
import { CommandHistory } from "@/lib/daw/commands";
import type { ShortcutPreset } from "@/lib/daw/shortcuts";
import {
  importPlacement,
  audioType,
  exportSpan,
  type Placement,
} from "@/lib/editor/model";
import {
  EditorSaver,
  type PendingSave,
  type SaveStatus,
} from "@/lib/editor/autosave";
import {
  localEntry,
  localEntries,
  putEntry,
  deleteEntry,
} from "@/lib/editor/storage";
import { importAudio, type ImportedAudio } from "@/lib/editor/import-audio";
import {
  snapshotSource,
  restoreSource,
  clearSource,
  type SourceBytes,
} from "@/lib/editor/source-journal";
import { clientMixdown, type MixOptions } from "@/lib/editor/mixdown";
import { pcmWindow } from "@/lib/studio-preview";
import {
  podcastRenderArrangement,
  podcastWindow,
  localPodcastEdits,
  podcastOutputTime,
  podcastViewTime,
} from "@/lib/daw/podcast-audio";
import { editsSchema, type PodcastEdits } from "@/lib/podcast";
import { uploadFile } from "@/lib/upload";
import { editorCaptions, subtitleText } from "@/lib/editor/captions";
import { transcriptSchema } from "@/lib/podcast";
import ProcessingStatus from "../processing-status";
import type { ProcessingState } from "@/lib/job-status";
import "./editor.css";
type Asset = {
  id: string;
  name: string;
  duration: number;
  sample_rate: number;
  channels: number;
  bytes: number;
};
type Project = {
  name: string;
  revision: number;
  arrangement: Arrangement;
  source_kind: "blank" | "studio" | "podcast";
  source_job_id: string | null;
  source_arrangement: Arrangement | null;
  source_overlay: {
    edits: PodcastEdits;
    duration: number;
    transcript: unknown;
    media: {
      index: number;
      name: string;
      offset: number;
      duration: number;
      has_proxy: boolean;
    }[];
  } | null;
  assets: Asset[];
  versions: { revision: number; saved_at: string }[];
  exports_count: number;
};
type Upload = {
  id: string;
  name: string;
  progress: number;
  status: string;
  error?: string;
};
type SourceImport = {
  id: string;
  file?: File; // Legacy journals.
  source?: SourceBytes;
  name?: string;
  point: Placement;
  placed?: boolean;
  clipId?: string;
};
type LocalImport = ImportedAudio & {
  id: string;
  name: string;
  registered?: boolean;
};
const options: MixOptions = {
  format: "wav",
  rate: 48000,
  depth: 24,
  bitrate: 320,
  normalize: false,
};
export default function EditorStudio({
  projectId,
  userId,
  name,
  maxMb,
}: {
  projectId: string;
  userId: string;
  name: string;
  maxMb: number;
}) {
  const [subtitles, setSubtitles] = useState<("srt" | "vtt")[]>([]);
  const [project, setProject] = useState<Project | null>(null),
    [a, setA] = useState<Arrangement | null>(null),
    [message, setMessage] = useState(""),
    [status, setStatus] = useState<SaveStatus>("Saved"),
    [conflict, setConflict] = useState<PendingSave | null>(null);
  const [urls, setUrls] = useState<Record<string, string>>({}),
    [peaks, setPeaks] = useState<
      NonNullable<ComponentProps<typeof DawTimeline>["assets"]>
    >({}),
    [uploads, setUploads] = useState<Upload[]>([]),
    [binOpen, setBinOpen] = useState(false),
    [viewOpen, setViewOpen] = useState(false),
    [projectName, setProjectName] = useState(name),
    [settings, setSettings] = useState(false),
    [versions, setVersions] = useState(false),
    [exporting, setExporting] = useState(false),
    [dialog, setDialog] = useState(false),
    [mixOptions, setMixOptions] = useState<MixOptions>(options),
    [range, setRange] = useState<"whole" | "loop" | "selection">("whole"),
    [selection, setSelection] = useState<[number, number] | null>(null),
    [shortcutPreset, setShortcutPreset] = useState<ShortcutPreset>("timeline"),
    [progress, setProgress] = useState(0),
    [playing, setPlaying] = useState(false),
    [videoTime, setVideoTime] = useState(0),
    [viewTime, setViewTime] = useState(0),
    [outputTime, setOutputTime] = useState(0),
    [exportLive, setExportLive] = useState<ProcessingState | null>(null),
    [mobile, setMobile] = useState(true);
  const saver = useRef<EditorSaver | null>(null),
    history = useRef(new CommandHistory()),
    current = useRef<Arrangement | null>(null),
    picker = useRef<HTMLInputElement>(null),
    transport = useRef<DawTransport | null>(null),
    localUrls = useRef<string[]>([]),
    localImports = useRef<Record<string, LocalImport>>({}),
    hashes = useRef(new Map<string, string>()),
    registeredAssets = useRef(new Set<string>()),
    importQueue = useRef(Promise.resolve()),
    live = useRef(true);
  const videoClock = useRef<VideoClock>({
    time: 0,
    playing: false,
    gap: false,
  });
  const key = `${userId}/${projectId}`;
  current.current = a;
  const update = useCallback((next: Arrangement, previous?: Arrangement) => {
    const before = previous ?? current.current;
    if (before) next = history.current.execute("Editor edit", before, next);
    current.current = next;
    setA(next);
    saver.current?.change(next);
  }, []);
  useEffect(() => {
    live.current = true;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/editor/${projectId}`, {
          cache: "no-store",
        });
        const data: Project = await response.json();
        if (!response.ok) throw Error((data as any).error);
        const parsed = arrangementSchema.parse(data.arrangement);
        if (cancelled) return;
        setProject(data);
        const manager = new EditorSaver(
          projectId,
          { revision: data.revision, arrangement: parsed },
          {
            put: (v) => putEntry(`pending/${key}`, v),
            clear: () => deleteEntry(`pending/${key}`),
          },
          (s) => {
            if (!cancelled) setStatus(s);
          },
          (server) => {
            if (!cancelled) setConflict(server);
          },
        );
        saver.current = manager;
        registeredAssets.current = new Set(
          data.assets.map((asset) => asset.id),
        );
        manager.ready = () =>
          manager.current.clips.every(
            (c) => !c.asset || registeredAssets.current.has(c.asset),
          );
        const pending = await localEntry<PendingSave>(`pending/${key}`).catch(
            () => undefined,
          ),
          imports = await localEntry<Record<string, LocalImport>>(
            `imports/${key}`,
          ).catch(() => undefined);
        const next = pending
          ? arrangementSchema.parse(pending.arrangement)
          : parsed;
        setA(next);
        current.current = next;
        const audio: Record<string, string> = {},
          waves: NonNullable<ComponentProps<typeof DawTimeline>["assets"]> = {};
        for (const c of next.clips) {
          audio[c.id] = `/api/editor/${projectId}/media?clip=${c.id}`;
          waves[c.id] = {
            key: `${projectId}/${c.id}`,
            url: `/api/editor/${projectId}/media?clip=${c.id}&kind=peaks`,
          };
        }
        if (imports) {
          localImports.current = imports;
          for (const [id, item] of Object.entries(imports)) {
            const url = URL.createObjectURL(item.audio),
              wave = URL.createObjectURL(item.waveform);
            localUrls.current.push(url, wave);
            audio[id] = url;
            waves[id] = { key: item.hash, url: wave };
            hashes.current.set(item.hash, id);
          }
        }
        if (cancelled) return;
        setUrls(audio);
        setPeaks(waves);
        if (pending) {
          manager.current = next;
          if (pending.revision !== data.revision) {
            manager.conflict = true;
            setStatus("Newer version from another tab");
            setConflict({ revision: data.revision, arrangement: parsed });
          } else manager.change(next);
        }
        if (imports)
          for (const item of Object.values(imports))
            if (!item.registered) void upload(item);
        const sources = await localEntries<SourceImport>(
          `import-source/${key}/`,
        ).catch(() => []);
        if (cancelled) return;
        for (const entry of sources) {
          if (imports?.[entry.value.id]) {
            await clearSource(entry.key);
            await deleteEntry(entry.key);
            continue;
          }
          const file = entry.value.source
            ? await restoreSource(entry.key, entry.value.source)
            : entry.value.file;
          if (!file) {
            await clearSource(entry.key);
            await deleteEntry(entry.key);
            setMessage(
              "The original file copy was interrupted. Please import it again.",
            );
            continue;
          }
          importFiles([file], entry.value.point, entry.value);
        }
      } catch (e) {
        if (!cancelled) setMessage((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
      live.current = false;
      saver.current?.close();
      for (const url of localUrls.current) URL.revokeObjectURL(url);
      localUrls.current = [];
    };
  }, [projectId, key]);
  useEffect(() => {
    const flush = () => void saver.current?.flush().catch(() => {});
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    const keyboard = (e: KeyboardEvent) => {
      if (
        (e.target as HTMLElement).closest(
          "input,textarea,select,[contenteditable]",
        )
      )
        return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "i") {
        e.preventDefault();
        picker.current?.click();
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        flush();
      }
    };
    window.addEventListener("blur", flush);
    window.addEventListener("online", flush);
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("keydown", keyboard);
    return () => {
      window.removeEventListener("blur", flush);
      window.removeEventListener("online", flush);
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("keydown", keyboard);
    };
  }, []);
  useEffect(() => {
    if (!dialog && !settings && !versions && !conflict) return;
    const panel = Array.from(
      document.querySelectorAll<HTMLElement>(".editor-panel"),
    ).at(-1);
    if (!panel) return;
    const previous = document.activeElement as HTMLElement | null;
    const nodes = () =>
      Array.from(
        panel.querySelectorAll<HTMLElement>(
          'button:not(:disabled),a,input,select,textarea,[tabindex="0"]',
        ),
      );
    (panel.querySelector<HTMLElement>("[autofocus]") ?? nodes()[0])?.focus();
    const trap = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !conflict) {
        setDialog(false);
        setSettings(false);
        setVersions(false);
      }
      if (e.key === "Tab") {
        const focusable = nodes(),
          index = focusable.indexOf(document.activeElement as HTMLElement);
        if (e.shiftKey && index <= 0) {
          e.preventDefault();
          focusable.at(-1)?.focus();
        } else if (!e.shiftKey && index === focusable.length - 1) {
          e.preventDefault();
          focusable[0]?.focus();
        }
      }
    };
    panel.addEventListener("keydown", trap);
    return () => {
      panel.removeEventListener("keydown", trap);
      if (previous?.isConnected) previous.focus();
    };
  }, [dialog, settings, versions, conflict]);
  function undo() {
    if (!current.current) return;
    const next = history.current.undo(current.current);
    current.current = next;
    setA(next);
    saver.current?.change(next);
  }
  function redo() {
    if (!current.current) return;
    const next = history.current.redo(current.current);
    current.current = next;
    setA(next);
    saver.current?.change(next);
  }
  function showLocal(id: string, audio: Blob, hash: string) {
    const url = URL.createObjectURL(audio);
    localUrls.current.push(url);
    setUrls((v) => ({ ...v, [id]: url }));
  }
  async function upload(item: LocalImport) {
    const set = (value: Partial<Upload>) => {
      if (live.current)
        setUploads((v) => {
          const old = v.find((u) => u.id === item.id);
          return [
            ...v.filter((u) => u.id !== item.id),
            {
              id: item.id,
              name: item.name,
              progress: 0,
              status: "Uploading",
              ...old,
              ...value,
            },
          ];
        });
    };
    try {
      set({ status: "Uploading", error: undefined });
      const path = `editor/${userId}/${projectId}/${item.id}.wav`,
        peaksPath = `editor/${userId}/${projectId}/${item.id}.peaks`;
      // Resuming a partially uploaded asset must not overwrite immutable Storage objects.
      const existing =
        (await localEntry<{ audio?: boolean; peaks?: boolean }>(
          `uploaded/${key}/${item.id}`,
        ).catch(() => undefined)) ?? {};
      if (!existing.audio) {
        await uploadFile(
          path,
          new File([item.audio], item.id + ".wav", { type: "audio/wav" }),
          (p) => set({ progress: Math.round(p * 0.9) }),
        );
        existing.audio = true;
        await putEntry(`uploaded/${key}/${item.id}`, existing);
      }
      if (!existing.peaks) {
        await uploadFile(
          peaksPath,
          new File([item.waveform], item.id + ".peaks", {
            type: "application/json",
          }),
          () => {},
        );
        existing.peaks = true;
        await putEntry(`uploaded/${key}/${item.id}`, existing);
      }
      const r = await fetch(`/api/editor/${projectId}/assets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: item.id,
          storage_path: path,
          peaks_path: peaksPath,
          name: item.name,
          mime: "audio/wav",
          duration: item.duration,
          sample_rate: item.sample_rate,
          channels: item.channels,
          bytes: item.audio.size,
        }),
      });
      if (!r.ok) throw Error((await r.json()).error);
      item.registered = true;
      registeredAssets.current.add(item.id);
      await putEntry(`imports/${key}`, localImports.current);
      set({ progress: 100, status: "Ready" });
      if (saver.current && !saver.current.conflict) {
        saver.current.change(current.current!);
        void saver.current.flush().catch(() => {});
      }
    } catch (e) {
      set({ status: "Needs retry", error: (e as Error).message });
    }
  }
  const importFiles = useCallback(
    (files: File[], point: Placement, recovery?: SourceImport) => {
      importQueue.current = importQueue.current
        .then(async () => {
          for (const file of files) {
            if (!live.current) break;
            const id = recovery?.id ?? crypto.randomUUID();
            const journal: SourceImport = recovery ?? {
              id,
              name: file.name,
              point,
            };
            const journalKey = `import-source/${key}/${id}`;
            setUploads((v) => [
              ...v,
              { id, name: file.name, progress: 0, status: "Reading audio" },
            ]);
            let clipId = id;
            try {
              if (!audioType(file.name))
                throw Error(
                  "Unsupported type. Use WAV, MP3, FLAC, M4A/AAC, AIFF or OGG.",
                );
              if (file.size > maxMb * 1048576)
                throw Error(`File exceeds your ${maxMb} MB plan limit.`);
              // A completed IDB transaction owns the source before it can appear on the timeline.
              await putEntry(journalKey, journal);
              if (!journal.source) {
                journal.source = await snapshotSource(journalKey, file);
                delete journal.file;
                await putEntry(journalKey, journal);
              }
              const original = await restoreSource(journalKey, journal.source);
              const result = await importAudio(
                original,
                current.current!.sample_rate,
                maxMb,
                userId,
                (audio, metadata) => {
                  const prior =
                    journal.clipId ?? hashes.current.get(metadata.hash);
                  if (
                    prior &&
                    current.current?.clips.some((c) => c.id === prior)
                  )
                    clipId = prior;
                  else {
                    hashes.current.set(metadata.hash, id);
                  }
                  if (clipId === id) showLocal(id, audio, metadata.hash);
                  const clip = {
                    id: clipId,
                    asset: clipId,
                    name: file.name,
                    duration: metadata.duration,
                  };
                  const alreadyPlaced =
                    journal.placed ||
                    (point.bin
                      ? current.current!.unplaced.some((u) => u.clip === clipId)
                      : current.current!.regions.some((r) => r.id === id));
                  if (!alreadyPlaced)
                    update(
                      importPlacement(
                        current.current!,
                        clip,
                        { ...point, regionId: id },
                        "off",
                      ),
                    );
                  journal.placed = true;
                  journal.clipId = clipId;
                  void putEntry(journalKey, journal).catch(() => {});
                },
              );
              if (clipId !== id) {
                setUploads((v) =>
                  v.map((u) =>
                    u.id === id
                      ? {
                          ...u,
                          progress: 100,
                          status: "Already imported · placed a copy",
                        }
                      : u,
                  ),
                );
                await clearSource(journalKey);
                await deleteEntry(journalKey);
                continue;
              }
              if (result.audio.size > maxMb * 1048576)
                throw Error(
                  `Decoded audio exceeds your ${maxMb} MB file/storage limit. Use a shorter audio file.`,
                );
              const item = { ...result, id, name: file.name };
              localImports.current[id] = item;
              await putEntry(`imports/${key}`, localImports.current);
              await clearSource(journalKey);
              await deleteEntry(journalKey);
              const wave = URL.createObjectURL(result.waveform);
              localUrls.current.push(wave);
              setPeaks((v) => ({
                ...v,
                [id]: { key: result.hash, url: wave },
              }));
              void upload(item);
            } catch (e) {
              const reason =
                e instanceof Error
                  ? e.message
                  : String(
                      e ??
                        "Your browser could not save this audio on the device.",
                    );
              if (!journal.placed) {
                await clearSource(journalKey).catch(() => {});
                await deleteEntry(journalKey).catch(() => {});
              }
              setUploads((v) =>
                v.map((u) =>
                  u.id === id
                    ? {
                        ...u,
                        status: "Import failed",
                        error: reason,
                      }
                    : u,
                ),
              );
              setMessage(`${file.name}: ${reason}`);
            }
          }
        })
        .catch((e) => setMessage(e.message));
    },
    [key, maxMb, userId, update],
  );
  const sourceIds = useMemo(
    () => new Set(project?.source_arrangement?.clips.map((c) => c.id) ?? []),
    [project?.source_arrangement],
  );
  const podcastEdits = useMemo(
    () =>
      project?.source_overlay
        ? editsSchema.parse({
            ...project.source_overlay.edits,
            timeline: undefined,
          })
        : null,
    [project?.source_overlay],
  );
  const rendered = useMemo(
    () =>
      a && podcastEdits
        ? podcastRenderArrangement(a, podcastEdits, sourceIds)
        : a,
    [a, podcastEdits, sourceIds],
  );
  const readWindow = useCallback(
    async (ctx: AudioContext, url: string, start: number, length: number) => {
      const original = a?.clips.find((c) => !c.asset && urls[c.id] === url);
      if (podcastEdits && original)
        return podcastWindow(
          ctx,
          url,
          start,
          length,
          original.duration,
          original.id === "source"
            ? podcastEdits
            : localPodcastEdits(
                podcastEdits,
                original.offset ?? 0,
                original.duration,
              ),
        );
      return pcmWindow(ctx, url, start, length);
    },
    [a?.clips, podcastEdits, urls],
  );
  const media = useMemo(
    () =>
      (project?.source_overlay?.media ?? []).map((m) => ({
        ...m,
        proxy: m.has_proxy
          ? `/api/podcast/${project!.source_job_id}/media?kind=proxy&index=${m.index}`
          : null,
      })),
    [project?.source_overlay, project?.source_job_id],
  );
  const videos = useMemo(
    () =>
      media
        .filter((m) => m.proxy)
        .map((m) => ({
          id: String(m.index),
          start: m.offset,
          duration: m.duration,
          url: m.proxy!,
        })),
    [media],
  );
  const wordOverlays = useMemo(() => {
    if (!a || !project?.source_overlay || !podcastEdits) return [];
    const transcript = transcriptSchema.safeParse(
      project.source_overlay.transcript,
    );
    if (!transcript.success) return [];
    const words = transcript.data.words.slice(0, 2000);
    return a.regions.flatMap((r) => {
      const c = a.clips.find((c) => c.id === r.clip);
      if (!c || c.asset) return [];
      return words.flatMap((w, i) => {
        const start = w.start - (c.offset ?? 0),
          end = w.end - (c.offset ?? 0);
        if (start < r.src_start || end > r.src_end) return [];
        const affected = podcastEdits.operations.some(
          (o) => o.op !== "insert" && w.start < o.end && w.end > o.start,
        );
        return [
          {
            id: `${r.id}-word-${i}`,
            lane: r.lane,
            start: r.start + start - r.src_start,
            end: r.start + end - r.src_start,
            text: podcastEdits.corrections[String(i)] ?? w.w,
            muted: affected,
          },
        ];
      });
    });
  }, [a, project?.source_overlay, podcastEdits]);
  async function save() {
    try {
      await saver.current?.flush();
      setMessage("");
    } catch (e) {
      setMessage((e as Error).message);
    }
  }
  async function exportAudio(cloud = false) {
    if (!a || !rendered) {
      setMessage("Load or import audio before exporting.");
      return;
    }
    if (exporting) {
      setMessage("An export is already running.");
      return;
    }
    setMessage("");
    let span: [number, number];
    try {
      span = exportSpan(rendered, range, selection ?? undefined);
    } catch (e) {
      setMessage((e as Error).message);
      return;
    }
    setExporting(true);
    setProgress(0);
    try {
      if (cloud) {
        await saver.current!.flush();
        const r = await fetch(`/api/editor/${projectId}/export`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            revision: saver.current!.revision,
            options: mixOptions,
            subtitles,
            range: span,
            expected_cost: project?.exports_count
              ? Math.ceil((span[1] - span[0]) / 60)
              : 0,
          }),
        });
        const data = await r.json();
        if (!r.ok) throw Error(data.error);
        setExportLive({
          id: data.id,
          fileName: "Editor export",
          status: "queued",
          error: null,
          durationSec: null,
          downloads: [],
        });
      } else {
        const blob = await clientMixdown(
          rendered,
          span,
          urls,
          readWindow,
          mixOptions,
          setProgress,
        );
        const url = URL.createObjectURL(blob),
          link = document.createElement("a");
        link.href = url;
        link.download = `${projectName.replace(/[^a-z0-9_-]/gi, "-")}.${mixOptions.format}`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        if (podcastEdits && project?.source_overlay && subtitles.length) {
          const transcript = transcriptSchema.parse(
              project.source_overlay.transcript,
            ),
            cues = editorCaptions(a, rendered, transcript, podcastEdits, span);
          for (const format of subtitles) {
            const href = URL.createObjectURL(
                new Blob([subtitleText(cues, format)], { type: "text/plain" }),
              ),
              link = document.createElement("a");
            link.href = href;
            link.download = `${projectName}.${format}`;
            link.click();
            setTimeout(() => URL.revokeObjectURL(href), 60000);
          }
        }
      }
      setMessage(
        cloud ? "Cloud export queued." : "Local export downloaded · free.",
      );
      setDialog(false);
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setExporting(false);
    }
  }
  async function back(e: React.MouseEvent) {
    e.preventDefault();
    try {
      await saver.current?.flush();
    } catch {}
    location.assign("/dashboard");
  }
  if (!a || !project)
    return (
      <main className="card">
        <h1>Editor Studio</h1>
        <p role="status">{message || "Loading project…"}</p>
        <a href="/dashboard">Back</a>
      </main>
    );
  return (
    <main
      className="editor-studio"
      aria-label="Editor Studio"
      onDragOver={(e) => {
        e.preventDefault();
        if (e.dataTransfer.types.includes("Files")) setBinOpen(true);
      }}
      onDrop={(e) => {
        if (e.defaultPrevented) return;
        e.preventDefault();
        importFiles(Array.from(e.dataTransfer.files), { time: 0 });
      }}
    >
      <header className="editor-top">
        <a href="/dashboard" onClick={back}>
          ← Back
        </a>
        <div>
          <small>EDITOR STUDIO</small>
          <input
            aria-label="Project name"
            value={projectName}
            maxLength={100}
            onChange={(e) => setProjectName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
            onBlur={() => {
              if (!projectName.trim()) {
                setProjectName(project.name);
                return;
              }
              if (projectName.trim() && projectName !== project.name)
                void fetch(`/api/editor/${projectId}`, {
                  method: "PATCH",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ name: projectName.trim() }),
                })
                  .then(async (r) => {
                    if (!r.ok) throw Error("Could not rename project");
                    setProject((p) =>
                      p ? { ...p, name: projectName.trim() } : p,
                    );
                  })
                  .catch((e) => setMessage(e.message));
            }}
          />
        </div>
        <div id="editor-transport" />
        <span role="status" aria-label="Editor save status">
          {status}
        </span>
        <button className="btn ghost" onClick={() => void save()}>
          Save
        </button>
        <button className="btn" onClick={() => picker.current?.click()}>
          Import
        </button>
        <button
          className="btn"
          onClick={() => {
            setDialog(true);
            void fetch(`/api/editor/${projectId}`)
              .then((r) => (r.ok ? r.json() : null))
              .then((p) => {
                if (p) setProject(p);
              })
              .catch(() => {});
          }}
        >
          Export
        </button>
        <button className="btn ghost" onClick={() => setVersions((v) => !v)}>
          Versions
        </button>
        <button className="btn ghost" onClick={() => setViewOpen((v) => !v)}>
          Settings
        </button>
        <button
          className="btn ghost"
          aria-expanded={binOpen}
          onClick={() => setBinOpen((v) => !v)}
        >
          Library
        </button>
      </header>
      <input
        ref={picker}
        type="file"
        multiple
        accept=".wav,.mp3,.flac,.m4a,.aac,.aiff,.aif,.ogg"
        className="editor-file-input"
        aria-label="Import audio files"
        onChange={(e) => {
          importFiles(Array.from(e.target.files ?? []), { time: 0 });
          e.target.value = "";
        }}
      />
      {mobile && (
        <div className="editor-mobile">
          Editor Studio works best on desktop.{" "}
          <button className="btn ghost" onClick={() => setMobile(false)}>
            Continue editing
          </button>
        </div>
      )}
      {message && (
        <p role="alert" className="editor-message">
          {message}
        </p>
      )}
      <div className={`editor-workspace ${binOpen ? "bin-open" : ""}`}>
        <div className="editor-desk">
          <DawTimeline
            fullPage
            viewOpen={viewOpen}
            onViewClose={() => setViewOpen(false)}
            onProjectSettings={() => {
              setViewOpen(false);
              setSettings(true);
            }}
            arrangement={a}
            playbackArrangement={rendered ?? a}
            audioUrls={urls}
            assets={peaks}
            overlays={wordOverlays}
            onChange={update}
            onPreview={(next) => {
              current.current = next;
              setA(next);
            }}
            onUndo={undo}
            onRedo={redo}
            onImport={importFiles}
            onRangeChange={setSelection}
            readWindow={readWindow}
            shortcutPreset={shortcutPreset}
            transport={transport}
            onPlayingChange={setPlaying}
            playhead={podcastEdits ? viewTime : undefined}
            playbackPosition={podcastEdits ? outputTime : undefined}
            onSeek={(t) => {
              const mapped = podcastEdits
                ? podcastViewTime(a, podcastEdits, t)
                : { source: t, output: t };
              videoClock.current = {
                time: mapped.source,
                playing: false,
                gap: false,
              };
              setViewTime(t);
              setOutputTime(mapped.output);
              setVideoTime(mapped.source);
              return mapped.output;
            }}
            onPlaybackFrame={(t, presenting) => {
              if (podcastEdits && rendered) {
                const mapped = podcastOutputTime(a, rendered, podcastEdits, t);
                videoClock.current = {
                  time: mapped.source,
                  playing: presenting ?? true,
                  gap: mapped.gap,
                };
                return mapped.view;
              }
            }}
            onPlaybackTick={(t) => {
              if (podcastEdits && rendered) {
                const mapped = podcastOutputTime(a, rendered, podcastEdits, t);
                setVideoTime(mapped.source);
                setViewTime(mapped.view);
                setOutputTime(t);
              }
            }}
            videos={videos}
          />
        </div>
        <aside
          className="editor-bin"
          hidden={!binOpen}
          aria-label="Clip bin"
          onDragOver={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            importFiles(Array.from(e.dataTransfer.files), {
              time: 0,
              bin: true,
            });
          }}
        >
          <h2>
            Clip bin{" "}
            <button
              aria-label="Close library"
              onClick={() => setBinOpen(false)}
            >
              ×
            </button>
          </h2>
          <button onClick={() => setSettings(true)}>Project settings</button>
          <p className="muted">
            Drop audio here to import without placing it. File and total Editor
            storage limit: {maxMb} MB for your plan.
          </p>
          {!a.clips.length && (
            <p>
              Drop your first recording onto the timeline to create a track.
            </p>
          )}
          {a.clips.map((c) => (
            <div
              className="editor-clip"
              key={c.id}
              draggable
              onDragStart={(e) =>
                e.dataTransfer.setData("application/x-editor-clip", c.id)
              }
            >
              <b>{c.name}</b>
              <small>{c.duration.toFixed(2)} s</small>
              <button
                className="btn ghost"
                onClick={() => update(importPlacement(a, c, { time: 0 }))}
              >
                Place on new track
              </button>
            </div>
          ))}
          <div aria-label="Import progress">
            {uploads.map((u) => (
              <div key={u.id} className="editor-upload">
                <b>{u.name}</b>
                <span>
                  {u.status} {u.progress > 0 ? `${u.progress}%` : ""}
                </span>
                {u.error && <p role="alert">{u.error}</p>}
                {u.status === "Needs retry" && (
                  <button
                    className="btn ghost"
                    onClick={() => void upload(localImports.current[u.id])}
                  >
                    Retry upload
                  </button>
                )}
              </div>
            ))}
          </div>
          {!!media.length && (
            <VideoPreview
              media={media}
              playhead={videoTime}
              clock={videoClock}
              playing={playing}
            />
          )}
          {podcastEdits && (
            <p className="muted">
              Podcast word edits are kept as non-destructive overlays in
              playback and exports.
            </p>
          )}
        </aside>
      </div>
      {settings && (
        <div
          className="editor-panel"
          role="dialog"
          aria-modal="true"
          aria-label="Project settings"
        >
          <h2>Project settings</h2>
          <label>
            Project sample rate
            <select
              value={a.sample_rate}
              onChange={(e) =>
                update({
                  ...a,
                  sample_rate: Number(
                    e.target.value,
                  ) as Arrangement["sample_rate"],
                })
              }
            >
              {[44100, 48000, 96000].map((n) => (
                <option key={n} value={n}>
                  {n} Hz
                </option>
              ))}
            </select>
          </label>
          <p>
            Sources are resampled to the playback context rate; export rate is
            editable separately.
          </p>
          <label>
            Familiar shortcuts
            <select
              value={shortcutPreset}
              onChange={(e) =>
                setShortcutPreset(e.target.value as ShortcutPreset)
              }
            >
              <option value="timeline">Timeline Tools</option>
              <option value="logic">Logic-like</option>
              <option value="protools">Pro Tools-like</option>
              <option value="cubase">Cubase-like</option>
            </select>
          </label>
          <button className="btn" onClick={() => setSettings(false)}>
            Close settings
          </button>
        </div>
      )}
      {versions && (
        <div
          className="editor-panel"
          role="dialog"
          aria-modal="true"
          aria-label="Version history"
        >
          <h2>Version history</h2>
          <button
            className="btn ghost"
            onClick={async () => {
              const r = await fetch(`/api/editor/${projectId}`);
              if (r.ok) setProject(await r.json());
            }}
          >
            Refresh versions
          </button>
          {project.versions.map((v) => (
            <button
              className="btn ghost"
              key={v.revision}
              onClick={async () => {
                try {
                  const r = await fetch(
                    `/api/editor/${projectId}?version=${v.revision}`,
                  );
                  if (!r.ok) throw Error("Version unavailable");
                  update(arrangementSchema.parse((await r.json()).arrangement));
                  setVersions(false);
                } catch (e) {
                  setMessage((e as Error).message);
                }
              }}
            >
              Restore r{v.revision} · {new Date(v.saved_at).toLocaleString()}
            </button>
          ))}
          <button className="btn" onClick={() => setVersions(false)}>
            Close history
          </button>
        </div>
      )}
      {conflict && (
        <div
          className="editor-panel"
          role="dialog"
          aria-modal="true"
          aria-label="Newer version from another tab"
        >
          <h2>Newer version from another tab</h2>
          <p>
            Your edits are kept on this device. Choose which version to save.
          </p>
          <button
            autoFocus
            className="btn"
            onClick={async () => {
              try {
                await saver.current!.resolve(conflict, true);
                setConflict(null);
              } catch (e) {
                setMessage((e as Error).message);
              }
            }}
          >
            Keep mine
          </button>
          <button
            className="btn ghost"
            onClick={async () => {
              await saver.current!.resolve(conflict, false);
              setA(conflict.arrangement);
              current.current = conflict.arrangement;
              history.current = new CommandHistory();
              setConflict(null);
            }}
          >
            Keep theirs
          </button>
        </div>
      )}
      {dialog && (
        <div
          className="editor-panel"
          role="dialog"
          aria-modal="true"
          aria-label="Export Editor project"
        >
          <h2>Export project</h2>
          <p>
            Local mixdown is free. First cloud export is included; later cloud
            exports use output-length processing minutes.
          </p>
          <label>
            Format
            <select
              value={mixOptions.format}
              onChange={(e) =>
                setMixOptions((v) => ({
                  ...v,
                  format: e.target.value as "wav" | "mp3",
                }))
              }
            >
              <option value="wav">WAV</option>
              <option value="mp3">MP3</option>
            </select>
          </label>
          <label>
            Sample rate
            <select
              value={mixOptions.rate}
              onChange={(e) =>
                setMixOptions((v) => ({
                  ...v,
                  rate: Number(e.target.value) as MixOptions["rate"],
                }))
              }
            >
              {[44100, 48000, 96000].map((n) => (
                <option key={n} value={n}>
                  {n} Hz
                </option>
              ))}
            </select>
          </label>
          {mixOptions.format === "wav" ? (
            <label>
              Bit depth
              <select
                value={mixOptions.depth}
                onChange={(e) =>
                  setMixOptions((v) => ({
                    ...v,
                    depth: Number(e.target.value) as 16 | 24,
                  }))
                }
              >
                <option value={24}>24-bit</option>
                <option value={16}>16-bit</option>
              </select>
            </label>
          ) : (
            <label>
              MP3 bitrate
              <select
                value={mixOptions.bitrate}
                onChange={(e) =>
                  setMixOptions((v) => ({
                    ...v,
                    bitrate: Number(e.target.value) as MixOptions["bitrate"],
                  }))
                }
              >
                {[128, 192, 256, 320].map((n) => (
                  <option key={n} value={n}>
                    {n} kbps
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            Range
            <select
              value={range}
              onChange={(e) => setRange(e.target.value as typeof range)}
            >
              <option value="whole">Whole project</option>
              <option value="loop">Loop Window</option>
              <option value="selection">Selection</option>
            </select>
          </label>
          <label>
            <input
              type="checkbox"
              checked={mixOptions.normalize}
              onChange={(e) =>
                setMixOptions((v) => ({ ...v, normalize: e.target.checked }))
              }
            />
            Peak normalize
          </label>
          {project.source_overlay && (
            <fieldset>
              <legend>Subtitles</legend>
              {(["srt", "vtt"] as const).map((format) => (
                <label key={format}>
                  <input
                    type="checkbox"
                    checked={subtitles.includes(format)}
                    onChange={(e) =>
                      setSubtitles((v) =>
                        e.target.checked
                          ? [...v, format]
                          : v.filter((f) => f !== format),
                      )
                    }
                  />
                  {format.toUpperCase()}
                </label>
              ))}
            </fieldset>
          )}
          {message && <p role="alert">{message}</p>}
          {exporting && <p role="status">Export running · {progress}%</p>}
          <button className="btn" onClick={() => void exportAudio()}>
            Download local mix · free
          </button>
          <button className="btn ghost" onClick={() => void exportAudio(true)}>
            High-quality render (cloud)
          </button>
          <button className="btn ghost" onClick={() => setDialog(false)}>
            Close export
          </button>
        </div>
      )}
      {exportLive && (
        <div className="editor-processing">
          <ProcessingStatus
            state={exportLive}
            setState={setExportLive}
            type="studio_export"
          />
        </div>
      )}
    </main>
  );
}
