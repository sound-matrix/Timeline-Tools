export const SCHEDULER_INTERVAL_MS = 25;
export const SCHEDULER_LOOKAHEAD_SECONDS = 0.1;
export const PREFETCH_SECONDS = 8;
export const STREAM_CHUNK_SECONDS = 5;
export function schedulerChunks(
  start: number,
  length: number,
  now: number,
  prefetch = PREFETCH_SECONDS,
) {
  if (start + length <= now || start > now + prefetch) return [];
  const first = Math.max(0, Math.floor((now - start) / STREAM_CHUNK_SECONDS)),
    last = Math.min(
      Math.ceil(length / STREAM_CHUNK_SECONDS) - 1,
      Math.floor((now + prefetch - start) / STREAM_CHUNK_SECONDS),
    );
  return Array.from(
    { length: Math.max(0, last - first + 1) },
    (_, i) => first + i,
  );
}
export function changedRegions(
  before: { regions: { id: string }[] },
  after: { regions: { id: string }[] },
) {
  const old = new Map(
      before.regions.map((r) => [
        r.id,
        JSON.stringify({ ...r, inserts: undefined }),
      ]),
    ),
    next = new Map(
      after.regions.map((r) => [
        r.id,
        JSON.stringify({ ...r, inserts: undefined }),
      ]),
    );
  return new Set(
    [...old.keys(), ...next.keys()].filter(
      (id) => old.get(id) !== next.get(id),
    ),
  );
}
