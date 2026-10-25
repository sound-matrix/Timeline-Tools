"use client";
import { useEffect, useRef, useState, useCallback } from "react";
import dynamic from "next/dynamic";
const SubtitleEditor = dynamic(() => import("./subtitle-editor"));
import Link from "next/link";
import JobsRefresh from "./jobs-refresh";
import { ProcessingWave } from "./studio-motion";
type Job = {
  id: string;
  file_name: string;
  type: string;
  status: string;
  error: string | null;
  output_paths: unknown;
  created_at: string;
  settings?: { language?: string };
};
export default function JobsTable({
  jobs,
  title = "Recent jobs",
  subtitleEditor = false,
}: {
  jobs: Job[];
  title?: string;
  subtitleEditor?: boolean;
}) {
  const newest = subtitleEditor
    ? jobs.find((j) => j.type === "subtitles" && j.status === "done")?.id
    : undefined;
  const [selected, setSelected] = useState(newest);
  const dirty = useRef(false);
  const lastNewest = useRef(newest);
  const onDirty = useCallback((value: boolean) => {
    dirty.current = value;
  }, []);
  useEffect(() => {
    if (newest !== lastNewest.current) {
      lastNewest.current = newest;
      if (!dirty.current) setSelected(newest);
    }
  }, [newest]);
  const active = jobs.find((j) => j.id === selected);
  return (
    <>
      <div className="card table-scroll">
        <h3>{title}</h3>
        <JobsRefresh
          active={jobs.some(
            (j) => j.status === "queued" || j.status === "processing",
          )}
        />
        {!jobs.length ? (
          <p className="muted">No jobs yet. Upload a file to get started.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>File</th>
                <th>Tool</th>
                <th>Status</th>
                <th>Downloads</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id}>
                  <td>
                    {j.file_name}
                    <small className="block muted">
                      {new Date(j.created_at).toLocaleString("en-IN", {
                        timeZone: "Asia/Kolkata",
                      })}{" "}
                      IST
                    </small>
                  </td>
                  <td>
                    {j.type === "studio"
                      ? "Audio Studio"
                      : j.type === "podcast"
                        ? "Podcast"
                        : j.type === "podcast_export"
                          ? "Podcast export"
                          : j.type === "studio_export"
                            ? "Studio export"
                            : j.type}
                  </td>
                  <td>
                    <span
                      className={
                        "tag " +
                        (j.status === "done"
                          ? "g"
                          : j.status === "failed"
                            ? "r"
                            : "y")
                      }
                    >
                      {j.status}
                    </span>
                    {j.status === "processing" && (
                      <span
                        className="job-processing"
                        title="Processing audio; completion time varies"
                      >
                        <ProcessingWave />
                      </span>
                    )}
                    {j.error && <p>{j.error}</p>}
                  </td>
                  <td>
                    {subtitleEditor &&
                      j.type === "subtitles" &&
                      j.status === "done" && (
                        <button
                          className="btn sm"
                          onClick={() => {
                            if (
                              j.id !== selected &&
                              dirty.current &&
                              !window.confirm(
                                "Discard unsaved subtitle changes?",
                              )
                            )
                              return;
                            if (j.id !== selected) dirty.current = false;
                            setSelected(j.id);
                          }}
                        >
                          Open editor
                        </button>
                      )}
                    {j.type === "podcast" && j.status === "done" && (
                      <Link
                        className="btn sm"
                        href={`/podcast?session=${j.id}`}
                      >
                        Open Podcast session
                      </Link>
                    )}
                    {j.status === "done" && Array.isArray(j.output_paths)
                      ? j.output_paths.map((path, i) =>
                          typeof path === "string" &&
                          /\/(stems|peaks)\//.test(path) ? null : (
                            <Link
                              className="btn sm ghost"
                              key={i}
                              href={`/api/jobs/${j.id}/download?index=${i}`}
                            >
                              Download{" "}
                              {typeof path === "string"
                                ? path.split(".").pop()?.toUpperCase()
                                : i + 1}
                            </Link>
                          ),
                        )
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {subtitleEditor && active && (
        <SubtitleEditor key={active.id} job={active} onDirty={onDirty} />
      )}
    </>
  );
}
