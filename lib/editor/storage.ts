let database: Promise<IDBDatabase> | undefined;
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
    t.onerror = () => reject(t.error);
  });
}
export async function deleteEntry(key: string) {
  const d = await db();
  return new Promise<void>((resolve, reject) => {
    const t = d.transaction("entries", "readwrite");
    t.objectStore("entries").delete(key);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}
