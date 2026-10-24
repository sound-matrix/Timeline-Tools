import type { Arrangement } from "../arrangement.ts";
export type PendingSave = { revision: number; arrangement: Arrangement };
export type SaveStatus =
  | "Saved"
  | "Saving…"
  | "Offline — will retry"
  | "Newer version from another tab";
export class EditorSaver {
  revision: number;
  current: Arrangement;
  last: string;
  pending: Promise<void> | null = null;
  conflict = false;
  timer: ReturnType<typeof setTimeout> | undefined;
  project: string;
  storage: {
    put: (v: PendingSave) => Promise<void>;
    clear: () => Promise<void>;
  };
  notify: (status: SaveStatus) => void;
  onConflict: (server: PendingSave) => void;
  request: typeof fetch;
  ready: () => boolean = () => true;
  constructor(
    project: string,
    initial: PendingSave,
    storage: {
      put: (v: PendingSave) => Promise<void>;
      clear: () => Promise<void>;
    },
    notify: (status: SaveStatus) => void,
    onConflict: (server: PendingSave) => void,
    request: typeof fetch = fetch,
  ) {
    this.project = project;
    this.storage = storage;
    this.notify = notify;
    this.onConflict = onConflict;
    this.request = request.bind(globalThis);
    this.revision = initial.revision;
    this.current = initial.arrangement;
    this.last = JSON.stringify(initial.arrangement);
  }
  change(arrangement: Arrangement) {
    this.current = arrangement;
    clearTimeout(this.timer);
    const record = { revision: this.revision, arrangement };
    void this.storage
      .put(record)
      .catch(() => this.notify("Offline — will retry"));
    this.notify("Saving…");
    this.timer = setTimeout(() => void this.flush().catch(() => {}), 2000);
  }
  async flush(): Promise<void> {
    clearTimeout(this.timer);
    if (this.pending) {
      await this.pending;
      if (JSON.stringify(this.current) !== this.last) return this.flush();
      return;
    }
    if (this.conflict) throw Error("Choose which version to keep.");
    if (JSON.stringify(this.current) === this.last) {
      this.notify("Saved");
      return;
    }
    if (!this.ready()) {
      await this.storage.put({
        revision: this.revision,
        arrangement: this.current,
      });
      this.notify("Saving…");
      throw Error(
        "Audio is still uploading. Your edits are stored on this device and will save when the upload finishes.",
      );
    }
    const snapshot = this.current,
      text = JSON.stringify(snapshot),
      revision = this.revision;
    this.pending = (async () => {
      await this.storage.put({ revision, arrangement: snapshot });
      const r = await this.request(`/api/editor/${this.project}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ revision, arrangement: snapshot }),
      });
      if (r.status === 409) {
        const next = await this.request(`/api/editor/${this.project}`, {
          cache: "no-store",
        });
        if (!next.ok) throw Error("Could not load newer version");
        const server = await next.json();
        this.conflict = true;
        this.notify("Newer version from another tab");
        this.onConflict(server);
        throw Error("Choose which version to keep.");
      }
      if (!r.ok) throw Error((await r.json()).error ?? "Could not save");
      this.revision = (await r.json()).revision;
      this.last = text;
      if (JSON.stringify(this.current) === text) {
        await this.storage.clear();
        this.notify("Saved");
      } else {
        await this.storage.put({
          revision: this.revision,
          arrangement: this.current,
        });
        this.notify("Saving…");
      }
    })()
      .catch((error) => {
        if (!this.conflict) this.notify("Offline — will retry");
        throw error;
      })
      .finally(() => {
        this.pending = null;
      });
    await this.pending;
    if (JSON.stringify(this.current) !== this.last && !this.conflict)
      return this.flush();
  }
  async resolve(server: PendingSave, mine = true) {
    this.conflict = false;
    this.revision = server.revision;
    this.last = JSON.stringify(server.arrangement);
    if (!mine) {
      this.current = server.arrangement;
      await this.storage.clear();
      this.notify("Saved");
      return;
    }
    await this.flush();
  }
  close() {
    clearTimeout(this.timer);
  }
}
