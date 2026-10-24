/* Private immutable assets only. Fetch, parse, aggregate and cache off the UI thread. */
const dbp = new Promise((resolve) => {
  const r = indexedDB.open("timeline-daw-peaks-v2", 1);
  r.onupgradeneeded = () => r.result.createObjectStore("assets");
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => resolve(null);
});
async function cached(key, value) {
  const db = await dbp;
  if (!db) return null;
  return new Promise((resolve) => {
    const t = db.transaction("assets", value ? "readwrite" : "readonly"),
      r = value
        ? t.objectStore("assets").put(value, key)
        : t.objectStore("assets").get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => resolve(null);
  });
}
self.onmessage = async ({ data: { id, key, url } }) => {
  try {
    let result = await cached(key);
    if (result?.asset) result = await cached(result.asset);
    if (!result) {
      const response = await fetch(url);
      if (!response.ok) throw Error("Waveform unavailable");
      const raw = await response.arrayBuffer(),
        hash = await crypto.subtle.digest("SHA-256", raw);
      const data = JSON.parse(new TextDecoder().decode(raw));
      if (!Array.isArray(data.peaks) || data.peaks.length > 1440001)
        throw Error("Invalid waveform");
      let values = new Int8Array(data.peaks.length * 2);
      for (let i = 0; i < data.peaks.length; i++) {
        values[2 * i] = data.peaks[i][0];
        values[2 * i + 1] = data.peaks[i][1];
      }
      const levels = [{ rate: data.rate || 100, values }];
      while (values.length > 512) {
        const next = new Int8Array(Math.ceil(values.length / 8) * 2);
        for (let i = 0; i < next.length / 2; i++) {
          let lo = 127,
            hi = -128;
          for (let j = i * 8; j < Math.min(i * 8 + 8, values.length); j += 2) {
            lo = Math.min(lo, values[j]);
            hi = Math.max(hi, values[j + 1]);
          }
          next[i * 2] = lo;
          next[i * 2 + 1] = hi;
        }
        values = next;
        levels.push({ rate: levels.at(-1).rate / 4, values });
      }
      result = {
        hash: Array.from(new Uint8Array(hash), (v) =>
          v.toString(16).padStart(2, "0"),
        ).join(""),
        levels,
      };
      const asset = `sha256:${result.hash}`;
      await cached(asset, result);
      await cached(key, { asset });
    }
    self.postMessage({ id, result });
  } catch (e) {
    self.postMessage({ id, error: e.message });
  }
};
