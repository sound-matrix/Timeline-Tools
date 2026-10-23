"use client";
import { useState, useRef } from "react";
import { useRouter } from "next/navigation";
import InputPreview from "./input-preview";
import { uploadFile } from "@/lib/upload";
import { browserClient } from "@/lib/supabase/client";
import { extensions, type JobType } from "@/lib/settings";
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
    if (!file || busy) return;
    setBusy(true);
    setMessage("Uploading…");
    const values = new FormData(e.currentTarget);
    const settings =
      type === "clean"
        ? {
            noise: controls ? values.has("noise") : true,
            hum: controls ? values.has("hum") : true,
            reverb: values.has("reverb"),
            voice: values.has("voice"),
            strength: Number(values.get("strength") ?? 70),
          }
        : type === "master"
          ? {
              eq: [0, 1, 2, 3, 4].map((i) => Number(values.get("eq" + i))),
              threshold: Number(values.get("threshold")),
              ratio: Number(values.get("ratio")),
              ceiling: values.get("ceiling"),
              lufs: values.get("lufs"),
            }
          : {
              language: values.get("language"),
              formats: values.getAll("formats"),
            };
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
      setMessage("Job queued. Processing will be available in Phase 1B.");
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
      <fieldset disabled={busy}>
        {controls && type === "clean" && (
          <div className="card">
            {[
              ["noise", "Noise removal", "AI background noise suppression"],
              ["hum", "De-hum", "Removes 50/60 Hz mains hum"],
              ["reverb", "De-reverb", "Reduces room echo"],
              ["voice", "Voice enhance", "Clarity and presence for dialogue"],
            ].map(([key, label, desc]) => (
              <label className="tog" key={key}>
                <span>
                  <b>{label}</b>
                  <span className="muted block">{desc}</span>
                </span>
                <input
                  type="checkbox"
                  name={key}
                  defaultChecked={["noise", "hum"].includes(key)}
                />
              </label>
            ))}
            <label>
              Strength
              <input
                name="strength"
                type="range"
                min="0"
                max="100"
                defaultValue="70"
              />
            </label>
          </div>
        )}
        {type === "master" && (
          <div className="grid">
            <div className="card">
              <h3>EQ</h3>
              <div className="eq">
                {["60Hz", "250Hz", "1k", "4k", "12k"].map((label, i) => (
                  <label key={label}>
                    <input
                      aria-label={label + " gain"}
                      name={"eq" + i}
                      type="range"
                      min="-12"
                      max="12"
                      defaultValue="0"
                    />
                    {label}
                  </label>
                ))}
              </div>
            </div>
            <div className="card">
              <h3>Dynamics</h3>
              <label>
                Compressor threshold (dB)
                <input
                  type="range"
                  name="threshold"
                  min="-40"
                  max="0"
                  defaultValue="-24"
                />
              </label>
              <label>
                Ratio
                <input
                  name="ratio"
                  type="range"
                  min="1"
                  max="10"
                  defaultValue="3"
                />
              </label>
              <label>
                Limiter / True-peak ceiling
                <select name="ceiling">
                  <option value="-1">-1.0 dBTP</option>
                  <option value="-2">-2.0 dBTP</option>
                  <option value="-0.3">-0.3 dBTP</option>
                </select>
              </label>
            </div>
            <div className="card">
              <h3>Loudness target</h3>
              <label>
                Target
                <select name="lufs">
                  <option value="-14">-14 LUFS · Streaming</option>
                  <option value="-16">-16 LUFS · Podcasts</option>
                  <option value="-23">-23 LUFS · Broadcast</option>
                </select>
              </label>
              <p className="muted">
                A real loudness report will be available after processing is
                enabled.
              </p>
            </div>
          </div>
        )}
        {type === "subtitles" && (
          <div className="card">
            <label>
              Language
              <select name="language">
                {["English", "Hindi", "Telugu", "Tamil"].map((l) => (
                  <option key={l}>{l}</option>
                ))}
              </select>
            </label>
            <div className="row">
              <label>
                <input
                  type="checkbox"
                  name="formats"
                  value="srt"
                  defaultChecked
                />{" "}
                SRT
              </label>
              <label>
                <input
                  type="checkbox"
                  name="formats"
                  value="vtt"
                  defaultChecked
                />{" "}
                VTT
              </label>
            </div>
            <p className="muted">
              Your transcript and downloads will appear when processing is
              available.
            </p>
          </div>
        )}
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
          <button className="btn" disabled={!file || busy}>
            {busy ? "Please wait…" : "Upload & queue job"}
          </button>
          <p role="status">{message}</p>
        </div>
      </fieldset>
      {controls && <InputPreview file={file} />}
    </form>
  );
}
