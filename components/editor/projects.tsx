"use client";
import { useState } from "react";
import Link from "next/link";
type Project = { id: string; name: string; updated_at: string };
export default function EditorProjects({
  projects: initial,
}: {
  projects: Project[];
}) {
  const [projects, setProjects] = useState(initial),
    [error, setError] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null),
    [name, setName] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);
  async function change(id: string, method: "PATCH" | "DELETE") {
    setPending(id);
    setError("");
    try {
      const r = await fetch(`/api/editor/${id}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(method === "PATCH" ? { name: name.trim() } : {}),
      });
      const data = await r.json();
      if (!r.ok) throw Error(data.error ?? "Could not update project");
      setProjects((rows) =>
        method === "DELETE"
          ? rows.filter((p) => p.id !== id)
          : rows.map((p) => (p.id === id ? { ...p, name: data.name } : p)),
      );
      setRenaming(null);
      setDeleting(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(null);
    }
  }
  return (
    <>
      <h1>Editor Studio</h1>
      <p>Your audio projects</p>
      <Link className="btn" href="/editor/new">
        New project
      </Link>
      {error && <p role="alert">{error}</p>}
      {!projects.length && (
        <p>No projects yet. Create a new project to start editing.</p>
      )}
      <ul className="editor-projects">
        {projects.map((p) => (
          <li className="card" key={p.id}>
            <Link href={`/editor/${p.id}`}>{p.name}</Link>
            <p className="muted">Updated {p.updated_at.slice(0, 10)}</p>
            {renaming === p.id ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void change(p.id, "PATCH");
                }}
              >
                <label>
                  Project name
                  <input
                    autoFocus
                    required
                    maxLength={120}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </label>
                <button className="btn" disabled={!!pending || !name.trim()}>
                  Save name
                </button>
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => setRenaming(null)}
                >
                  Cancel
                </button>
              </form>
            ) : (
              <button
                className="btn ghost"
                disabled={!!pending}
                onClick={() => {
                  setRenaming(p.id);
                  setName(p.name);
                  setDeleting(null);
                }}
              >
                Rename
              </button>
            )}
            {deleting === p.id ? (
              <div role="group" aria-label={`Delete ${p.name}`}>
                <p>Delete this project from your projects list?</p>
                <button
                  className="btn"
                  disabled={!!pending}
                  onClick={() => void change(p.id, "DELETE")}
                >
                  Confirm delete
                </button>
                <button className="btn ghost" onClick={() => setDeleting(null)}>
                  Cancel
                </button>
              </div>
            ) : (
              <button
                className="btn ghost"
                disabled={!!pending}
                onClick={() => {
                  setDeleting(p.id);
                  setRenaming(null);
                }}
              >
                Delete
              </button>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}
