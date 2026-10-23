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
    <div className="input-preview">
      <h3>Original preview</h3>
      <p className="muted">
        Listen to your original file before processing. Your downloads will
        appear in the live panel.
      </p>
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
