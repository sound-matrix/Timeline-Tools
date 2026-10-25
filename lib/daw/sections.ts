import type { Arrangement } from "../arrangement.ts";
import { splitRegions, duration, uid } from "./commands.ts";
/** Split crossing clips first, so moving a section never moves audio outside it. */
export function moveSection(
  a: Arrangement,
  id: string,
  toIndex: number,
  duplicate = false,
): Arrangement {
  const sections = [...a.sections].sort((x, y) => x.start - y.start),
    source = sections.find((s) => s.id === id);
  if (!source) return a;
  let split = splitRegions(
    a,
    a.regions.map((r) => r.id),
    source.start,
  );
  split = splitRegions(
    split,
    split.regions.map((r) => r.id),
    source.end,
  );
  // Isolate every section boundary before shuffling their contents.
  for (const section of sections)
    for (const at of [section.start, section.end])
      split = splitRegions(
        split,
        split.regions.map((r) => r.id),
        at,
      );
  const order = sections.filter((s) => s.id !== id);
  if (duplicate) order.splice(0, order.length, ...sections);
  const copy = duplicate
    ? { ...source, id: uid(), name: `${source.name} copy`.slice(0, 60) }
    : source;
  order.splice(Math.max(0, Math.min(order.length, toIndex)), 0, copy);
  let cursor = sections[0]?.start ?? 0;
  const offsets = new Map<string, number>(),
    next = order.map((s) => {
      const start = cursor;
      cursor += s.end - s.start;
      offsets.set(s.id, start - s.start);
      return { ...s, start, end: cursor };
    });
  const owner = (r: Arrangement["regions"][number]) =>
    sections.find(
      (s) =>
        r.start >= s.start - 0.00001 &&
        r.start + r.src_end - r.src_start <= s.end + 0.00001,
    );
  const regions = split.regions.map((r) => {
    const s = owner(r);
    return s ? { ...r, start: r.start + (offsets.get(s.id) ?? 0) } : r;
  });
  if (duplicate) {
    const offset = offsets.get(copy.id)!;
    for (const r of split.regions)
      if (owner(r)?.id === source.id)
        regions.push({ ...r, id: uid(), start: r.start + offset });
  }
  return duration({
    ...split,
    sections: next,
    regions,
    duration: Math.max(a.duration, cursor),
  });
}
