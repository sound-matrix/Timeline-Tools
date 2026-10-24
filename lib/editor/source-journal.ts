import { localEntry, putEntry, deleteEntry, localKeys } from "./storage";

const CHUNK = 1048576;
export type SourceBytes = {
  name: string;
  type: string;
  size: number;
  modified: number;
  count: number;
};
type Store = {
  read: typeof localEntry;
  write: typeof putEntry;
  remove: typeof deleteEntry;
  keys: typeof localKeys;
};
const storage: Store = {
  read: localEntry,
  write: putEntry,
  remove: deleteEntry,
  keys: localKeys,
};
const prefix = (journal: string) =>
  journal.replace(/^import-source\//, "import-bytes/") + "/";

/** Persist owned bytes, not an OS File handle whose backing object can disappear on reload. */
export async function snapshotSource(
  journal: string,
  file: File,
  store = storage,
): Promise<SourceBytes> {
  let count = 0;
  try {
    for (let at = 0; at < file.size; at += CHUNK) {
      const bytes = await file.slice(at, at + CHUNK).arrayBuffer();
      await store.write(prefix(journal) + count, bytes);
      count++;
    }
    return {
      name: file.name,
      type: file.type,
      size: file.size,
      modified: file.lastModified,
      count,
    };
  } catch (error) {
    await clearSource(journal, store).catch(() => {});
    throw error;
  }
}

/** Blob parts keep reconstruction out of a single full-size JavaScript ArrayBuffer. */
export async function restoreSource(
  journal: string,
  source: SourceBytes,
  store = storage,
) {
  const parts: Blob[] = [];
  let size = 0;
  for (let i = 0; i < source.count; i++) {
    const bytes = await store.read<ArrayBuffer>(prefix(journal) + i);
    if (!(bytes instanceof ArrayBuffer))
      throw Error(
        "The saved original audio is incomplete. Please import it again.",
      );
    parts.push(new Blob([bytes]));
    size += bytes.byteLength;
  }
  if (size !== source.size)
    throw Error(
      "The saved original audio is incomplete. Please import it again.",
    );
  return new File(parts, source.name, {
    type: source.type,
    lastModified: source.modified,
  });
}

export async function clearSource(journal: string, store = storage) {
  for (const key of await store.keys(prefix(journal))) await store.remove(key);
}
