"use client";
import {
  useEffect,
  useId,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
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

function GlassTube({ status }: { status: ProcessingState["status"] }) {
  const id = useId().replace(/:/g, "");
  return (
    <div className={`glass-tube tube-${status}`} aria-hidden="true">
      <svg viewBox="0 0 640 120" preserveAspectRatio="none" focusable="false">
        <defs>
          <linearGradient id={`${id}-glass`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="white" stopOpacity=".28" />
            <stop offset=".22" stopColor="white" stopOpacity=".025" />
            <stop offset=".55" stopColor="white" stopOpacity=".01" />
            <stop offset=".83" stopColor="white" stopOpacity=".13" />
            <stop offset="1" stopColor="white" stopOpacity=".04" />
          </linearGradient>
          <linearGradient id={`${id}-liquid`} x1="0" y1="0" x2="0" y2="1">
            <stop stopColor="currentColor" stopOpacity=".8" />
            <stop offset="1" stopColor="currentColor" stopOpacity=".08" />
          </linearGradient>
          <clipPath id={`${id}-clip`}>
            <rect x="12" y="16" width="616" height="88" rx="44" />
          </clipPath>
        </defs>
        <g clipPath={`url(#${id}-clip)`}>
          <rect
            className="tube-tint"
            x="12"
            y="16"
            width="616"
            height="88"
            rx="44"
            fill="currentColor"
            opacity=".09"
          />
          <g className="tube-liquid" fill={`url(#${id}-liquid)`}>
            {[0, 1, 2].map((layer) => (
              <g key={layer} className={`tube-flow tube-flow-${layer}`}>
                {[-640, 0, 640].map((x) => (
                  <path
                    key={x}
                    transform={`translate(${x} ${layer * 7})`}
                    d={`M0 60 Q80 ${[26, 40, 50][layer]} 160 60 T320 60 T480 60 T640 60 V120 H0Z`}
                  />
                ))}
              </g>
            ))}
          </g>
          <rect
            x="12"
            y="16"
            width="616"
            height="88"
            rx="44"
            fill={`url(#${id}-glass)`}
          />
          <path
            className="tube-sheen"
            d="M90 15 L150 15 L210 105 L150 105Z"
            fill="white"
            opacity=".09"
          />
          <path
            d="M50 27 Q320 19 590 27"
            fill="none"
            stroke="white"
            strokeOpacity=".75"
            strokeWidth="2"
          />
          <path
            d="M52 91 Q320 100 588 91"
            fill="none"
            stroke="white"
            strokeOpacity=".2"
            strokeWidth="5"
          />
        </g>
        <rect
          x="12"
          y="16"
          width="616"
          height="88"
          rx="44"
          fill="none"
          stroke="currentColor"
          strokeOpacity=".5"
        />
        <ellipse
          cx="38"
          cy="60"
          rx="24"
          ry="43"
          fill={`url(#${id}-glass)`}
          stroke="white"
          strokeOpacity=".3"
        />
        <ellipse
          cx="602"
          cy="60"
          rx="24"
          ry="43"
          fill={`url(#${id}-glass)`}
          stroke="white"
          strokeOpacity=".3"
        />
        <path
          d="M35 23 C12 32 12 82 35 97 M605 23 C628 32 628 82 605 97"
          fill="none"
          stroke="white"
          strokeOpacity=".65"
        />
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
      <GlassTube key={id ?? state.fileName} status={state.status} />
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
