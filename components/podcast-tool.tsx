"use client";
import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { extensions, jobSchema } from "@/lib/settings";
import { withDefaults, DEFAULT_HELP } from "@/lib/defaults";
import { processingSettings, type Choices } from "@/lib/processing-form";
import { fieldErrors } from "@/lib/validation";
import { uploadFile } from "@/lib/upload";
import { browserClient } from "@/lib/supabase/client";
import type { ProcessingState } from "@/lib/job-status";
import ProcessingControls from "./processing-controls";
import ProcessingStatus from "./processing-status";
import PodcastEditor from "./podcast-editor";
export default function PodcastTool({
  userId,
  maxMb,
  initial,
}: {
  userId: string;
  maxMb: number;
  initial: ProcessingState | null;
}) {
  const router = useRouter(),
    submitting = useRef(false);
  const [clientReady, setClientReady] = useState(false);
  useEffect(() => setClientReady(true), []);
  const [files, setFiles] = useState<File[]>([]),
    [choices, setChoices] = useState<Choices>({}),
    [mics, setMics] = useState(false),
    [offsets, setOffsets] = useState<Record<number, string>>({}),
    [speakers, setSpeakers] = useState(""),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [errors, setErrors] = useState<Record<string, string>>({}),
    [live, setLive] = useState(initial);
  const locked =
    busy || live?.status === "queued" || live?.status === "processing";
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (locked || submitting.current) return;
    setErrors({});
    setMessage("");
    if (!files.length) {
      setMessage("Choose at least one audio or video file.");
      return;
    }
    const limit = maxMb * 1048576;
    if (
      files.length > 200 ||
      files.some(
        (f) =>
          !f.size ||
          !extensions.includes(f.name.split(".").pop()?.toLowerCase() ?? ""),
      ) ||
      files.reduce((n, f) => n + f.size, 0) + 65536 > limit
    ) {
      setMessage(
        `Use supported audio/video files, up to ${Math.floor(limit / 1048576)} MB total and 200 files.`,
      );
      return;
    }
    if (
      mics &&
      files.some(
        (_, i) =>
          offsets[i] !== undefined &&
          offsets[i].trim() !== "" &&
          (!Number.isFinite(Number(offsets[i])) ||
            Number(offsets[i]) < 0 ||
            Number(offsets[i]) > 3600),
      )
    ) {
      setMessage("Mic offsets must be between 0 and 3600 seconds.");
      return;
    }
    const raw = {
      mode: mics ? "mics" : "sequential",
      cleanup: processingSettings("clean", choices),
      ...(speakers.trim() ? { speakers: Number(speakers) } : {}),
    };
    const parsed = jobSchema.safeParse({
      type: "podcast",
      settings: withDefaults("podcast", raw),
    });
    if (!parsed.success) {
      setErrors(
        fieldErrors(
          parsed.error.issues.map((i) => ({
            ...i,
            path: i.path.filter((p) => p !== "cleanup"),
          })),
        ),
      );
      setMessage("Check the highlighted processing settings.");
      return;
    }
    submitting.current = true;
    setBusy(true);
    const base = {
      fileName: files
        .map((f) => f.name)
        .join(", ")
        .slice(0, 255),
      error: null,
      durationSec: null,
      downloads: [],
    };
    const path = `${userId}/${crypto.randomUUID()}.zip`;
    const uploaded: string[] = [];
    let submitted = false;
    try {
      setLive({ ...base, status: "starting" });
      const { zipSync, strToU8 } = await import("fflate");
      const entries: Record<string, Uint8Array> = {},
        media = [];
      // Upload recordings directly with the existing resumable uploader. The ZIP
      // holds only references; long video is never copied into browser memory.
      for (const [i, f] of files.entries()) {
        const key = `${crypto.randomUUID()}.${f.name.split(".").pop()!.toLowerCase()}`;
        const mediaPath = `${userId}/${key}`;
        uploaded.push(mediaPath);
        await uploadFile(mediaPath, f, (percent) =>
          setLive({
            ...base,
            status: "uploading",
            uploadPercent: Math.round(
              ((i + percent / 100) / (files.length + 1)) * 100,
            ),
          }),
        );
        media.push({
          file: key,
          name: f.name,
          offset: mics ? Number(offsets[i] ?? 0) : 0,
          storage_path: mediaPath,
        });
      }
      entries["manifest.json"] = strToU8(
        JSON.stringify({ version: 2, mode: raw.mode, media }),
      );
      const bundle = new File(
        [new Uint8Array(zipSync(entries, { level: 0 }))],
        "podcast.zip",
        { type: "application/zip" },
      );
      if (bundle.size > limit)
        throw Error("The complete session exceeds your plan upload limit.");
      uploaded.push(path);
      await uploadFile(path, bundle, (uploadPercent) =>
        setLive({ ...base, status: "uploading", uploadPercent }),
      );
      setLive({ ...base, status: "starting" });
      submitted = true;
      const response = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "podcast",
          settings: parsed.data.settings,
          file_name: base.fileName,
          input_path: path,
        }),
      });
      if (!response.ok) {
        if ([400, 403].includes(response.status)) submitted = false;
        throw Error((await response.json()).error ?? "Could not start Podcast");
      }
      const result = await response.json();
      if (typeof result.id !== "string")
        throw Error("Could not confirm the job");
      setLive({ ...base, status: "queued", id: result.id });
      router.refresh();
    } catch (e) {
      if (uploaded.length && !submitted)
        try {
          await browserClient().storage.from("uploads").remove(uploaded);
        } catch {}
      setLive({
        ...base,
        status: "failed",
        error: submitted
          ? "Could not confirm the job. Check Recent jobs before trying again."
          : (e as Error).message,
      });
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="processing-desk">
      <details open={live?.status !== "done"}>
        <summary>Recordings and clean-up</summary>
        <form data-client-ready={clientReady} onSubmit={submit} noValidate>
          <fieldset disabled={locked}>
            <section className="card">
              <p className="eyebrow">01 · RECORDINGS</p>
              <label>
                Audio or video recordings
                <input
                  type="file"
                  multiple
                  accept={extensions.map((e) => "." + e).join(",")}
                  onChange={(e) => {
                    setFiles(Array.from(e.target.files ?? []));
                    setLive(null);
                    setMessage("");
                  }}
                />
              </label>
              <p className="muted">
                Up to {maxMb} MB combined, following your plan. Available
                minutes apply at processing; the editor supports sessions up to
                four hours. No script needed. Files play in upload order.
              </p>
              <label>
                <input
                  type="checkbox"
                  checked={mics}
                  onChange={(e) => setMics(e.target.checked)}
                />
                These are separate mics of the same session
              </label>
              {files.map((f, i) => (
                <div key={i} className="row">
                  <span>
                    {i + 1}. {f.name}
                  </span>
                  {mics && (
                    <label>
                      Mic {i + 1} offset (seconds)
                      <input
                        type="number"
                        value={offsets[i] ?? ""}
                        placeholder="Default (0)"
                        onChange={(e) =>
                          setOffsets((v) => ({ ...v, [i]: e.target.value }))
                        }
                      />
                    </label>
                  )}
                </div>
              ))}
              <label>
                Number of speakers
                <input
                  type="number"
                  value={speakers}
                  placeholder="Default (auto)"
                  min={1}
                  max={12}
                  onChange={(e) => setSpeakers(e.target.value)}
                />
                {errors.speakers && (
                  <small role="alert">{errors.speakers}</small>
                )}
              </label>
            </section>
            {files.length > 0 && (
              <section aria-label="Processing options">
                <p className="eyebrow">02 · CLEAN-UP</p>
                <ProcessingControls
                  type="clean"
                  values={choices}
                  setValues={setChoices}
                  errors={errors}
                />
              </section>
            )}
            <div className="processing-start">
              {message && <p role="alert">{message}</p>}
              {errors.settings && <p role="alert">{errors.settings}</p>}
              <button className="btn" disabled={locked}>
                {locked ? "Processing…" : "Start Processing"}
              </button>
              <p className="muted">
                {DEFAULT_HELP.clean} Speaker count defaults to automatic
                detection.
              </p>
            </div>
          </fieldset>
        </form>
      </details>
      {live && (
        <ProcessingStatus type="podcast" state={live} setState={setLive} />
      )}{" "}
      {live?.status === "done" && live.id && (
        <PodcastEditor key={live.id} jobId={live.id} />
      )}
    </div>
  );
}
