"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { extensions, jobSchema } from "@/lib/settings";
import { processingSettings, type Choices } from "@/lib/processing-form";
import {
  alignmentReportSchema,
  parseScript,
  SCRIPT_MAX_BYTES,
  STUDIO_MAX_BYTES,
  subtitleText,
  type AlignmentReport,
} from "@/lib/audio-studio";
import { uploadFile } from "@/lib/upload";
import { browserClient } from "@/lib/supabase/client";
import type { ProcessingState } from "@/lib/job-status";
import ProcessingStatus from "./processing-status";
import StudioTimeline from "./studio-timeline";
import InputPreview from "./input-preview";

type Voice = { file: File; speaker: string };
const accept = extensions.map((ext) => `.${ext}`).join(",");
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
  const [guide, setGuide] = useState<File | null>(null);
  const [voices, setVoices] = useState<Voice[]>([]);
  const [bed, setBed] = useState<File | null>(null);
  const [script, setScript] = useState("");
  const [title, setTitle] = useState("");
  const [choices, setChoices] = useState<Choices>({});
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState<ProcessingState | null>(initial);
  const [report, setReport] = useState<AlignmentReport | null>(null);
  const [reportError, setReportError] = useState("");
  const [retry, setRetry] = useState(0);
  const running = live?.status === "queued" || live?.status === "processing";
  const locked = busy || running;
  const maxBytes = Math.min(maxMb * 1048576, STUDIO_MAX_BYTES);
  const preview = useMemo(() => {
    try {
      return { lines: parseScript(script), error: "" };
    } catch (error) {
      return {
        lines: [],
        error: script.trim()
          ? (error as Error).message
          : "Add your script to continue.",
      };
    }
  }, [script]);
  const labels = voices.map((v) => v.speaker.trim().toLocaleLowerCase());
  const speakerError =
    voices.length > 1 &&
    (labels.some((s) => !s) || new Set(labels).size !== labels.length)
      ? "Give each voice stem a unique speaker label matching the script."
      : labels.some(Boolean) &&
          preview.lines.some(
            (l) => !labels.includes(l.speaker.toLocaleLowerCase()),
          )
        ? "Match every script speaker to a voice stem label."
        : "";
  const bytes =
    (guide?.size ?? 0) +
    voices.reduce((n, v) => n + v.file.size, 0) +
    (bed?.size ?? 0) +
    new TextEncoder().encode(script).length +
    16384;
  const filesReady =
    !!guide &&
    voices.length > 0 &&
    preview.lines.length > 0 &&
    !speakerError &&
    bytes <= maxBytes;
  const selection = jobSchema.safeParse({
    type: "studio",
    settings: processingSettings("studio", { ...choices, hasBed: !!bed }),
  });
  const showDesk = !!guide && voices.length > 0 && preview.lines.length > 0;
  const doneId = live?.status === "done" ? live.id : undefined;
  useEffect(() => {
    if (!doneId) return;
    const controller = new AbortController();
    setReportError("");
    void (async () => {
      try {
        const response = await fetch(`/api/jobs/${doneId}/alignment`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok || response.redirected)
          throw new Error(
            "Could not load the alignment table. Your downloads are still available below.",
          );
        const parsed = alignmentReportSchema.safeParse(await response.json());
        if (!parsed.success)
          throw new Error(
            "Alignment report could not be read. Download the JSON report to review it.",
          );
        if (!controller.signal.aborted) setReport(parsed.data);
      } catch (error) {
        if (!controller.signal.aborted)
          setReportError((error as Error).message);
      }
    })();
    return () => controller.abort();
  }, [doneId, retry]);

  function changed() {
    setReport(null);
    setLive(null);
    setMessage("");
    setReportError("");
  }
  function media(file?: File) {
    if (!file) return null;
    if (
      !extensions.includes(file.name.split(".").pop()?.toLowerCase() ?? "") ||
      !file.size ||
      file.size > maxBytes
    ) {
      setMessage(
        `Choose non-empty audio/video files. Complete projects must fit within ${Math.floor(maxBytes / 1048576)} MB.`,
      );
      return null;
    }
    return file;
  }
  function update(key: string, value: string | boolean) {
    setChoices((v) => ({ ...v, [key]: value }));
  }
  async function readScript(file?: File) {
    const version = ++scriptRead.current;
    if (!file) return;
    if (file.size > SCRIPT_MAX_BYTES || !/\.(txt|srt|vtt)$/i.test(file.name)) {
      setMessage("Choose a TXT, SRT or VTT script up to 64 KB.");
      return;
    }
    try {
      const text = await file.text();
      if (version !== scriptRead.current) return;
      changed();
      setScript(text);
    } catch {
      setMessage("Could not read the script file.");
    }
  }
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (
      !guide ||
      !filesReady ||
      !selection.success ||
      locked ||
      submitting.current
    )
      return;
    submitting.current = true;
    setBusy(true);
    setMessage("");
    setReport(null);
    setReportError("");
    const name = title.trim() || guide.name;
    const initialState = {
      fileName: name,
      error: null,
      durationSec: null,
      downloads: [],
    };
    setLive({ ...initialState, status: "starting" });
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
      const guidePath = await add(guide, "guide");
      const voicePaths = [];
      for (const [i, voice] of voices.entries())
        voicePaths.push({
          file: await add(voice.file, `voice-${i}`),
          speaker: voice.speaker.trim(),
          name: voice.file.name,
        });
      const bedPath = bed ? await add(bed, "bed") : null;
      entries["script.txt"] = strToU8(script);
      entries["manifest.json"] = strToU8(
        JSON.stringify({
          version: 1,
          guide: guidePath,
          voices: voicePaths,
          bed: bedPath,
          script: "script.txt",
        }),
      );
      // Stored ZIP avoids wasting CPU recompressing media; extraction is strictly bounded.
      const packed = zipSync(entries, { level: 0 });
      const bundle = new File([new Uint8Array(packed)], "studio.zip", {
        type: "application/zip",
      });
      if (bundle.size > maxBytes)
        throw new Error("The complete project exceeds your upload limit.");
      await uploadFile(path, bundle, (uploadPercent) =>
        setLive({ ...initialState, status: "uploading", uploadPercent }),
      );
      uploaded = true;
      setLive({ ...initialState, status: "starting" });
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
        const result = await response.json();
        throw new Error(result.error || "Could not start Audio Studio.");
      }
      const result = await response.json();
      if (typeof result.id !== "string")
        throw new Error("Could not confirm the job.");
      setLive({ ...initialState, status: "queued", id: result.id });
      router.refresh();
    } catch (error) {
      if (uploaded && !submitted) {
        try {
          await browserClient().storage.from("uploads").remove([path]);
        } catch {
          /* Keep original error. */
        }
      }
      setLive({
        ...initialState,
        status: "failed",
        error: submitted
          ? "Could not confirm the job. It may still be running. Check Recent jobs before trying again."
          : (error as Error).message,
      });
      if (submitted) router.refresh();
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  const selectedFormats =
    choices.subtitles === "on"
      ? (["srt", "vtt"] as const).filter((f) => choices[f] === true)
      : report && choices.subtitles === undefined
        ? (["srt", "vtt"] as const).filter((f) =>
            live?.downloads.some(
              (d) => d.label === `Download ${f.toUpperCase()}`,
            ),
          )
        : [];
  const exportLines = report?.lines ?? preview.lines;
  const canExportScript =
    selectedFormats.length > 0 &&
    exportLines.length > 0 &&
    exportLines.every((l) => l.start !== undefined);
  function exportScript() {
    for (const format of selectedFormats) {
      const url = URL.createObjectURL(
        new Blob([subtitleText(exportLines, format)], {
          type: "text/plain;charset=utf-8",
        }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = `${report ? "aligned" : "script"}.${format}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  }
  const mixHref =
    live?.status === "done"
      ? live.downloads.find((d) => d.label === "Download WAV")?.href
      : undefined;
  return (
    <div className="audio-studio">
      <form onSubmit={submit}>
        <fieldset disabled={locked}>
          <section className="card" aria-label="Studio files">
            <p className="eyebrow">01 · YOUR FILES</p>
            <h3>Build your session</h3>
            <p className="muted">
              One guide + up to eight voice stems. Optional music/SFX bed. Up to{" "}
              {Math.floor(maxBytes / 1048576)} MB total; 60 minutes per file and
              120 minutes combined. Minutes are charged once by guide duration.
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
                  Guide track
                  <input
                    type="file"
                    accept={accept}
                    onChange={(e) => {
                      changed();
                      setGuide(media(e.target.files?.[0]));
                    }}
                  />
                </label>
                <small className="muted">
                  Audio or video · timing reference, excluded from the mix
                </small>
                {guide && <InputPreview file={guide} />}
              </div>
              <div className="studio-file-slot">
                <label>
                  Voice / dub tracks
                  <input
                    type="file"
                    accept={accept}
                    multiple
                    onChange={(e) => {
                      changed();
                      const files = Array.from(e.target.files ?? []);
                      if (files.length > 8) {
                        setVoices([]);
                        setMessage("Choose up to eight voice tracks.");
                        return;
                      }
                      const checked = files.map(media);
                      setVoices(
                        checked.every(Boolean)
                          ? checked.map((file) => ({
                              file: file!,
                              speaker: "",
                            }))
                          : [],
                      );
                    }}
                  />
                </label>
                {voices.map((voice, i) => (
                  <div className="studio-voice" key={i}>
                    <b>{voice.file.name}</b>
                    <label>
                      Speaker label for voice {i + 1}
                      <input
                        value={voice.speaker}
                        maxLength={60}
                        placeholder="e.g. Narrator"
                        onChange={(e) => {
                          changed();
                          setVoices((v) =>
                            v.map((item, j) =>
                              j === i
                                ? { ...item, speaker: e.target.value }
                                : item,
                            ),
                          );
                        }}
                      />
                    </label>
                  </div>
                ))}
                <small className="muted">
                  For multiple stems, match each speaker label exactly to the
                  script. One unlabeled stem can contain all dialogue in script
                  order.
                </small>
              </div>
            </div>
            <label>
              Music / SFX bed (optional)
              <input
                type="file"
                accept={accept}
                onChange={(e) => {
                  changed();
                  setBed(media(e.target.files?.[0]));
                }}
              />
            </label>
            {bed && (
              <button
                type="button"
                className="btn ghost sm"
                onClick={() => {
                  changed();
                  setBed(null);
                }}
              >
                Remove bed
              </button>
            )}
            <div className="studio-script-input">
              <label>
                Import script (TXT / SRT / VTT)
                <input
                  type="file"
                  accept=".txt,.srt,.vtt"
                  onChange={(e) => void readScript(e.target.files?.[0])}
                />
              </label>
              <label>
                Script
                <textarea
                  rows={6}
                  value={script}
                  onChange={(e) => {
                    scriptRead.current++;
                    changed();
                    setScript(e.target.value);
                  }}
                  placeholder={
                    "Narrator: A new day begins.\nMeera: I am ready."
                  }
                />
              </label>
              <small className="muted">
                UTF-8 · up to 64 KB / 300 lines. Existing SRT/VTT timing is
                treated as guide timing.
              </small>
            </div>
            {(message ||
              (script.trim() && preview.error) ||
              speakerError ||
              bytes > maxBytes) && (
              <p role="alert">
                {message ||
                  preview.error ||
                  speakerError ||
                  "Your complete project exceeds the upload limit."}
              </p>
            )}
          </section>
        </fieldset>
        {(showDesk || report) && (
          <StudioTimeline
            report={report}
            lines={preview.lines}
            voices={voices.map((v) => ({
              name: v.file.name,
              speaker: v.speaker,
            }))}
            guide={guide?.name ?? ""}
            bed={bed?.name}
            state={live?.status}
            mixHref={mixHref}
          />
        )}
        <fieldset disabled={locked}>
          {showDesk && (
            <section
              className="card studio-options"
              aria-label="Auto-mix settings"
            >
              <p className="eyebrow">03 · YOUR MIX</p>
              <h3>Auto-mix settings</h3>
              <p className="muted">
                Choose every process. Presets fill only the field you select.
                Final loudness uses a 0 dBTP safety bound.
              </p>
              <div className="studio-options-grid">
                <div>
                  <label>
                    Dialogue level (LUFS)
                    <input
                      type="number"
                      step="0.1"
                      min={-70}
                      max={-5}
                      value={String(choices.dialogueLufs ?? "")}
                      onChange={(e) => update("dialogueLufs", e.target.value)}
                    />
                  </label>
                  <div className="studio-presets">
                    {[
                      ["Podcast", -16],
                      ["Broadcast", -23],
                      ["Film", -24],
                    ].map(([name, n]) => (
                      <button
                        type="button"
                        className="btn ghost sm"
                        key={name}
                        onClick={() => update("dialogueLufs", String(n))}
                      >
                        {name} {n}
                      </button>
                    ))}
                  </div>
                </div>
                <label>
                  Final master target (LUFS)
                  <input
                    type="number"
                    step="0.1"
                    min={-70}
                    max={-5}
                    value={String(choices.masterLufs ?? "")}
                    onChange={(e) => update("masterLufs", e.target.value)}
                  />
                </label>
                {bed && (
                  <label>
                    Music ducking (dB)
                    <input
                      type="number"
                      min={0}
                      max={40}
                      step="0.1"
                      value={String(choices.duckingDb ?? "")}
                      onChange={(e) => update("duckingDb", e.target.value)}
                    />
                    <small>0 dB keeps the bed level unchanged.</small>
                  </label>
                )}
                <div>
                  <label>
                    Room tone fill
                    <select
                      value={String(choices.roomTone ?? "")}
                      onChange={(e) => update("roomTone", e.target.value)}
                    >
                      <option value="">Choose…</option>
                      <option value="off">Off</option>
                      <option value="on">Choose amount</option>
                    </select>
                  </label>
                  {choices.roomTone === "on" && (
                    <label>
                      Room tone amount (%)
                      <input
                        type="number"
                        min={0}
                        max={100}
                        step="1"
                        value={String(choices.roomAmount ?? "")}
                        onChange={(e) => update("roomAmount", e.target.value)}
                      />
                      <small>
                        Fills dialogue gaps from a quiet guide region, if
                        available.
                      </small>
                    </label>
                  )}
                </div>
                <div>
                  <label>
                    Subtitles from script
                    <select
                      value={String(choices.subtitles ?? "")}
                      onChange={(e) => update("subtitles", e.target.value)}
                    >
                      <option value="">Choose…</option>
                      <option value="off">Off</option>
                      <option value="on">On</option>
                    </select>
                  </label>
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
              </div>
            </section>
          )}
          <div className="processing-start">
            <div className="studio-actions">
              <button
                className="btn"
                disabled={!filesReady || !selection.success || locked}
                aria-describedby="studio-help"
              >
                {busy
                  ? "Preparing session…"
                  : running
                    ? "Processing…"
                    : "Auto-mix & Master"}
              </button>
              <button
                type="button"
                className="btn ghost"
                disabled={!canExportScript || locked}
                onClick={exportScript}
              >
                Export SRT / VTT
              </button>
            </div>
            <p id="studio-help" className="muted">
              {!filesReady
                ? "Add guide, voice tracks and a valid script to continue."
                : !selection.success
                  ? "Select your options above."
                  : locked
                    ? "Follow your live session below."
                    : "Your selected options are ready."}
            </p>
            <p className="muted">
              Timed scripts can be exported before mixing. For plain text,
              aligned subtitle downloads appear after processing. Heuristic
              alignment requires review and cannot guarantee ±150 ms accuracy.
            </p>
          </div>
        </fieldset>
      </form>
      {reportError && (
        <div className="card" role="alert">
          <p>{reportError}</p>
          <button
            type="button"
            className="btn ghost"
            onClick={() => setRetry((n) => n + 1)}
          >
            Retry alignment table
          </button>
        </div>
      )}
      {live && (
        <ProcessingStatus state={live} setState={setLive} type="studio" />
      )}
    </div>
  );
}
