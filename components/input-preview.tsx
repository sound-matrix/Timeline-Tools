"use client";
import { useEffect, useState } from "react";
export default function InputPreview({ file }: { file: File | null }) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!file) {
      setUrl(undefined);
      return;
    }
    const value = URL.createObjectURL(file);
    setUrl(value);
    return () => URL.revokeObjectURL(value);
  }, [file]);
  return (
    <div className="card">
      <h3>Before / After player</h3>
      <p className="muted">
        Preview your original file. The processed version will be available
        after Phase 1B processing.
      </p>
      <div className="row">
        <span className="tag">A: Before</span>
        <span className="tag y">B: After · not available yet</span>
      </div>
      {url ? (
        file?.type.startsWith("video/") ? (
          <video
            controls
            src={url}
            preload="metadata"
            style={{ width: "100%", maxHeight: 300 }}
          />
        ) : (
          <audio
            controls
            src={url}
            preload="metadata"
            style={{ width: "100%", marginTop: 12 }}
          />
        )
      ) : (
        <p>Choose a file above to preview it.</p>
      )}
    </div>
  );
}
