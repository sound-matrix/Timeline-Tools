"use client";
import { useEffect, useState } from "react";
export function ClipPreview({ file }: { file: File | null }) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState(false);
  useEffect(() => {
    setError(false);
    if (!file) {
      setUrl("");
      return;
    }
    const next = URL.createObjectURL(file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file]);
  return (
    <section className="studio-preview" aria-label="Preview audio">
      <h3>Preview audio</h3>
      <audio
        key={url}
        controls
        preload="metadata"
        aria-label="Preview selected clip"
        src={url || undefined}
        onError={() => setError(true)}
      />
      <p className="muted">
        {file ? file.name : "Upload a clip to preview it here."}
      </p>
      {error && (
        <p role="alert">
          This browser cannot preview this file. You can still submit it for
          processing.
        </p>
      )}
    </section>
  );
}
export function ClipDuration({ file }: { file: File }) {
  const [duration, setDuration] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const url = URL.createObjectURL(file);
    const media = document.createElement(
      file.type.startsWith("video/") ? "video" : "audio",
    );
    media.preload = "metadata";
    media.onloadedmetadata = () => {
      if (Number.isFinite(media.duration)) setDuration(media.duration);
      else setFailed(true);
    };
    media.onerror = () => setFailed(true);
    media.src = url;
    return () => {
      media.onloadedmetadata = null;
      media.onerror = null;
      media.removeAttribute("src");
      media.load();
      URL.revokeObjectURL(url);
    };
  }, [file]);
  return (
    <small className="muted">
      {duration === null
        ? failed
          ? "Duration unavailable"
          : "Reading duration…"
        : `${Math.floor(duration / 60)}:${String(Math.floor(duration % 60)).padStart(2, "0")}`}
    </small>
  );
}
