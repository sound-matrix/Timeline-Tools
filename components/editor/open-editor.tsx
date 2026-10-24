"use client";
import { useState } from "react";
export default function OpenEditor({
  source,
  jobId,
  flush,
}: {
  source: "studio" | "podcast";
  jobId: string;
  flush: () => Promise<void>;
}) {
  const [message, setMessage] = useState("");
  const href = `/editor/new?source=${source}&job=${jobId}`;
  async function open(e: React.MouseEvent<HTMLAnchorElement>) {
    if (e.type === "auxclick" && e.button !== 1) return;
    e.preventDefault();
    setMessage("Saving before opening…");
    const tab =
      e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1
        ? window.open("about:blank", "_blank")
        : null;
    try {
      await flush();
      if (tab) tab.location.href = href;
      else location.assign(href);
    } catch (error) {
      tab?.close();
      setMessage((error as Error).message);
    }
  }
  return (
    <div className="editor-entry">
      <a className="btn" href={href} onClick={open} onAuxClick={open}>
        Open in Editor Studio
      </a>
      {message && <p role="status">{message}</p>}
    </div>
  );
}
