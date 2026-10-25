"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  drafts,
  numbers,
  parseSubtitles,
  jsonCues,
  validateCues,
  splitCue,
  mergeCue,
  serializeSubtitles,
  subtitleFilename,
  timestamp,
  type Cue,
  type CueDraft,
  type SubtitleFormat,
} from "@/lib/subtitles";
export type SubtitleJob = {
  id: string;
  file_name: string;
  output_paths: unknown;
  settings?: { language?: string };
};
type Document = { cues: CueDraft[]; raw: string; error: string };
const documentFor = (cues: Cue[]): Document => ({
  cues: drafts(cues),
  raw: serializeSubtitles(cues, "srt"),
  error: "",
});
export default function SubtitleEditor({
  job,
  onDirty,
}: {
  job: SubtitleJob;
  onDirty: (dirty: boolean) => void;
}) {
  const [history, setHistory] = useState<{ items: Document[]; at: number }>({
    items: [],
    at: 0,
  });
  const doc = history.items[history.at];
  const [original, setOriginal] = useState<Cue[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [retry, setRetry] = useState(0);
  const [view, setView] = useState<"cues" | "plain">("cues");
  const [format, setFormat] = useState<SubtitleFormat>("srt");
  const [find, setFind] = useState(""),
    [replacement, setReplacement] = useState("");
  const [saved, setSaved] = useState(""),
    [saveError, setSaveError] = useState(""),
    [saving, setSaving] = useState(false);
  const [audioUrl, setAudioUrl] = useState<string | null>(null),
    [position, setPosition] = useState(-1);
  const player = useRef<HTMLAudioElement>(null),
    lineNumbers = useRef<HTMLPreElement>(null);
  const savingRef = useRef(false);
  const rawEditor = useRef<HTMLTextAreaElement>(null);
  const cueEditors = useRef<(HTMLTextAreaElement | null)[]>([]);
  const findCursor = useRef(0);
  const cues = useMemo(() => (doc ? numbers(doc.cues) : []), [doc]);
  const errors = useMemo(() => validateCues(cues), [cues]);
  const key = doc ? JSON.stringify(doc) : "";
  const dirty = !!doc && key !== saved;
  const hasCueErrors = errors.some((e) => e.length);
  const valid = !!doc && !doc.error && !hasCueErrors;
  const commit = (next: Document) =>
    setHistory((h) => ({
      items: [...h.items.slice(0, h.at + 1), next].slice(-100),
      at: Math.min(h.at + 1, 99),
    }));
  const updateCues = (next: CueDraft[]) => {
    const values = numbers(next);
    commit({
      cues: next,
      raw: values.every(
        (c) => Number.isFinite(c.start) && Number.isFinite(c.end),
      )
        ? serializeSubtitles(values, "srt")
        : doc.raw,
      error: "",
    });
  };
  const changeRaw = (raw: string) => {
    try {
      commit({ raw, cues: drafts(parseSubtitles(raw)), error: "" });
    } catch (e) {
      commit({ ...doc, raw, error: (e as Error).message });
    }
  };
  const undo = () => setHistory((h) => ({ ...h, at: Math.max(0, h.at - 1) }));
  const redo = () =>
    setHistory((h) => ({ ...h, at: Math.min(h.items.length - 1, h.at + 1) }));
  const outputPathsKey = JSON.stringify(job.output_paths);
  useEffect(() => {
    const controller = new AbortController();
    const get = async (url: string) => {
      const response = await fetch(url, {
        signal: controller.signal,
        cache: "no-store",
      });
      if (!response.ok)
        throw new Error("Could not load subtitle results. Please retry.");
      return response;
    };
    setLoadError("");
    (async () => {
      const persisted = await (
        await get(`/api/jobs/${job.id}/subtitles`)
      ).json();
      const paths = Array.isArray(JSON.parse(outputPathsKey))
        ? JSON.parse(outputPathsKey)
        : [];
      let source: Cue[] | null = null;
      for (const ext of ["json", "srt", "vtt"]) {
        for (let i = 0; i < paths.length; i++) {
          if (
            typeof paths[i] !== "string" ||
            !paths[i].toLowerCase().endsWith("." + ext)
          )
            continue;
          try {
            const response = await get(
              `/api/jobs/${job.id}/download?index=${i}`,
            );
            source =
              ext === "json"
                ? jsonCues(await response.json())
                : parseSubtitles(await response.text());
            break;
          } catch (e) {
            if (controller.signal.aborted) throw e;
          }
        }
        if (source !== null) break;
      }
      if (source === null)
        throw new Error("No readable JSON, SRT or VTT output is available.");
      if (controller.signal.aborted) return;
      const loaded = documentFor(
        persisted.cues === null ? source : jsonCues(persisted.cues),
      );
      setOriginal(source);
      setAudioUrl(persisted.audioUrl);
      setHistory({ items: [loaded], at: 0 });
      setSaved(JSON.stringify(loaded));
    })().catch((e) => {
      if (!controller.signal.aborted) setLoadError(e.message);
    });
    return () => controller.abort();
  }, [job.id, outputPathsKey, retry]);
  useEffect(() => {
    onDirty(dirty);
  }, [dirty, onDirty]);
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
  const save = useCallback(async () => {
    if (!valid || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setSaveError("");
    try {
      const response = await fetch(`/api/jobs/${job.id}/subtitles`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cues }),
      });
      if (!response.ok)
        throw new Error(
          (await response.json()).error || "Could not save edits.",
        );
      setSaved(key);
    } catch (e) {
      setSaveError((e as Error).message);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [valid, job.id, cues, key]);
  useEffect(() => {
    if (!dirty || !valid || saving || saveError) return;
    const timer = setTimeout(() => void save(), 800);
    return () => clearTimeout(timer);
  }, [dirty, valid, saving, saveError, save]);
  const download = () => {
    const url = URL.createObjectURL(
      new Blob([serializeSubtitles(cues, format)], {
        type:
          format === "vtt"
            ? "text/vtt;charset=utf-8"
            : format === "json"
              ? "application/json;charset=utf-8"
              : "text/plain;charset=utf-8",
      }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = subtitleFilename(
      job.file_name,
      job.settings?.language ?? "und",
      format,
    );
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  if (loadError)
    return (
      <section className="card subtitle-editor" aria-label="Subtitle editor">
        <p role="alert">{loadError}</p>
        <button className="btn" onClick={() => setRetry((n) => n + 1)}>
          Retry loading
        </button>
      </section>
    );
  if (!doc)
    return (
      <section className="card" aria-label="Subtitle editor">
        <p role="status">Loading subtitles…</p>
      </section>
    );
  const findNext = () => {
    const fields = view === "plain" ? [rawEditor.current] : cueEditors.current;
    const hits: { field: HTMLTextAreaElement; offset: number }[] = [];
    for (const field of fields) {
      if (!field || !find) continue;
      let offset = field.value.indexOf(find);
      while (offset >= 0) {
        hits.push({ field, offset });
        offset = field.value.indexOf(find, offset + find.length);
      }
    }
    if (!hits.length) return;
    const hit = hits[findCursor.current++ % hits.length];
    hit.field.focus();
    hit.field.setSelectionRange(hit.offset, hit.offset + find.length);
    hit.field.scrollIntoView({ block: "nearest" });
  };
  const matches = find
    ? (view === "plain"
        ? doc.raw
        : doc.cues.map((c) => c.text).join("\n")
      ).split(find).length - 1
    : 0;
  return (
    <section
      className="card subtitle-editor"
      aria-label="Subtitle editor"
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
          e.preventDefault();
          e.shiftKey ? redo() : undo();
        }
      }}
    >
      <div className="subtitle-toolbar">
        <div>
          <h3>Subtitle editor</h3>
          <p className="muted">{job.file_name}</p>
        </div>
        <span role="status" aria-label="Save status">
          {saving
            ? "Saving…"
            : saveError
              ? "Save failed"
              : dirty
                ? valid
                  ? "Unsaved changes"
                  : "Fix errors to save"
                : "Saved"}
        </span>
      </div>
      {saveError && <p role="alert">{saveError}</p>}
      <div className="subtitle-toolbar">
        <div role="group" aria-label="Editor view">
          <button
            className="btn sm"
            aria-pressed={view === "cues"}
            onClick={() => setView("cues")}
          >
            Cue list
          </button>
          <button
            className="btn sm"
            aria-pressed={view === "plain"}
            disabled={view === "cues" && !doc.error && hasCueErrors}
            onClick={() => setView("plain")}
          >
            Plain text
          </button>
        </div>
        <button
          className="btn sm ghost"
          disabled={history.at === 0}
          onClick={undo}
        >
          Undo
        </button>
        <button
          className="btn sm ghost"
          disabled={history.at === history.items.length - 1}
          onClick={redo}
        >
          Redo
        </button>
        <button
          className="btn sm ghost"
          disabled={!valid || saving || !dirty}
          onClick={() => void save()}
        >
          Save edits
        </button>
        <button
          className="btn sm ghost"
          disabled={saving || original === null}
          onClick={() => {
            if (
              original &&
              window.confirm("Replace your edits with the original subtitles?")
            ) {
              commit(documentFor(original));
              setSaveError("");
            }
          }}
        >
          Revert to original
        </button>
        <label>
          Download format
          <select
            value={format}
            onChange={(e) => setFormat(e.target.value as SubtitleFormat)}
          >
            <option value="srt">SRT</option>
            <option value="vtt">WebVTT (.vtt)</option>
            <option value="txt">Plain text (.txt)</option>
            <option value="json">JSON (segments)</option>
            <option value="ass">ASS/SSA (.ass)</option>
          </select>
        </label>
        <button className="btn" disabled={!valid} onClick={download}>
          Download edited subtitles
        </button>
      </div>
      <div className="subtitle-toolbar subtitle-find">
        <label>
          Find
          <input
            value={find}
            onChange={(e) => {
              setFind(e.target.value);
              findCursor.current = 0;
            }}
          />
        </label>
        <label>
          Replace with
          <input
            value={replacement}
            onChange={(e) => setReplacement(e.target.value)}
          />
        </label>
        <span>{matches} matches</span>
        <button
          className="btn sm ghost"
          disabled={!find || !matches}
          onClick={findNext}
        >
          Find next
        </button>
        <button
          className="btn sm ghost"
          disabled={!find || !matches}
          onClick={() =>
            view === "plain"
              ? changeRaw(doc.raw.replaceAll(find, replacement))
              : updateCues(
                  doc.cues.map((c) => ({
                    ...c,
                    text: c.text.replaceAll(find, replacement),
                  })),
                )
          }
        >
          Replace all
        </button>
      </div>
      {audioUrl && (
        <audio
          aria-label="Source audio preview"
          ref={player}
          controls
          preload="metadata"
          src={audioUrl}
          onTimeUpdate={(e) => setPosition(e.currentTarget.currentTime)}
          onError={() => {
            setAudioUrl(null);
            setPosition(-1);
          }}
        />
      )}
      {doc.error && (
        <p role="alert">
          {doc.error} Your text is preserved; fix it in Plain text to sync the
          cue list.
        </p>
      )}
      {!valid && !doc.error && (
        <p className="subtitle-error">
          Fix the cue errors before saving or downloading.
        </p>
      )}
      {view === "plain" &&
        errors.map((messages, i) =>
          messages.length ? (
            <p className="subtitle-error" key={i}>
              Cue {i + 1}: {messages.join(" ")}
            </p>
          ) : null,
        )}
      {view === "plain" ? (
        <div className="subtitle-plain">
          <pre ref={lineNumbers} aria-hidden="true">
            {doc.raw
              .split("\n")
              .map((_, i) => i + 1)
              .join("\n")}
          </pre>
          <textarea
            ref={rawEditor}
            aria-label="SRT source"
            wrap="off"
            spellCheck={false}
            value={doc.raw}
            onChange={(e) => changeRaw(e.target.value)}
            onScroll={(e) => {
              if (lineNumbers.current)
                lineNumbers.current.scrollTop = e.currentTarget.scrollTop;
            }}
          />
        </div>
      ) : (
        <div className="subtitle-cues" aria-label="Subtitle cues">
          {doc.cues.map((c, i) => {
            const lines = c.text.split("\n"),
              long = lines.some((l) => [...l].length > 42);
            return (
              <div
                key={i}
                className={
                  "subtitle-cue" +
                  (position >= cues[i].start && position < cues[i].end
                    ? " is-playing"
                    : "")
                }
                onClick={() => {
                  if (player.current && Number.isFinite(cues[i].start))
                    player.current.currentTime = cues[i].start;
                }}
              >
                <strong>Cue {i + 1}</strong>
                <label>
                  Start {i + 1}
                  <input
                    aria-invalid={!!errors[i].length}
                    aria-describedby={
                      errors[i].length ? `cue-errors-${i}` : undefined
                    }
                    value={c.start}
                    disabled={!!doc.error}
                    onChange={(e) =>
                      updateCues(
                        doc.cues.map((q, j) =>
                          j === i ? { ...q, start: e.target.value } : q,
                        ),
                      )
                    }
                  />
                </label>
                <label>
                  End {i + 1}
                  <input
                    aria-invalid={!!errors[i].length}
                    value={c.end}
                    disabled={!!doc.error}
                    onChange={(e) =>
                      updateCues(
                        doc.cues.map((q, j) =>
                          j === i ? { ...q, end: e.target.value } : q,
                        ),
                      )
                    }
                  />
                </label>
                <div className="subtitle-cue-text">
                  <label>
                    Text {i + 1}
                    <textarea
                      aria-label={`Text ${i + 1}`}
                      ref={(element) => {
                        cueEditors.current[i] = element;
                      }}
                      value={c.text}
                      disabled={!!doc.error}
                      onChange={(e) =>
                        updateCues(
                          doc.cues.map((q, j) =>
                            j === i ? { ...q, text: e.target.value } : q,
                          ),
                        )
                      }
                    />
                  </label>
                  <small className={long ? "subtitle-warning" : "muted"}>
                    {[...c.text].length} characters · {lines.length} lines ·{" "}
                    {lines.map((l) => [...l].length).join(" / ")} characters per
                    line{long ? " — above 42 characters per line" : ""}
                  </small>
                </div>
                <div className="subtitle-cue-actions">
                  <button
                    className="btn sm ghost"
                    disabled={
                      !!doc.error ||
                      hasCueErrors ||
                      cues[i].end - cues[i].start < 0.002
                    }
                    onClick={() => commit(documentFor(splitCue(cues, i)))}
                  >
                    Split cue {i + 1}
                  </button>
                  <button
                    className="btn sm ghost"
                    disabled={
                      !!doc.error || i === cues.length - 1 || hasCueErrors
                    }
                    onClick={() => commit(documentFor(mergeCue(cues, i)))}
                  >
                    Merge cue {i + 1} with next
                  </button>
                  <button
                    className="btn sm ghost"
                    disabled={!!doc.error}
                    onClick={() =>
                      updateCues(doc.cues.filter((_, j) => j !== i))
                    }
                  >
                    Delete cue {i + 1}
                  </button>
                  <button
                    className="btn sm ghost"
                    disabled={!!doc.error || !Number.isFinite(cues[i].end)}
                    onClick={() => {
                      const start = cues[i].end;
                      updateCues([
                        ...doc.cues.slice(0, i + 1),
                        {
                          start: timestamp(start),
                          end: timestamp(
                            cues[i + 1]?.start > start
                              ? cues[i + 1].start
                              : start + 1,
                          ),
                          text: "",
                        },
                        ...doc.cues.slice(i + 1),
                      ]);
                    }}
                  >
                    Insert after cue {i + 1}
                  </button>
                </div>
                {!!errors[i].length && (
                  <p id={`cue-errors-${i}`} className="subtitle-error">
                    {errors[i].join(" ")}
                  </p>
                )}
              </div>
            );
          })}
          {!doc.cues.length && (
            <p className="muted">No cues. Insert one to begin.</p>
          )}
          <button
            className="btn sm"
            disabled={!!doc.error}
            onClick={() => {
              const start = cues.at(-1)?.end || 0;
              updateCues([
                ...doc.cues,
                {
                  start: timestamp(start),
                  end: timestamp(start + 1),
                  text: "",
                },
              ]);
            }}
          >
            Insert cue
          </button>
        </div>
      )}
    </section>
  );
}
