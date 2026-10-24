import { useEffect, useState } from "react";
export type PeakLevel = { rate: number; values: Int8Array };
export type PeakAsset = { hash: string; levels: PeakLevel[] };
export function usePeaks(
  assets: Record<string, { key: string; url?: string; values?: number[][] }>,
) {
  const [peaks, setPeaks] = useState<Record<string, PeakAsset>>({});
  useEffect(() => {
    const worker = new Worker("/daw/peaks-worker.js");
    worker.onmessage = (e) => {
      if (e.data.result)
        setPeaks((p) => ({ ...p, [e.data.id]: e.data.result }));
    };
    for (const [id, a] of Object.entries(assets)) {
      if (a.url) worker.postMessage({ id, key: a.key, url: a.url });
      else if (a.values) {
        const values = Int8Array.from(a.values.flat());
        setPeaks((p) => ({
          ...p,
          [id]: { hash: a.key, levels: [{ rate: 100, values }] },
        }));
      }
    }
    return () => worker.terminate();
  }, [assets]);
  return peaks;
}
