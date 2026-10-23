"use client";
import { useState, useRef } from "react";
import { useRouter } from "next/navigation";
import StudioMotion from "./studio-motion";
import InputPreview from "./input-preview";
import { uploadFile } from "@/lib/upload";
import { browserClient } from "@/lib/supabase/client";
import { extensions, jobSchema, type JobType } from "@/lib/settings";
import ProcessingControls from "./processing-controls";
import { processingSettings, type Choices } from "@/lib/processing-options";
export default function JobForm({
  type = "clean",
  maxMb,
  userId,
  controls = true,
}: {
  type?: JobType;
  maxMb: number;
  userId: string;
  controls?: boolean;
}) {
  const router = useRouter(),
    input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [over, setOver] = useState(false);
  const [choices, setChoices] = useState<Choices>({});
  const settings = processingSettings(type, choices);
  const valid = jobSchema.safeParse({ type, settings }).success;
  function setValue(key: string, value: string | boolean) {
    setChoices((previous) => ({ ...previous, [key]: value }));
  }
  function choose(f?: File) {
    setMessage("");
    if (!f) return;
    const ext = f.name.split(".").pop()?.toLowerCase();
    if (!ext || !extensions.includes(ext)) {
      setMessage("Choose a supported audio or video file.");
      return;
    }
    if (!f.size || f.size > maxMb * 1048576) {
      setMessage(`Choose a non-empty file up to ${maxMb} MB.`);
      return;
    }
    setFile(f);
  }
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!valid) {
      setMessage("Select your options above.");
      return;
    }
    if (!file || busy) return;
    setBusy(true);
    setMessage("Uploading…");
    const db = browserClient(),
      path = `${userId}/${crypto.randomUUID()}.${file.name.split(".").pop()!.toLowerCase()}`;
    let uploaded = false;
    try {
      await uploadFile(path, file, (p) => setMessage(`Uploading… ${p}%`));
      uploaded = true;
      setMessage("Saving job…");
      const res = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          file_name: file.name,
          input_path: path,
          type,
          settings,
        }),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || "Could not create job");
      setFile(null);
      if (input.current) input.current.value = "";
      setMessage(
        "Queued. Your worker will pick this up shortly. Follow progress in Recent jobs.",
      );
      router.refresh();
    } catch (error) {
      if (uploaded) await db.storage.from("uploads").remove([path]);
      setMessage(
        error instanceof Error
          ? error.message
          : "Upload failed. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit}>
      {controls && <StudioMotion type={type} />}
      <fieldset disabled={busy}>
        <ProcessingControls type={type} values={choices} setValue={setValue} />
        <div className="card">
          <div
            role="button"
            tabIndex={busy ? -1 : 0}
            className={"drop" + (over ? " over" : "")}
            onClick={() => input.current?.click()}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                input.current?.click();
              }
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setOver(false);
              if (!busy) choose(e.dataTransfer.files[0]);
            }}
          >
            {file
              ? file.name
              : "Drag & drop audio or video here, or click to choose"}
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
          <button
            className="btn"
            disabled={!file || busy || !valid}
            aria-describedby="options-status"
          >
            {busy ? "Please wait…" : "Upload & queue job"}
          </button>
          <p id="options-status">
            {!valid
              ? "Select your options above."
              : !file
                ? "Choose a file to continue."
                : "Your options are ready."}
          </p>
          <p role="status">{message}</p>
        </div>
      </fieldset>
      {controls && <InputPreview file={file} />}
    </form>
  );
}
