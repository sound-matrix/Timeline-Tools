"use client";
import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { useRouter } from "next/navigation";
import { jobStatusSchema, type ProcessingState } from "@/lib/job-status";
import type { JobType } from "@/lib/settings";

const labels = {
  uploading: "Uploading",
  starting: "Starting",
  queued: "Queued",
  processing: "Processing",
  done: "Done",
  failed: "Failed",
};

function LiveWave({ status }: { status: ProcessingState["status"] }) {
  return (
    <div className={`live-wave wave-${status}`} aria-hidden="true">
      <svg viewBox="0 0 640 120" preserveAspectRatio="none">
        <g className="wave-noisy">
          {Array.from({ length: 80 }, (_, i) => {
            const height = 18 + ((i * 37 + i * i * 13) % 91);
            return (
              <rect
                key={i}
                x={i * 8 + 1}
                y={(120 - height) / 2}
                width="4"
                height={height}
                rx="2"
              />
            );
          })}
        </g>
        <g className="wave-clean">
          {Array.from({ length: 80 }, (_, i) => {
            const height = 10 + 42 * Math.pow(Math.sin(i / 9), 2);
            return (
              <rect
                key={i}
                x={i * 8 + 1}
                y={(120 - height) / 2}
                width="4"
                height={height}
                rx="2"
              />
            );
          })}
        </g>
      </svg>
    </div>
  );
}

export default function ProcessingStatus({
  state,
  setState,
  type,
}: {
  state: ProcessingState;
  setState: Dispatch<SetStateAction<ProcessingState | null>>;
  type: JobType;
}) {
  const router = useRouter();
  const [pollError, setPollError] = useState("");
  const [retry, setRetry] = useState(0);
  const [paused, setPaused] = useState(false);
  const active = state.status === "queued" || state.status === "processing";
  const id = state.id;
  useEffect(() => {
    if (!id || !active) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    async function poll() {
      let keepPolling = true;
      try {
        if (document.hidden) return;
        const response = await fetch(`/api/jobs/${id}`, {
          cache: "no-store",
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(15000),
          ]),
        });
        if (
          response.redirected ||
          response.status === 401 ||
          response.status === 403
        ) {
          keepPolling = false;
          throw new Error(
            "Sign in again to check your job. Your job may still be running.",
          );
        }
        if (response.status === 404) {
          keepPolling = false;
          throw new Error(
            "Job unavailable. Check Recent jobs or try checking again.",
          );
        }
        if (!response.ok)
          throw new Error("Could not check progress. Retrying shortly.");
        const parsed = jobStatusSchema.safeParse(await response.json());
        if (!parsed.success)
          throw new Error("Could not check progress. Retrying shortly.");
        const snapshot = parsed.data;
        if (disposed) return;
        setPollError("");
        setState((previous) =>
          previous && previous.id === id
            ? { ...previous, ...snapshot }
            : previous,
        );
        if (snapshot.status === "done" || snapshot.status === "failed") {
          keepPolling = false;
          router.refresh();
        }
      } catch (error) {
        if (!disposed)
          setPollError(
            error instanceof Error
              ? error.message
              : "Could not check progress. Retrying shortly.",
          );
      } finally {
        if (!disposed && keepPolling) timer = setTimeout(poll, 2500);
      }
    }
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [id, active, retry, router, setState]);

  const working = state.status === "processing";
  const done = state.status === "done";
  const failed = state.status === "failed";
  const activity =
    type === "clean"
      ? "Cleaning…"
      : type === "master"
        ? "Mastering…"
        : type === "studio"
          ? "Matching speech & arranging your timeline…"
          : type === "studio_export"
            ? "Rendering your export…"
            : "Transcribing…";
  return (
    <section
      className={`card processing-panel${paused ? " live-paused" : ""}`}
      aria-label="Live processing"
    >
      <div className="processing-heading">
        <div>
          <p className="eyebrow">YOUR PROCESSING SESSION</p>
          <h3
            role="status"
            aria-label="Job progress"
            aria-live="polite"
            aria-atomic="true"
          >
            {labels[state.status]}
            {state.status === "uploading" && state.uploadPercent !== undefined
              ? ` · ${state.uploadPercent}%`
              : ""}
          </h3>
          <p className="processing-file">{state.fileName}</p>
        </div>
        {!done && !failed && (
          <button
            type="button"
            className="btn ghost sm live-motion-toggle"
            aria-pressed={paused}
            onClick={() => setPaused(!paused)}
          >
            {paused ? "Resume live motion" : "Pause live motion"}
          </button>
        )}
      </div>
      <LiveWave key={id ?? state.fileName} status={state.status} />
      <p className="processing-description">
        {working
          ? activity
          : done
            ? "Your files are ready."
            : failed
              ? "Processing could not finish."
              : state.status === "queued"
                ? "Waiting for a worker. Keep this page open to see your result."
                : state.status === "starting"
                  ? "Starting your processing job…"
                  : "Securely uploading your original file…"}
      </p>
      {!done && !failed && (
        <p className="muted live-caption">
          Activity animation · completion is confirmed by the worker.
        </p>
      )}
      {failed && (
        <p role="alert">
          {state.error || "Something went wrong. Please try again."}
        </p>
      )}
      {failed &&
        state.errorCode === "language_mismatch" &&
        state.errorDetail && (
          <div role="alert">
            <p>
              The language of the clips and the script don’t match. Script:{" "}
              {state.errorDetail.script_lang}. No minutes charged.
            </p>
            <ul>
              {state.errorDetail.clips.map((c, i) => (
                <li key={i}>
                  {c.name}: {c.lang} ({Math.round(c.prob * 100)}%)
                </li>
              ))}
            </ul>
          </div>
        )}
      {pollError && active && (
        <div role="alert">
          <p>{pollError}</p>
          <button
            type="button"
            className="btn ghost"
            onClick={() => setRetry((v) => v + 1)}
          >
            Check again
          </button>
          <a className="btn ghost" href="/signin">
            Sign in
          </a>
        </div>
      )}
      {done && (
        <>
          <div className="processing-downloads">
            {state.downloads.map((download) => (
              <a className="btn" href={download.href} key={download.href}>
                {download.label}
              </a>
            ))}
          </div>
          {state.downloads.length === 0 && (
            <p>No output is available. Check Recent jobs or contact support.</p>
          )}
          {state.durationSec !== null && (
            <p className="muted">
              Processed audio duration: {state.durationSec.toFixed(1)} seconds.
            </p>
          )}
          {type === "master" && (
            <p className="muted">
              Open the measured report for actual loudness and true peak.
            </p>
          )}
        </>
      )}
    </section>
  );
}
