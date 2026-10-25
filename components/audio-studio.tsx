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
import StudioResult from "./studio-result";
import { ClipPreview, ClipDuration } from "./studio-clip-preview";
import ProcessingStatus from "./processing-status";
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
  const clipsInput = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState<File | null>(null);
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
  function addClips(files: File[]) {
    if (locked) return;
    if (files.length + clips.length > 200) {
      setMessage("Use at most 200 clips.");
      return;
    }
    changed();
    const valid = files.map(media).filter((file): file is File => !!file);
    setClips((current) => [
      ...current,
      ...valid.map((file) => ({ file, speaker: "" })),
    ]);
  }
  const previewFile =
    selected && clips.some((clip) => clip.file === selected)
      ? selected
      : (clips[0]?.file ?? null);
  return (
    <div className="audio-studio studio-simple">
      <StudioResult
        key={live?.status === "done" ? live.id : "pending"}
        job={live}
        controls={
          <>
            <form
              onSubmit={submit}
              noValidate
              className="card studio-upload-form"
            >
              <fieldset disabled={locked}>
                <div
                  className="studio-upload-drop"
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    addClips(Array.from(e.dataTransfer.files));
                  }}
                >
                  <p className="eyebrow">START WITH YOUR SOUND</p>
                  <button
                    className="btn"
                    type="button"
                    onClick={() => clipsInput.current?.click()}
                  >
                    Upload audio clips
                  </button>
                  <input
                    ref={clipsInput}
                    tabIndex={-1}
                    className="studio-hidden-input"
                    type="file"
                    accept={accept}
                    multiple
                    aria-label="Audio clips"
                    onChange={(e) => {
                      addClips(Array.from(e.target.files ?? []));
                      e.target.value = "";
                    }}
                  />
                  <p className="muted">
                    Drop files here or choose multiple clips.
                  </p>
                  <small className="muted">
                    Up to 200 clips · {Math.floor(maxBytes / 1048576)} MB total
                  </small>
                </div>
              </fieldset>
              <ClipPreview file={previewFile} />
              {message && <p role="alert">{message}</p>}
              {errors.settings && <p role="alert">{errors.settings}</p>}
              <button className="btn studio-submit" disabled={locked}>
                Submit
              </button>
              <p className="muted">
                Leave settings blank to use the studio defaults. Your first
                audio export is included.
              </p>
              <details className="studio-optional">
                <summary>Optional script &amp; processing settings</summary>
                <fieldset disabled={locked}>
                  <label>
                    Project title (optional)
                    <input
                      value={title}
                      maxLength={255}
                      onChange={(e) => setTitle(e.target.value)}
                      placeholder="Name your session"
                    />
                  </label>
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
                  {clips.length > 0 && (
                    <section className="card" aria-label="Processing options">
                      <p className="eyebrow">02 · YOUR ARRANGEMENT</p>
                      <h3>Choose your settings</h3>
                      <div className="studio-options-grid">
                        <label>
                          Clip placement
                          <select
                            value={String(choices.regionMode ?? "")}
                            onChange={(e) =>
                              update("regionMode", e.target.value)
                            }
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
                        {number(
                          "Dialogue target (LUFS)",
                          "dialogueLufs",
                          -70,
                          -5,
                          0.1,
                        )}
                        {number(
                          "Master target (LUFS)",
                          "masterLufs",
                          -70,
                          -5,
                          0.1,
                        )}
                        {bed && (
                          <>
                            {number(
                              "Bed ducking (dB)",
                              "duckingDb",
                              0,
                              40,
                              0.1,
                            )}
                            {select("Bed fit", "bedFit", [
                              "trim",
                              "loop",
                              "extend",
                            ])}
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
                        present. Uncertain language results are flagged. The
                        first export is included; later exports use processing
                        minutes.
                      </p>
                    </section>
                  )}

                  {script.trim() && preview.error && (
                    <label>
                      <input
                        type="checkbox"
                        checked={ignoredScript}
                        onChange={(e) => setIgnoredScript(e.target.checked)}
                      />
                      I confirm: ignore this script and auto-transcribe the
                      clips.
                    </label>
                  )}
                  <p className="muted">{DEFAULT_HELP.studio}</p>
                </fieldset>
              </details>
            </form>
            {live && live.status !== "done" && (
              <ProcessingStatus state={live} setState={setLive} type="studio" />
            )}
          </>
        }
        clipsPanel={
          <section
            className="card studio-uploaded"
            aria-label="Audio clips uploaded"
          >
            <p className="eyebrow">YOUR SESSION</p>
            <h3>
              Audio clips uploaded{" "}
              <span className="studio-clip-count">{clips.length}</span>
            </h3>
            {clips.length ? (
              <ol className="studio-uploaded-list">
                {clips.map((clip, i) => (
                  <li key={i}>
                    <button
                      type="button"
                      className="studio-select-clip"
                      aria-label={`Preview ${clip.file.name}, clip ${i + 1}`}
                      aria-pressed={previewFile === clip.file}
                      onClick={() => setSelected(clip.file)}
                    >
                      <span>{String(i + 1).padStart(2, "0")}</span>
                      <span>
                        <b>{clip.file.name}</b>
                        <ClipDuration file={clip.file} />
                      </span>
                    </button>
                    <button
                      type="button"
                      className="btn ghost sm"
                      disabled={locked}
                      aria-label={`Remove clip ${i + 1}: ${clip.file.name}`}
                      onClick={() => {
                        changed();
                        setClips((current) =>
                          current.filter((_, j) => j !== i),
                        );
                      }}
                    >
                      Remove
                    </button>
                    <details>
                      <summary>Speaker label (optional)</summary>
                      <label>
                        Speaker {i + 1} (optional)
                        <input
                          value={clip.speaker}
                          disabled={locked}
                          maxLength={60}
                          onChange={(e) => {
                            changed();
                            setClips((current) =>
                              current.map((c, j) =>
                                j === i ? { ...c, speaker: e.target.value } : c,
                              ),
                            );
                          }}
                        />
                      </label>
                    </details>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="muted">
                Your clips will appear here. Select a clip to preview it.
              </p>
            )}
          </section>
        }
      />
    </div>
  );
}
