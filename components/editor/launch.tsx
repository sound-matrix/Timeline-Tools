"use client";
import { useEffect, useRef, useState } from "react";
export default function EditorLaunch({
  source,
  job,
}: {
  source: "blank" | "studio" | "podcast";
  job: string | null;
}) {
  const pending = useRef<Promise<string> | null>(null),
    [error, setError] = useState("");
  function launch() {
    pending.current ??= fetch("/api/editor", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name:
          source === "blank"
            ? "Untitled project"
            : `${source === "studio" ? "Audio Studio" : "Podcast"} · Editor`,
        source_kind: source,
        source_job: job,
      }),
    }).then(async (r) => {
      const data = await r.json();
      if (!r.ok) throw Error(data.error);
      return data.id;
    });
    void pending.current
      .then((id) => location.replace(`/editor/${id}`))
      .catch((e) => {
        setError(e.message);
        pending.current = null;
      });
  }
  useEffect(() => {
    launch();
  }, []);
  return (
    <main className="card">
      <h1>Editor Studio</h1>
      <p role="status">{error || "Opening your project…"}</p>
      {error && (
        <button className="btn" onClick={launch}>
          Retry opening
        </button>
      )}
      <a href="/dashboard">Back to dashboard</a>
    </main>
  );
}
