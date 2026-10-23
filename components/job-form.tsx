"use client";
import { useState, useRef, useId } from "react";
import { useRouter } from "next/navigation";
import StudioMotion from "./studio-motion";
import InputPreview from "./input-preview";
import ProcessingStatus from "./processing-status";
import { uploadFile } from "@/lib/upload";
import { browserClient } from "@/lib/supabase/client";
import { extensions, jobSchema, type JobType } from "@/lib/settings";
import type { ProcessingState } from "@/lib/job-status";
import ProcessingControls from "./processing-controls";
import { processingSettings, type Choices } from "@/lib/processing-form";

export default function JobForm({
  type = "clean",
  maxMb,
  userId,
}: {
  type?: JobType;
  maxMb: number;
  userId: string;
}) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const submitting = useRef(false);
  const helpId = useId();
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [over, setOver] = useState(false);
  const [live, setLive] = useState<ProcessingState | null>(null);
  const [choices, setChoices] = useState<Choices>({});
  const running = live?.status === "queued" || live?.status === "processing";
  const locked = busy || running;
  const selection = jobSchema.safeParse({
    type,
    settings: processingSettings(type, choices),
  });

  function choose(f?: File) {
    if (locked) return;
    setMessage("");
    if (!f) return;
    const ext = f.name.split(".").pop()?.toLowerCase();
    if (
      !ext ||
      !extensions.includes(ext) ||
      !f.size ||
      f.size > maxMb * 1048576
    ) {
      setFile(null);
      if (input.current) input.current.value = "";
      setMessage(
        !ext || !extensions.includes(ext)
          ? "Choose a supported audio or video file."
          : `Choose a non-empty file up to ${maxMb} MB.`,
      );
      return;
    }
    setFile(f);
  }

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!file || locked || submitting.current || !selection.success) return;
    submitting.current = true;
    setBusy(true);
    setMessage("");
    const initial = {
      fileName: file.name,
      error: null,
      downloads: [],
      durationSec: null,
    };
    setLive({ ...initial, status: "uploading", uploadPercent: 0 });
    const path = `${userId}/${crypto.randomUUID()}.${file.name.split(".").pop()!.toLowerCase()}`;
    let uploaded = false;
    // Once submission begins, a lost response may still mean the worker has the input.
    let submitted = false;
    try {
      await uploadFile(path, file, (uploadPercent) =>
        setLive({ ...initial, status: "uploading", uploadPercent }),
      );
      uploaded = true;
      setLive({ ...initial, status: "starting" });
      submitted = true;
      const res = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          file_name: file.name,
          input_path: path,
          type,
          settings: selection.data.settings,
        }),
      });
      if (!res.ok) {
        // A definitive validation failure did not queue a job. Other failures can be ambiguous.
        if (res.status === 400 || res.status === 403) submitted = false;
        const result = await res.json();
        throw new Error(result.error || "Could not start processing.");
      }
      const result = await res.json();
      if (typeof result.id !== "string")
        throw new Error(
          "Could not confirm the job. Check Recent jobs before trying again.",
        );
      setLive({ ...initial, status: "queued", id: result.id });
      router.refresh();
    } catch (error) {
      if (uploaded && !submitted) {
        try {
          await browserClient().storage.from("uploads").remove([path]);
        } catch {
          /* Retain the original error. */
        }
      }
      setLive({
        ...initial,
        status: "failed",
        error: submitted
          ? "Could not confirm the job. It may still be running. Check Recent jobs before trying again."
          : error instanceof Error
            ? error.message
            : "Upload failed. Please try again.",
      });
      if (submitted) router.refresh();
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="processing-desk">
      <StudioMotion type={type} active={live !== null} />
      <form onSubmit={submit}>
        <fieldset disabled={locked}>
          <section className="card upload-card" aria-label="Upload file">
            <p className="eyebrow">01 · YOUR FILE</p>
            <div
              role="button"
              aria-disabled={locked}
              tabIndex={locked ? -1 : 0}
              className={"drop" + (over ? " over" : "")}
              onClick={() => {
                if (!locked) input.current?.click();
              }}
              onKeyDown={(e) => {
                if (!locked && (e.key === "Enter" || e.key === " ")) {
                  e.preventDefault();
                  input.current?.click();
                }
              }}
              onDragOver={(e) => {
                e.preventDefault();
                if (!locked) setOver(true);
              }}
              onDragLeave={() => setOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setOver(false);
                choose(e.dataTransfer.files[0]);
              }}
            >
              <b>
                {file
                  ? file.name
                  : "Drag & drop audio or video here, or click to choose"}
              </b>
              <p className="muted">
                {extensions.join(", ").toUpperCase()} · up to {maxMb} MB
              </p>
            </div>
            <input
              aria-label="Choose audio or video"
              ref={input}
              type="file"
              accept={extensions.map((e) => "." + e).join(",")}
              onChange={(e) => choose(e.target.files?.[0])}
            />
            {message && <p role="alert">{message}</p>}
            {file && <InputPreview file={file} />}
          </section>
          {file && (
            <section
              aria-label="Processing options"
              className="processing-options"
            >
              <p className="eyebrow">02 · PROCESSING</p>
              <h3>Your processing desk</h3>
              <p className="muted">
                Enable the processes you need. Every setting is your choice.
              </p>
              <ProcessingControls
                type={type}
                values={choices}
                setValues={setChoices}
              />
            </section>
          )}
          <div className="processing-start">
            <button
              className="btn"
              disabled={!file || locked || !selection.success}
              aria-describedby={helpId}
            >
              {live?.status === "uploading" && busy
                ? "Uploading…"
                : busy || live?.status === "queued"
                  ? "Starting…"
                  : running
                    ? "Processing…"
                    : "Start Processing"}
            </button>
            <p id={helpId} className="muted">
              {!file
                ? "Choose a file to continue."
                : !selection.success
                  ? "Select your options above."
                  : locked
                    ? "Your processing session is active below."
                    : "Your selected options are ready."}
            </p>
          </div>
        </fieldset>
      </form>
      {live && <ProcessingStatus state={live} setState={setLive} type={type} />}
    </div>
  );
}
