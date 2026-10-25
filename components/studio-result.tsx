"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { arrangementSchema } from "@/lib/arrangement";
import { withDefaults } from "@/lib/defaults";
import type { ProcessingState } from "@/lib/job-status";
import {
  jsonCues,
  serializeSubtitles,
  subtitleFilename,
  type Cue,
} from "@/lib/subtitles";
import { editedStudioCues } from "@/lib/studio-result";
import OpenEditor from "./editor/open-editor";
import ProcessingStatus from "./processing-status";

async function get(url: string) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok)
    throw Error(
      (await response.json()).error || "Could not load results. Please retry.",
    );
  return response.json();
}

export default function StudioResult({
  job,
  controls,
  clipsPanel,
}: {
  job: ProcessingState | null;
  controls: ReactNode;
  clipsPanel: ReactNode;
}) {
  const id = job?.status === "done" ? job.id : undefined;
  // The keyed parent remounts for a new completed job. Retain this promise across
  // Strict Mode's effect replay so it cannot queue the included export twice.
  const preparation = useRef<Promise<ProcessingState | null> | null>(null);
  const [result, setResult] = useState<ProcessingState | null>(null);
  const [audioError, setAudioError] = useState("");
  const [cues, setCues] = useState<Cue[] | null>(null);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [notice, setNotice] = useState("");
  const [loadError, setLoadError] = useState("");
  const [retry, setRetry] = useState(0);
  const [audioRetry, setAudioRetry] = useState(0);
  const [playerError, setPlayerError] = useState(false);
  useEffect(() => {
    if (!id) return;
    let disposed = false;
    setLoadError("");
    get(`/api/jobs/${id}/subtitles`)
      .then((data) => {
        if (!disposed) setCues(jsonCues(data.cues));
      })
      .catch((error) => {
        if (!disposed) setLoadError(error.message);
      });
    return () => {
      disposed = true;
    };
  }, [id, retry]);
  useEffect(() => {
    if (!id) return;
    let disposed = false;
    setAudioError("");
    preparation.current ??= (async () => {
      const [data, restored] = await Promise.all([
        get(`/api/studio/${id}/arrangement`),
        get(`/api/studio/${id}/result`),
      ]);
      arrangementSchema.parse(data.arrangement);
      let output: ProcessingState | null = restored.result;
      if (!output) {
        // Always send zero: the existing server rejects a paid or duplicate free
        // export. Never silently authorize a charge on mount or reload.
        const response = await fetch("/api/jobs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "studio_export",
            parent_job_id: id,
            expected_cost: 0,
            settings: withDefaults("studio_export", {
              revision: data.revision,
              subtitles: ["srt"],
            }),
          }),
        });
        if (!response.ok) {
          // Another tab may have queued the included export since our read.
          output = (await get(`/api/studio/${id}/result`)).result;
          if (!output)
            throw Error(
              "Could not prepare the included audio export. Retry or open Editor Studio.",
            );
        } else {
          const queued = await response.json();
          output = {
            id: queued.id,
            fileName: "Consolidated audio",
            status: "queued",
            error: null,
            durationSec: null,
            downloads: [],
          };
        }
      }
      return output;
    })();
    preparation.current
      .then((data) => {
        if (disposed) return;
        setResult(data);
      })
      .catch((error) => {
        if (!disposed) setAudioError(error.message);
      });
    return () => {
      disposed = true;
    };
  }, [id, audioRetry]);
  const dirty =
    editing && cues !== null && draft !== cues.map((c) => c.text).join("\n\n");
  useEffect(() => {
    const before = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", before);
    return () => window.removeEventListener("beforeunload", before);
  }, [dirty]);
  async function save() {
    if (!id || cues === null) throw Error("Wait for the transcript to load.");
    if (savingRef.current) throw Error("Wait for the script to finish saving.");
    if (!dirty) {
      setEditing(false);
      return;
    }
    const next = editedStudioCues(cues, draft);
    savingRef.current = true;
    setSaving(true);
    try {
      const response = await fetch(`/api/jobs/${id}/subtitles`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cues: next }),
      });
      if (!response.ok)
        throw Error((await response.json()).error || "Could not save script.");
      setCues(next);
      setEditing(false);
      setNotice("Script saved.");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }
  async function flush() {
    if (editing) await save();
    // Read the latest arrangement before the handoff. This page does not edit
    // its timeline; never overwrite a newer revision from another tab.
    if (id) {
      const latest = await get(`/api/studio/${id}/arrangement`);
      arrangementSchema.parse(latest.arrangement);
    }
  }
  function downloadSrt() {
    if (!cues) return;
    const url = URL.createObjectURL(
      new Blob([serializeSubtitles(cues, "srt")], {
        type: "text/plain;charset=utf-8",
      }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = subtitleFilename(
      job?.fileName ?? "Audio Studio",
      "und",
      "srt",
    );
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const audio =
    result?.status === "done"
      ? result.downloads.find((d) =>
          /Download (MP3|WAV|M4A|FLAC|OGG)$/i.test(d.label),
        )
      : undefined;
  return (
    <div className="studio-simple-grid">
      <div className="studio-simple-left">
        {controls}
        {id && (
          <section
            className="card studio-consolidated"
            aria-label="Consolidated audio"
          >
            <p className="eyebrow">YOUR FINISHED SESSION</p>
            <h3>Consolidated audio</h3>
            {audio ? (
              <>
                <audio
                  key={audio.href}
                  controls
                  preload="metadata"
                  aria-label="Consolidated audio player"
                  src={audio.href}
                  onError={() => setPlayerError(true)}
                  onCanPlay={() => setPlayerError(false)}
                />
                {playerError && (
                  <p role="alert">
                    Audio preview could not load. Try Download audio or reload
                    this page.
                  </p>
                )}
              </>
            ) : (
              <p role="status">
                {audioError ||
                  (result?.status === "failed"
                    ? "Audio export failed. Open Editor Studio to retry the export."
                    : result?.status === "done"
                      ? "No audio output is available. Open Editor Studio to export your mix."
                      : "Preparing your consolidated audio…")}
              </p>
            )}
            {audioError && (
              <button
                className="btn ghost"
                onClick={() => {
                  preparation.current = null;
                  setAudioRetry((n) => n + 1);
                }}
              >
                Retry audio
              </button>
            )}
            {result && result.status !== "done" && (
              <ProcessingStatus
                state={result}
                setState={setResult}
                type="studio_export"
              />
            )}
            <div className="studio-result-actions">
              <OpenEditor source="studio" jobId={id} flush={flush} />
              {audio ? (
                <a className="btn ghost" href={audio.href}>
                  Download audio
                </a>
              ) : (
                <button className="btn ghost" disabled>
                  Download audio
                </button>
              )}
              <button
                className="btn ghost"
                disabled={!cues?.length}
                onClick={downloadSrt}
              >
                Download SRT
              </button>
            </div>
            {dirty && (
              <p className="muted">
                Download SRT uses your saved script. Opening Editor Studio saves
                your current edit first.
              </p>
            )}
          </section>
        )}
      </div>
      <div className="studio-simple-right">
        {clipsPanel}
        <section
          className="card studio-transcription"
          aria-label="Transcription"
        >
          <p className="eyebrow">YOUR WORDS</p>
          <h3>Transcription</h3>
          {editing ? (
            <>
              <label htmlFor="studio-script-edit">Edit transcript</label>
              <p id="studio-script-help" className="muted">
                Keep one paragraph per subtitle, separated by a blank line.
                Timing stays the same.
              </p>
              <textarea
                id="studio-script-edit"
                aria-describedby="studio-script-help"
                autoFocus
                value={draft}
                disabled={saving}
                onChange={(e) => {
                  setDraft(e.target.value);
                  setNotice("");
                }}
              />
              <div className="studio-actions">
                <button
                  className="btn"
                  disabled={saving}
                  onClick={() => void save().catch((e) => setNotice(e.message))}
                >
                  {saving ? "Saving…" : "Save"}
                </button>
                <button
                  className="btn ghost"
                  disabled={saving}
                  onClick={() => {
                    setEditing(false);
                    setNotice("");
                  }}
                >
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <>
              <div
                className="studio-transcript-text"
                tabIndex={0}
                aria-label="Output transcript"
              >
                {loadError ? (
                  <p role="alert">{loadError}</p>
                ) : cues?.length ? (
                  cues.map((c, i) => <p key={i}>{c.text}</p>)
                ) : (
                  <p className="muted">
                    {id
                      ? cues === null
                        ? "Loading transcription…"
                        : "No speech was found in this session."
                      : "Your transcription will appear here after processing."}
                  </p>
                )}
              </div>
              {loadError && (
                <button
                  className="btn ghost"
                  onClick={() => setRetry((n) => n + 1)}
                >
                  Retry transcription
                </button>
              )}
              <button
                className="btn ghost"
                disabled={!cues?.length}
                onClick={() => {
                  setDraft(cues!.map((c) => c.text).join("\n\n"));
                  setEditing(true);
                  setNotice("");
                }}
              >
                Edit script
              </button>
            </>
          )}
          {notice && <p role="status">{notice}</p>}
        </section>
      </div>
    </div>
  );
}
