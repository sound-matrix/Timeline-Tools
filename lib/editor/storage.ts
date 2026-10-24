let database: Promise<IDBDatabase> | undefined;
function storageError(event: Event, transaction: IDBTransaction) {
  // Request errors bubble before transaction.error is populated in WebKit.
  const request = event.target as IDBRequest;
  return (
    request.error ??
    transaction.error ??
    new Error("Your browser could not save this audio on the device.")
  );
}
function db() {
  return (database ??= new Promise((resolve, reject) => {
    const r = indexedDB.open("timeline-editor-v1", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("entries");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => {
      database = undefined;
      reject(r.error);
    };
  }));
}
export async function localEntry<T>(key: string): Promise<T | undefined> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const r = d.transaction("entries").objectStore("entries").get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
export async function putEntry(key: string, value: unknown) {
  const d = await db();
  return new Promise<void>((resolve, reject) => {
    const t = d.transaction("entries", "readwrite");
    t.objectStore("entries").put(value, key);
    t.oncomplete = () => resolve();
    t.onerror = (event) => reject(storageError(event, t));
    t.onabort = () =>
      reject(
        t.error ??
          new Error("Local audio storage was interrupted. Please try again."),
      );
  });
}
export async function deleteEntry(key: string) {
  const d = await db();
  return new Promise<void>((resolve, reject) => {
    const t = d.transaction("entries", "readwrite");
    t.objectStore("entries").delete(key);
    t.oncomplete = () => resolve();
    t.onerror = (event) => reject(storageError(event, t));
    t.onabort = () =>
      reject(
        t.error ??
          new Error("Local audio storage was interrupted. Please try again."),
      );
  });
}
/** Enumerate only one owner's/project's journal namespace, including original File blobs. */
export async function localEntries<T>(
  prefix: string,
): Promise<{ key: string; value: T }[]> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const values: { key: string; value: T }[] = [],
      t = d.transaction("entries"),
      r = t
        .objectStore("entries")
        .openCursor(IDBKeyRange.bound(prefix, prefix + "\uffff"));
    r.onsuccess = () => {
      const cursor = r.result;
      if (cursor) {
        values.push({ key: String(cursor.key), value: cursor.value });
        cursor.continue();
      }
    };
    t.oncomplete = () => resolve(values);
    t.onerror = (event) => reject(storageError(event, t));
    t.onabort = () =>
      reject(
        t.error ??
          new Error("Local audio storage was interrupted. Please try again."),
      );
  });
}
