"use client";
import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { withDefaults, DEFAULT_HELP } from "@/lib/defaults";
import { fieldErrors, CONTROL_DEFAULTS } from "@/lib/validation";
import { extensions, jobSchema } from "@/lib/settings";
import { processingSettings, type Choices } from "@/lib/processing-form";
import {
  parseScript,
  SCRIPT_MAX_BYTES,
  STUDIO_MAX_BYTES,
} from "@/lib/audio-studio";
import { uploadFile } from "@/lib/upload";
import { browserClient } from "@/lib/supabase/client";
import type { ProcessingState } from "@/lib/job-status";
import Visualizer from "./visualizer";
import ProcessingStatus from "./processing-status";
import StudioDaw from "./studio-daw";
const accept = extensions.map((e) => "." + e).join(",");
export default function AudioStudio({
  userId,
  maxMb,
  initial,
}: {
  userId: string;
  maxMb: number;
  initial: ProcessingState | null;
}) {
  const router = useRouter();
  const submitting = useRef(false);
  const scriptRead = useRef(0);
  const bedInput = useRef<HTMLInputElement>(null);
  const [clips, setClips] = useState<{ file: File; speaker: string }[]>([]),
    [bed, setBed] = useState<File | null>(null),
    [script, setScript] = useState(""),
    [title, setTitle] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [ignoredScript, setIgnoredScript] = useState(false);
  const [choices, setChoices] = useState<Choices>({}),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [live, setLive] = useState(initial);
  const locked =
    busy || live?.status === "queued" || live?.status === "processing";
  const maxBytes = Math.min(maxMb * 1048576, STUDIO_MAX_BYTES);
  const preview = useMemo(() => {
    try {
      return { lines: parseScript(script), error: "" };
    } catch (e) {
      return {
        lines: [],
        error: script.trim()
          ? (e as Error).message
          : "No script: clips will be auto-transcribed.",
      };
    }
  }, [script]);
  const bytes =
    clips.reduce((n, c) => n + c.file.size, 0) +
    (bed?.size ?? 0) +
    new TextEncoder().encode(script).length +
    65536;
  const filesReady =
    clips.length > 0 && clips.length <= 200 && bytes <= maxBytes;
  const selection = jobSchema.safeParse({
    type: "studio",
    settings: withDefaults(
      "studio",
      processingSettings("studio", { ...choices, hasBed: !!bed }),
    ),
  });
  function changed() {
    setMessage("");
    setIgnoredScript(false);
    setLive(null);
  }
  function update(key: string, value: string | boolean) {
    setChoices((v) => ({ ...v, [key]: value }));
  }
  function media(file?: File) {
    if (!file) return null;
    if (
      !extensions.includes(file.name.split(".").pop()?.toLowerCase() ?? "") ||
      !file.size ||
      file.size > maxBytes
    ) {
      setMessage(
        `Choose non-empty audio/video files. Project limit: ${Math.floor(maxBytes / 1048576)} MB.`,
      );
      return null;
    }
    return file;
  }
  async function readScript(file?: File) {
    const version = ++scriptRead.current;
    if (!file) return;
    if (file.size > SCRIPT_MAX_BYTES || !/\.(txt|srt|vtt)$/i.test(file.name)) {
      setMessage("Choose a TXT, SRT or VTT script up to 64 KB.");
      return;
    }
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(
        await file.arrayBuffer(),
      );
      if (version !== scriptRead.current) return;
      changed();
      setScript(text);
    } catch {
      setMessage("Could not read the UTF-8 script file.");
    }
  }
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (locked || submitting.current) return;
    setErrors({});
    if (!clips.length) {
      setMessage("Choose at least one audio or video file.");
      return;
    }
    if (!filesReady) {
      setMessage("Check the project file count and upload limit.");
      return;
    }
    if (!selection.success) {
      setErrors(fieldErrors(selection.error.issues));
      setMessage("Check the highlighted processing settings.");
      return;
    }
    if (script.trim() && preview.error && !ignoredScript) {
      setMessage(
        `Script ignored: ${preview.error}. Clips will be auto-transcribed. Confirm below before starting.`,
      );
      return;
    }
    submitting.current = true;
    scriptRead.current++;
    setBusy(true);
    setMessage("");
    const name = title.trim() || "Audio Studio session",
      base = { fileName: name, error: null, durationSec: null, downloads: [] };
    setLive({ ...base, status: "starting" });
    const path = `${userId}/${crypto.randomUUID()}.zip`;
    let uploaded = false,
      submitted = false;
    try {
      const { zipSync, strToU8 } = await import("fflate");
      const entries: Record<string, Uint8Array> = {};
      const add = async (file: File, stem: string) => {
        const key = `${stem}.${file.name.split(".").pop()!.toLowerCase()}`;
        entries[key] = new Uint8Array(await file.arrayBuffer());
        return key;
      };
      const manifestClips = [];
      for (const [i, c] of clips.entries())
        manifestClips.push({
          file: await add(c.file, `clip-${i}`),
          name: c.file.name,
          speaker: c.speaker.trim(),
        });
      const bedPath = bed ? await add(bed, "bed") : null;
      const hasScript = preview.lines.length > 0;
      if (hasScript) entries["script.txt"] = strToU8(script);
      entries["manifest.json"] = strToU8(
        JSON.stringify({
          version: 2,
          clips: manifestClips,
          bed: bedPath,
          script: hasScript ? "script.txt" : null,
          mode: hasScript ? "script" : "transcribe",
        }),
      );
      const bundle = new File(
        [new Uint8Array(zipSync(entries, { level: 0 }))],
        "studio.zip",
        { type: "application/zip" },
      );
      if (bundle.size > maxBytes)
        throw Error("The complete project exceeds your upload limit.");
      await uploadFile(path, bundle, (uploadPercent) =>
        setLive({ ...base, status: "uploading", uploadPercent }),
      );
      uploaded = true;
      setLive({ ...base, status: "starting" });
      submitted = true;
      const response = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "studio",
          file_name: name,
          input_path: path,
          settings: selection.data.settings,
        }),
      });
      if (!response.ok) {
        if ([400, 403].includes(response.status)) submitted = false;
        throw Error(
          (await response.json()).error || "Could not start Audio Studio.",
        );
      }
      const result = await response.json();
      if (typeof result.id !== "string")
        throw Error("Could not confirm the job.");
      setLive({ ...base, status: "queued", id: result.id });
      router.refresh();
    } catch (e) {
      if (uploaded && !submitted)
        try {
          await browserClient().storage.from("uploads").remove([path]);
        } catch {}
      setLive({
        ...base,
        status: "failed",
        error: submitted
          ? "Could not confirm the job. Check Recent jobs before trying again."
          : (e as Error).message,
      });
      if (submitted) router.refresh();
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  const number = (
    label: string,
    key: string,
    min: number,
    max: number,
    step = 1,
  ) => (
    <label>
      {label}
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        aria-label={label}
        placeholder={`Default (${CONTROL_DEFAULTS[key] ?? 0})`}
        value={String(choices[key] ?? "")}
        onChange={(e) => update(key, e.target.value)}
      />
      {errors[key] && <small role="alert">{errors[key]}</small>}
    </label>
  );
  const select = (label: string, key: string, values: string[]) => (
    <label>
      {label}
      <select
        aria-label={label}
        value={String(choices[key] ?? "")}
        onChange={(e) => update(key, e.target.value)}
      >
        <option value="">Select… Default ({CONTROL_DEFAULTS[key]})</option>
        {values.map((v) => (
          <option key={v} value={v}>
            {v}
          </option>
        ))}
      </select>
      {errors[key] && <small role="alert">{errors[key]}</small>}
    </label>
  );
  return (
    <div className="audio-studio">
      {!live && (
        <div className="card">
          <Visualizer compact />
          <p className="muted">
            Arrange from a script or automatically transcribe your clips.
          </p>
        </div>
      )}
      <form onSubmit={submit} noValidate>
        <fieldset disabled={locked}>
          <section className="card" aria-label="Studio files">
            <p className="eyebrow">01 · YOUR FILES</p>
            <h3>Build your session</h3>
            <p className="muted">
              Optional script + 1–200 audio/video clips; speaker labels are
              optional. Up to {Math.floor(maxBytes / 1048576)} MB total, 60
              minutes per file / 120 minutes combined. Output timing comes from
              speech and your chosen gaps.
            </p>
            <label>
              Project title (optional)
              <input
                value={title}
                maxLength={255}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Name your session"
              />
            </label>
            <div className="studio-file-grid">
              <div className="studio-file-slot">
                <label>
                  Audio clips
                  <input
                    type="file"
                    accept={accept}
                    multiple
                    onChange={(e) => {
                      changed();
                      const all = Array.from(e.target.files ?? []);
                      if (all.length + clips.length > 200) {
                        setMessage("Use at most 200 clips.");
                        return;
                      }
                      const valid = all
                        .map(media)
                        .filter((f): f is File => !!f);
                      setClips((v) => [
                        ...v,
                        ...valid.map((file) => ({ file, speaker: "" })),
                      ]);
                      e.target.value = "";
                    }}
                  />
                </label>
                {clips.map((c, i) => (
                  <div className="studio-voice" key={i}>
                    <b>{c.file.name}</b>
                    <label>
                      Speaker {i + 1} (optional)
                      <input
                        value={c.speaker}
                        maxLength={60}
                        onChange={(e) => {
                          changed();
                          setClips((v) =>
                            v.map((x, j) =>
                              j === i ? { ...x, speaker: e.target.value } : x,
                            ),
                          );
                        }}
                      />
                    </label>
                    <button
                      type="button"
                      className="btn ghost"
                      onClick={() => {
                        changed();
                        setClips((v) => v.filter((_, j) => i !== j));
                      }}
                    >
                      Remove clip {i + 1}
                    </button>
                  </div>
                ))}
              </div>
              <div className="studio-file-slot">
                <label>
                  Music/SFX bed (optional)
                  <input
                    ref={bedInput}
                    type="file"
                    accept={accept}
                    onChange={(e) => {
                      changed();
                      setBed(media(e.target.files?.[0]));
                    }}
                  />
                </label>
                {bed && (
                  <>
                    <p>{bed.name}</p>
                    <button
                      type="button"
                      className="btn ghost"
                      onClick={() => {
                        changed();
                        setBed(null);
                        if (bedInput.current) bedInput.current.value = "";
                      }}
                    >
                      Remove bed
                    </button>
                  </>
                )}
              </div>
            </div>
            <label>
              Script file (TXT, SRT or VTT, optional)
              <input
                type="file"
                accept=".txt,.srt,.vtt"
                onChange={(e) => void readScript(e.target.files?.[0])}
              />
            </label>
            <label>
              Script text
              <textarea
                rows={8}
                value={script}
                onChange={(e) => {
                  scriptRead.current++;
                  changed();
                  setScript(e.target.value);
                }}
                placeholder="NARRATOR: Every story starts with a voice."
              />
            </label>
            <p className="muted">
              {preview.lines.length
                ? `${preview.lines.length} script lines. Timestamps set order only.`
                : script.trim()
                  ? `Script ignored: ${preview.error}. Clips will be auto-transcribed.`
                  : preview.error}
            </p>
            {bytes > maxBytes && (
              <p role="alert">
                The complete project exceeds your upload limit.
              </p>
            )}
          </section>
          {clips.length > 0 && (
            <section className="card" aria-label="Processing options">
              <p className="eyebrow">02 · YOUR ARRANGEMENT</p>
              <h3>Choose your settings</h3>
              <div className="studio-options-grid">
                <label>
                  Clip placement
                  <select
                    value={String(choices.regionMode ?? "")}
                    onChange={(e) => update("regionMode", e.target.value)}
                  >
                    <option value="">Whole clips (default)</option>
                    <option value="whole_clip">Whole clips</option>
                    <option value="split_by_line">Split by line</option>
                  </select>
                </label>
                {number("Line gap (ms)", "lineGap", 0, 5000)}
                {select("Match strictness", "matchStrictness", [
                  "strict",
                  "normal",
                  "loose",
                ])}
                {number("Dialogue target (LUFS)", "dialogueLufs", -70, -5, 0.1)}
                {number("Master target (LUFS)", "masterLufs", -70, -5, 0.1)}
                {bed && (
                  <>
                    {number("Bed ducking (dB)", "duckingDb", 0, 40, 0.1)}
                    {select("Bed fit", "bedFit", ["trim", "loop", "extend"])}
                  </>
                )}
                {select("Room tone", "roomTone", ["off", "on"])}
                {choices.roomTone === "on" &&
                  number("Room tone amount (%)", "roomAmount", 0, 100)}
                {select("Subtitles", "subtitles", ["off", "on"])}
                {choices.subtitles === "on" && (
                  <div className="studio-format-choices">
                    {["srt", "vtt"].map((f) => (
                      <label key={f}>
                        <input
                          type="checkbox"
                          checked={choices[f] === true}
                          onChange={(e) => update(f, e.target.checked)}
                        />
                        {f.toUpperCase()}
                      </label>
                    ))}
                  </div>
                )}
              </div>
              <p className="muted">
                Language is checked before billing only when a script is
                present. Uncertain language results are flagged. The first
                export is included; later exports use processing minutes.
              </p>
            </section>
          )}
          <div className="processing-start">
            {message && <p role="alert">{message}</p>}
            {errors.settings && <p role="alert">{errors.settings}</p>}
            {script.trim() && preview.error && (
              <label>
                <input
                  type="checkbox"
                  checked={ignoredScript}
                  onChange={(e) => setIgnoredScript(e.target.checked)}
                />
                I confirm: ignore this script and auto-transcribe the clips.
              </label>
            )}
            <button className="btn" disabled={locked}>
              Start Processing
            </button>
            <p className="muted">{DEFAULT_HELP.studio}</p>
          </div>
        </fieldset>
      </form>
      {live && (
        <ProcessingStatus state={live} setState={setLive} type="studio" />
      )}
      {live?.status === "done" && live.id && (
        <StudioDaw
          key={live.id}
          jobId={live.id}
          lineGap={Number(choices.lineGap ?? 0) / 1000}
        />
      )}
    </div>
  );
}
