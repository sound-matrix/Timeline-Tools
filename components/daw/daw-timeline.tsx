"use client";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { arrangementSchema, type Arrangement } from "@/lib/arrangement";
import {
  CommandHistory,
  deleteRegions,
  duration,
  end,
  fadeValue,
  rulerStamp,
  snapTime,
  splitRegions,
  uid,
  type Region,
  type Tool,
  type SnapMode,
} from "@/lib/daw/commands";
import { DawPlayback } from "@/lib/daw/playback";
import { usePeaks } from "./peaks";
import "./daw.css";
import { TimelineRenderer, IntervalIndex } from "../../public/daw/render-core.js";
import VideoStrip from "./video-strip";
export type DawOverlay = {
  id: string;
  lane: string;
  start: number;
  end: number;
  text: string;
  selected?: boolean;
  muted?: boolean;
  onSelect?: (extend: boolean) => void;
};
export type DawVideo = {
  id: string;
  start: number;
  duration: number;
  url: string;
};
export type DawTransport = {
  toggle: () => void;
  seek: (t: number) => void;
  stop: () => void;
};
type Props = {
  transport?: RefObject<DawTransport | null>;
  onPlayingChange?: (playing: boolean) => void;
  readWindow?: DawPlayback["reader"];
  playbackArrangement?: Arrangement;
  playbackPosition?: number;
  onPlaybackTick?: (time: number) => void;
  arrangement: Arrangement;
  onChange: (a: Arrangement, before?: Arrangement) => void;
  onPreview?: (a: Arrangement) => void;
  onUndo?: () => void;
  onRedo?: () => void;
  assets?: Record<string, { key: string; url?: string; values?: number[][] }>;
  audioUrls?: Record<string, string>;
  overlays?: DawOverlay[];
  videos?: DawVideo[];
  playhead?: number;
  onSeek?: (t: number) => void;
  playing?: boolean;
  onToggle?: () => void;
  readOnly?: boolean;
};
const EMPTY = {};
export default function DawTimeline({
  transport,
  onPlayingChange,
  readWindow,
  playbackArrangement,
  playbackPosition,
  onPlaybackTick,
  arrangement: a,
  onChange,
  onPreview,
  onUndo,
  onRedo,
  assets = EMPTY,
  audioUrls = EMPTY,
  overlays = [],
  videos = [],
  playhead: externalHead,
  onSeek,
  playing: externalPlaying,
  onToggle,
  readOnly = false,
}: Props) {
  const [tool, setTool] = useState<Tool>("pointer"),
    [selection, setSelection] = useState<string[]>([]),
    [head, setHead] = useState(0),
    [playing, setPlaying] = useState(false),
    [zoom, setZoom] = useState(50),
    [snap, setSnap] = useState<SnapMode>("edges"),
    [ruler, setRuler] = useState("minsec"),
    [help, setHelp] = useState(false),
    [message, setMessage] = useState(""),
    [autoscroll, setAutoscroll] = useState("page"),
    [range, setRange] = useState<[number, number] | null>(null),
    [menu, setMenu] = useState<{
      x: number;
      y: number;
      time: number;
      lane: string;
      region?: string;
      kind: string;
    } | null>(null),
    [view, setView] = useState({ x: 0, y: 0, w: 900, h: 480 }),
    [historyTick, setHistoryTick] = useState(0);
  const canvas = useRef<HTMLCanvasElement>(null),
    scroller = useRef<HTMLDivElement>(null),
    history = useRef(new CommandHistory()),
    clipboard = useRef<Region[]>([]),
    engine = useRef<DawPlayback | null>(null),
    state = useRef(a),
    headRef = useRef(0),
    drag = useRef<{
      before: Arrangement;
      ids: string[];
      x: number;
      y: number;
      time: number;
      lane: string;
      mode: string;
      pointer: number;
      clone: boolean;
      copies?: Record<string, string>;
    } | null>(null),
    drawFrame = useRef(0),
    root = useRef<HTMLElement>(null),
    meter = useRef<HTMLCanvasElement>(null),
    clipIndicator = useRef(false);
  const geometry = useRef({left:0,top:0});
  const [canvasEpoch, setCanvasEpoch] = useState(0);
  const painter = useRef<Worker | null>(null),
    paintCache = useRef<Record<string, unknown>>({});
  const renderer = useRef(new TimelineRenderer());
  const regionIndex = useMemo(() => new IntervalIndex(a.regions), [a.regions]);
  const overlayCanvas = useRef<HTMLCanvasElement>(null);
  const peaks = usePeaks(assets);
  useEffect(() => {
    const c = canvas.current;
    if (!c?.transferControlToOffscreen || typeof Worker === "undefined") return;
    try {
      const worker = new Worker("/daw/paint-worker.js", { type: "module" });
      const offscreen = c.transferControlToOffscreen();
      worker.postMessage({ canvas: offscreen }, [offscreen]);
      painter.current = worker;
      c.dataset.renderer = "worker";
      worker.onerror = (e) => {
        e.preventDefault();
        worker.terminate();
        painter.current = null;
        setCanvasEpoch((n) => n + 1);
      };
      return () => {
        worker.terminate();
        painter.current = null;
      };
    } catch {
      painter.current = null;
    }
  }, []);
  state.current = a;
  const paintHead = useRef<(t:number)=>void>(()=>{});
  const lastClock = useRef(0);
  const position = externalHead ?? head,
    isPlaying = externalPlaying ?? playing;
  headRef.current = position;
  const rows = useMemo(() => {
    let y = 36 + (videos.length ? 72 : 0);
    return a.lanes.map((l) => {
      const row = { ...l, y };
      y += l.height;
      return row;
    });
  }, [a.lanes, videos.length]);
  const totalHeight = (rows.at(-1)?.y ?? 36) + (rows.at(-1)?.height ?? 120);
  const totalWidth = Math.max(view.w, 180 + a.duration * zoom + 100);
  function stop() {
    engine.current?.stop();
    setPlaying(false);
  }
  const seek = useCallback(
    (t: number) => {
      stop();
      t = Math.max(0, Math.min(state.current.duration, t));
      setHead(t);
      onSeek?.(t);
    },
    [onSeek],
  );
  function commit(label: string, next: Arrangement, before = state.current) {
    if (readOnly) {
      setMessage("This timeline is read-only.");
      return;
    }
    const result = arrangementSchema.safeParse(duration(next));
    if (!result.success) {
      setMessage(result.error.issues[0]?.message ?? "Invalid edit");
      return;
    }
    stop();
    onChange(history.current.execute(label, before, result.data), before);
    setHistoryTick((n) => n + 1);
    setMessage("");
  }
  function undo() {
    stop();
    if (onUndo) {
      onUndo();
      return;
    }
    onChange(history.current.undo(state.current));
    setHistoryTick((n) => n + 1);
  }
  function redo() {
    stop();
    if (onRedo) {
      onRedo();
      return;
    }
    onChange(history.current.redo(state.current));
    setHistoryTick((n) => n + 1);
  }
  async function toggle() {
    if (onToggle) {
      onToggle();
      return;
    }
    if (isPlaying) {
      stop();
      return;
    }
    try {
      const player = (engine.current ??= new DawPlayback());
      if (player.reader !== readWindow) {
        player.buffers.clear();
        player.reader = readWindow;
      }
      setPlaying(true);
      await player.play(
        playbackArrangement ?? a,
        (playbackPosition ?? position) >= (playbackArrangement ?? a).duration
          ? 0
          : (playbackPosition ?? position),
        audioUrls,
        (t) => {
          headRef.current = t;
          paintHead.current(t);
          if (performance.now() - lastClock.current > 100) {
            lastClock.current = performance.now();
            setHead(t);
            (onPlaybackTick ?? onSeek)?.(t);
          }
        },
        () => setPlaying(false),
      );
    } catch (e) {
      setPlaying(false);
      setMessage((e as Error).message);
    }
  }
  useEffect(() => {
    if (transport)
      transport.current = { toggle: () => void toggle(), seek, stop };
  });
  useEffect(() => {
    onPlayingChange?.(isPlaying);
  }, [isPlaying, onPlayingChange]);
  useEffect(
    () => () => {
      void engine.current?.close();
    },
    [],
  );
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => {
      const rect = el.getBoundingClientRect(); geometry.current = {left:rect.left,top:rect.top};
      setView({
        x: el.scrollLeft,
        y: el.scrollTop,
        w: el.clientWidth,
        h: el.clientHeight,
      });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    measure();
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        setZoom((z) =>
          Math.max(0.1, Math.min(2000, z * Math.exp(-e.deltaY * 0.005))),
        );
      } else if (e.altKey) {
        e.preventDefault();
        const row = rows.find(
          (l) =>
            l.y <= e.clientY - geometry.current.top + el.scrollTop &&
            l.y + l.height >
              e.clientY - geometry.current.top + el.scrollTop,
        );
        if (row)
          commit("Track height", {
            ...state.current,
            lanes: state.current.lanes.map((l) =>
              l.id === row.id
                ? {
                    ...l,
                    height: Math.round(
                      Math.max(60, Math.min(400, l.height - e.deltaY)),
                    ),
                  }
                : l,
            ),
          });
      }
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  });
  useEffect(() => {
    if (!isPlaying || autoscroll === "off" || !scroller.current) return;
    const el = scroller.current,
      x = 180 + position * zoom;
    if (autoscroll === "smooth")
      el.scrollLeft = Math.max(0, x - el.clientWidth * 0.4);
    else if (x < el.scrollLeft + 180 || x > el.scrollLeft + el.clientWidth - 30)
      el.scrollLeft = Math.max(0, x - 180);
  }, [position, isPlaying, autoscroll, zoom]);
  useEffect(() => {
    if (painter.current) {
      const cache = paintCache.current,
        packet: Record<string, unknown> = {
          view,
          zoom,
          selection,
          range,
          ruler,
          rows,
          videos,
          dpr: Math.min(devicePixelRatio || 1, 2),
        };
      if (cache.a !== a) {
        packet.a = a;
        cache.a = a;
      }
      if (cache.peaks !== peaks) {
        packet.peaks = peaks;
        cache.peaks = peaks;
      }
      if (cache.overlays !== overlays) {
        packet.overlays = overlays.map(({ onSelect, ...data }) => data);
        cache.overlays = overlays;
      }
      painter.current.postMessage(packet);
      return;
    }
    const draw = () => {
      const c = canvas.current;
      if (!c) return;
      renderer.current.draw(c, { a, peaks, view, zoom, selection, range, ruler, rows, overlays, videos, dpr: Math.min(devicePixelRatio || 1, 2) });
    };
    cancelAnimationFrame(drawFrame.current);
    drawFrame.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(drawFrame.current);
  }, [
    canvasEpoch,
    a,
    peaks,
    view,
    zoom,
    selection,
    range,
    ruler,
    rows,
    overlays,
    videos,
  ]);
  paintHead.current = (time:number) => {
    const c = overlayCanvas.current, ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    c.width = Math.round(view.w * dpr); c.height = Math.round(view.h * dpr);
    ctx.scale(dpr,dpr);
    const px = 180 + time * zoom - view.x;
    if (px >= 180 && px <= view.w) {ctx.fillStyle = "#F472B6";ctx.fillRect(px,0,2,view.h);}
  };
  useEffect(() => paintHead.current(position), [position,view,zoom]);
  useEffect(() => {
    let frame = 0;
    const values = new Float32Array(1024);
    const draw = () => {
      const c = meter.current,
        ctx = c?.getContext("2d"),
        meters = engine.current?.meters ?? [];
      if (c && ctx) {
        ctx.clearRect(0, 0, c.width, c.height);
        meters.forEach((analyser, ch) => {
          analyser.getFloatTimeDomainData(values);
          let sum = 0,
            peak = 0;
          for (const v of values) {
            sum += v * v;
            peak = Math.max(peak, Math.abs(v));
          }
          clipIndicator.current ||= peak >= 1;
          ctx.fillStyle = clipIndicator.current ? "#F87171" : "#6EE7B7";
          ctx.fillRect(0, ch * 10, Math.min(1, peak) * c.width, 4);
          ctx.fillStyle = "#818CF8";
          ctx.fillRect(
            0,
            ch * 10 + 4,
            Math.min(1, Math.sqrt(sum / values.length)) * c.width,
            4,
          );
        });
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, []);

  function coordinates(e: { clientX: number; clientY: number }) {
    const rect = geometry.current;
    const x = e.clientX - rect.left,
      y = e.clientY - rect.top;
    return {
      x,
      y,
      time: Math.max(0, (x + view.x - 180) / zoom),
      lane:
        rows.find((l) => y + view.y >= l.y && y + view.y < l.y + l.height)
          ?.id ?? a.lanes[0].id,
    };
  }
  function hit(time: number, lane: string) {
    return regionIndex.query(lane, time, time)
      .reverse()
      .find((r) => r.lane === lane && time >= r.start && time <= end(r));
  }
  function split(time = position, ids = selection) {
    commit(
      "Split",
      splitRegions(
        a,
        ids.length
          ? ids
          : a.regions
              .filter((r) => time > r.start && time < end(r))
              .map((r) => r.id),
        time,
      ),
    );
  }
  function remove(ripple = false) {
    commit(
      ripple ? "Ripple delete" : "Delete",
      deleteRegions(a, selection, ripple),
    );
    setSelection([]);
  }
  function copy(cut = false) {
    clipboard.current = a.regions
      .filter((r) => selection.includes(r.id))
      .map((r) => ({ ...r }));
    if (cut) remove();
  }
  function paste(at = position, lane?: string) {
    const source = clipboard.current;
    if (!source.length) return;
    const first = Math.min(...source.map((r) => r.start));
    const added = source.map((r) => ({
      ...r,
      id: uid(),
      start: Math.max(0, at + r.start - first),
      lane: lane ?? r.lane,
    }));
    commit("Paste", { ...a, regions: [...a.regions, ...added] });
    setSelection(added.map((r) => r.id));
  }
  function duplicate() {
    clipboard.current = a.regions.filter((r) => selection.includes(r.id));
    paste(Math.max(position, ...clipboard.current.map(end)));
  }
  function patch(ids: string[], value: Partial<Region>, label = "Region edit") {
    commit(label, {
      ...a,
      regions: a.regions.map((r) =>
        ids.includes(r.id) ? { ...r, ...value } : r,
      ),
    });
  }
  function marker(time = position) {
    commit("Add marker", {
      ...a,
      markers: [
        ...a.markers,
        {
          id: uid(),
          time,
          name: `Marker ${a.markers.length + 1}`,
          color: "#FCD34D",
        },
      ],
    });
  }
  function loopSelection() {
    const selected = a.regions.filter((r) => selection.includes(r.id));
    const span =
      range ??
      (selected.length
        ? [
            Math.min(...selected.map((r) => r.start)),
            Math.max(...selected.map(end)),
          ]
        : null);
    if (!span || span[1] <= span[0]) {
      setMessage("Select a range or regions first.");
      return;
    }
    commit("Set loop", {
      ...a,
      loop: {
        enabled: true,
        start: span[0],
        end: Math.min(a.duration, span[1]),
      },
    });
  }
  function fit(selectedOnly = false) {
    const selected = a.regions.filter((r) => selection.includes(r.id));
    const start =
      selectedOnly && selected.length
        ? Math.min(...selected.map((r) => r.start))
        : 0;
    const finish =
      selectedOnly && selected.length
        ? Math.max(...selected.map(end))
        : a.duration;
    setZoom(
      Math.max(
        0.1,
        Math.min(2000, (view.w - 200) / Math.max(0.01, finish - start)),
      ),
    );
    requestAnimationFrame(() => {
      if (scroller.current) scroller.current.scrollLeft = start * zoom;
    });
  }
  function down(e: React.PointerEvent<HTMLCanvasElement>) {
    if (e.button !== 0) return;
    setMenu(null);
    root.current?.focus({ preventScroll: true });
    const rect = scroller.current!.getBoundingClientRect(); geometry.current = {left:rect.left,top:rect.top};
    const p = coordinates(e);
    if (p.x < 180) return;
    const r = hit(p.time, p.lane),
      overlay = overlays.find(
        (o) =>
          o.lane === p.lane &&
          p.time >= o.start &&
          p.time <= o.end &&
          p.y + view.y >
            rows.find((l) => l.id === p.lane)!.y +
              rows.find((l) => l.id === p.lane)!.height -
              30,
      );
    if (overlay?.onSelect) {
      overlay.onSelect(e.shiftKey || e.metaKey || e.ctrlKey);
      return;
    }
    if (p.y < 36) {
      setRange([p.time, p.time]);
      seek(p.time);
      drag.current = {
        before: a,
        ids: [],
        x: p.x,
        y: p.y,
        time: p.time,
        lane: p.lane,
        mode: "ruler",
        pointer: e.pointerId,
        clone: false,
      };
    } else if (tool === "hand")
      drag.current = {
        before: a,
        ids: [],
        x: p.x,
        y: p.y,
        time: view.x,
        lane: p.lane,
        mode: "hand",
        pointer: e.pointerId,
        clone: false,
      };
    else if (tool === "zoom") {
      setZoom((z) => Math.min(2000, z * (e.altKey ? 0.8 : 1.25)));
      return;
    } else if (r && tool === "razor") {
      split(p.time, [r.id]);
      return;
    } else if (r && tool !== "range") {
      const ids =
        e.shiftKey || e.metaKey || e.ctrlKey
          ? selection.includes(r.id)
            ? selection.filter((id) => id !== r.id)
            : [...selection, r.id]
          : selection.includes(r.id)
            ? selection
            : [r.id];
      setSelection(ids);
      let mode = "move";
      const edge = 6 / zoom;
      if (tool === "fade")
        mode =
          Math.abs(p.time - r.start) < Math.abs(p.time - end(r))
            ? "fade_in"
            : "fade_out";
      else if (Math.abs(p.time - r.start) < edge) mode = "trim_start";
      else if (Math.abs(p.time - end(r)) < edge) mode = "trim_end";
      drag.current = {
        before: a,
        ids: ids.includes(r.id) ? ids : [r.id],
        x: p.x,
        y: p.y,
        time: p.time,
        lane: p.lane,
        mode,
        pointer: e.pointerId,
        clone: e.altKey,
      };
    } else {
      if (!e.shiftKey) setSelection([]);
      setRange([p.time, p.time]);
      drag.current = {
        before: a,
        ids: [],
        x: p.x,
        y: p.y,
        time: p.time,
        lane: p.lane,
        mode: tool === "range" ? "range" : "marquee",
        pointer: e.pointerId,
        clone: false,
      };
    }
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function move(e: React.PointerEvent<HTMLCanvasElement>) {
    const d = drag.current;
    if (!d) return;
    const p = coordinates(e),
      delta = p.time - d.time;
    if (d.mode === "hand") {
      if (scroller.current) {
        scroller.current.scrollLeft = d.time + d.x - p.x;
        scroller.current.scrollTop += d.y - p.y;
      }
      return;
    }
    if (d.mode === "ruler" || d.mode === "range" || d.mode === "marquee") {
      const span: [number, number] = [
        Math.min(d.time, p.time),
        Math.max(d.time, p.time),
      ];
      setRange(span);
      if (d.mode === "ruler") seek(p.time);
      if (d.mode === "marquee") {
        const minY = Math.min(d.y, p.y) + view.y,
          maxY = Math.max(d.y, p.y) + view.y;
        setSelection(
          a.regions
            .filter(
              (r) =>
                end(r) >= span[0] &&
                r.start <= span[1] &&
                rows.some(
                  (l) =>
                    l.id === r.lane && l.y + l.height >= minY && l.y <= maxY,
                ),
            )
            .map((r) => r.id),
        );
      }
      return;
    }
    if (readOnly) return;
    const anchor = d.before.regions.find((r) => r.id === d.ids[0])!;
    const snapped =
      snapTime(a, anchor.start + delta, snap, zoom, d.ids) - anchor.start;
    const minStart = Math.min(
      ...d.before.regions
        .filter((r) => d.ids.includes(r.id))
        .map((r) => r.start),
    );
    const laneDelta =
      rows.findIndex((l) => l.id === p.lane) -
      rows.findIndex((l) => l.id === d.lane);
    const altered = d.before.regions.map((r) => {
      if (!d.ids.includes(r.id)) return r;
      if (d.mode === "trim_start") {
        const v = Math.min(r.src_end - 0.001, Math.max(0, r.src_start + delta));
        return {
          ...r,
          src_start: v,
          start: Math.max(0, r.start + v - r.src_start),
        };
      }
      if (d.mode === "trim_end")
        return {
          ...r,
          src_end: Math.max(
            r.src_start + 0.001,
            Math.min(
              [...a.clips, ...a.derived_clips].find((c) => c.id === r.clip)!
                .duration,
              r.src_end + delta,
            ),
          ),
        };
      if (d.mode === "fade_in")
        return {
          ...r,
          fade_in: Math.min(
            r.src_end - r.src_start,
            Math.max(0, p.time - r.start),
          ),
        };
      if (d.mode === "fade_out")
        return {
          ...r,
          fade_out: Math.min(
            r.src_end - r.src_start,
            Math.max(0, end(r) - p.time),
          ),
        };
      const lane =
        rows[
          Math.max(
            0,
            Math.min(
              rows.length - 1,
              rows.findIndex((l) => l.id === r.lane) + laneDelta,
            ),
          )
        ].id;
      return { ...r, start: r.start + Math.max(-minStart, snapped), lane };
    });
    // Gesture preview doesn't create history entries. Stable duplicate IDs per gesture.
    const regions = d.clone
      ? [
          ...d.before.regions,
          ...altered
            .filter((r) => d.ids.includes(r.id))
            .map((r) => ({
              ...r,
              id: (d.copies ??= Object.fromEntries(
                d.ids.map((id) => [id, uid()]),
              ))[r.id],
            })),
        ]
      : altered;
    (onPreview ?? onChange)(duration({ ...a, regions }));
  }
  function up() {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    if (d.mode === "ruler") {
      if (range && range[1] - range[0] > 0.03)
        commit(
          "Loop range",
          {
            ...state.current,
            loop: {
              enabled: true,
              start: range[0],
              end: Math.min(a.duration, range[1]),
            },
          },
          d.before,
        );
      return;
    }
    if (!["hand", "range", "marquee"].includes(d.mode)) {
      let next = state.current;
      if (d.mode === "move") {
        next = { ...next, regions: next.regions.map((r) => ({ ...r })) };
        for (const first of next.regions)
          for (const second of next.regions) {
            if (
              first.lane !== second.lane ||
              first.id === second.id ||
              first.start >= second.start ||
              end(first) <= second.start ||
              end(first) > end(second)
            )
              continue;
            const overlap = end(first) - second.start;
            first.fade_out = overlap;
            second.fade_in = overlap;
          }
      }
      commit("Edit regions", next, d.before);
    }
  }
  async function normalize(ids = selection) {
    try {
      const player = (engine.current ??= new DawPlayback());
      player.derived = a.derived_clips;
      player.sourceUrls = audioUrls;
      let max = 0;
      for (const r of a.regions.filter((r) => ids.includes(r.id))) {
        for (let at = r.src_start; at < r.src_end; at += 5) {
          const b = await player.window(
            audioUrls[r.clip] ?? r.clip,
            at,
            Math.min(5, r.src_end - at),
          );
          for (let ch = 0; ch < b.numberOfChannels; ch++)
            for (const v of b.getChannelData(ch))
              max = Math.max(max, Math.abs(v));
        }
      }
      if (max > 0)
        patch(
          ids,
          { gain_db: Math.max(-60, Math.min(24, -20 * Math.log10(max))) },
          "Normalize",
        );
      else setMessage("No audio samples to normalize.");
    } catch {
      setMessage("Normalize could not read this source.");
    }
  }
  // Bounce applies existing source trims/fades/gain offline and replaces the region range
  // with an equivalent unity-gain edit. Download-free; no server job or billing path.
  async function bounce() {
    const chosen = a.regions.filter((r) => selection.includes(r.id));
    if (!chosen.length) return;
    if (chosen.some((r) => a.derived_clips.some((c) => c.id === r.clip))) {
      setMessage(
        "This clip is already bounced. Undo the bounce to edit its original source.",
      );
      return;
    }
    try {
      const player = (engine.current ??= new DawPlayback()),
        derived = [...a.derived_clips],
        regions = [...a.regions];
      player.sourceUrls = audioUrls;
      for (const r of chosen) {
        const clip = {
          id: uid(),
          name: `Bounce · ${r.name ?? [...a.clips, ...a.derived_clips].find((c) => c.id === r.clip)?.name ?? r.id}`,
          duration: r.src_end - r.src_start,
          source: r.clip,
          src_start: r.src_start,
          src_end: r.src_end,
          gain_db: r.gain_db,
          fade_in: r.fade_in,
          fade_out: r.fade_out,
          fade_curve: r.fade_curve,
        };
        derived.push(clip);
        player.derived = derived;
        // OfflineAudioContext renders bounded windows. Only 64 windows remain in RAM;
        // the saved recipe reconstructs the asset identically after reload/export.
        for (let at = 0; at < clip.duration; at += 5)
          await player.window(clip.id, at, Math.min(5, clip.duration - at));
        const i = regions.findIndex((x) => x.id === r.id);
        regions[i] = {
          ...r,
          id: uid(),
          clip: clip.id,
          name: clip.name,
          src_start: 0,
          src_end: clip.duration,
          gain_db: 0,
          fade_in: 0,
          fade_out: 0,
          lines: r.lines
            .map((l) => ({
              ...l,
              src_start: Math.max(0, l.src_start - r.src_start),
              src_end: Math.min(clip.duration, l.src_end - r.src_start),
            }))
            .filter((l) => l.src_end > l.src_start),
        };
      }
      commit("Bounce in place", { ...a, derived_clips: derived, regions });
      setMessage("Bounced in place. No export job or processing minutes used.");
    } catch {
      setMessage(
        "Bounce could not read the source. Your regions are unchanged.",
      );
    }
  }
  function context(e: React.MouseEvent) {
    e.preventDefault();
    const p = coordinates(e),
      r = hit(p.time, p.lane);
    if (r && !selection.includes(r.id)) setSelection([r.id]);
    setMenu({
      x: p.x,
      y: p.y,
      time: p.time,
      lane: p.lane,
      region: r?.id,
      kind: p.x < 180 ? "track" : p.y < 36 ? "ruler" : r ? "region" : "lane",
    });
  }
  const active = a.regions.find((r) => selection.includes(r.id));
  const updateLane = (
    id: string,
    patch: Partial<Arrangement["lanes"][number]>,
  ) =>
    commit("Track edit", {
      ...a,
      lanes: a.lanes.map((l) => (l.id === id ? { ...l, ...patch } : l)),
    });
  function shortcut(e: React.KeyboardEvent) {
    if (
      (e.target as HTMLElement).closest(
        "input,textarea,select,[contenteditable]",
      )
    )
      return;
    const k = e.key.toLowerCase(),
      mod = e.ctrlKey || e.metaKey;
    if (mod && k === "z") {
      e.preventDefault();
      e.shiftKey ? redo() : undo();
      return;
    }
    if (mod && k === "y") {
      e.preventDefault();
      redo();
      return;
    }
    if (mod && ["c", "x", "v", "d"].includes(k)) {
      e.preventDefault();
      if (k === "c") copy();
      if (k === "x") copy(true);
      if (k === "v") paste();
      if (k === "d") duplicate();
      return;
    }
    if (mod && ["+", "=", "-"].includes(k)) {
      e.preventDefault();
      setZoom((z) =>
        Math.max(0.1, Math.min(2000, z * (k === "-" ? 0.8 : 1.25))),
      );
      return;
    }
    if (e.code === "Space") {
      e.preventDefault();
      void toggle();
      return;
    }
    if (k === "enter") {
      e.preventDefault();
      seek(0);
      return;
    }
    if (k === "delete" || k === "backspace") {
      e.preventDefault();
      remove(e.shiftKey);
      return;
    }
    if (k === "s") {
      split();
      return;
    }
    if (k === "n") {
      commit("Snap", { ...a, snap: !a.snap });
      return;
    }
    if (k === "m") {
      marker();
      return;
    }
    if (k === "l") {
      commit("Cycle", { ...a, loop: { ...a.loop, enabled: !a.loop.enabled } });
      return;
    }
    if (k === "?" || k === "/") {
      setHelp((h) => !h);
      return;
    }
    if (k === "z" && e.shiftKey) {
      fit();
      return;
    }
    if (k === "arrowleft" || k === "arrowright") {
      e.preventDefault();
      const delta = (k === "arrowleft" ? -1 : 1) * (e.shiftKey ? 0.1 : 0.01);
      commit("Nudge", {
        ...a,
        regions: a.regions.map((r) =>
          selection.includes(r.id)
            ? { ...r, start: Math.max(0, r.start + delta) }
            : r,
        ),
      });
      return;
    }
    const tools: Record<string, Tool> = {
      v: "pointer",
      c: "razor",
      t: "trim",
      f: "fade",
      r: "range",
      z: "zoom",
      h: "hand",
    };
    if (tools[k]) setTool(tools[k]);
  }
  return (
    <section
      className="pro-daw"
      aria-label="DAW timeline"
      tabIndex={0}
      ref={root}
      onKeyDown={shortcut}
      data-history={historyTick}
    >
      <div className="pro-toolbar">
        <button type="button" className="btn" onClick={() => void toggle()}>
          {isPlaying ? "Pause" : "Play"}
        </button>
        <button type="button" className="btn ghost" onClick={() => seek(0)}>
          Stop / return
        </button>
        <output aria-label="Current time">
          {rulerStamp(position, ruler, a)}
        </output>
        <button type="button" className="btn ghost" onClick={undo}>
          Undo
        </button>
        <button type="button" className="btn ghost" onClick={redo}>
          Redo
        </button>
        <button
          type="button"
          className="btn ghost"
          onClick={() => setHelp((h) => !h)}
        >
          Shortcuts (?)
        </button>
        <label>
          Autoscroll
          <select
            value={autoscroll}
            onChange={(e) => setAutoscroll(e.target.value)}
          >
            <option value="page">Page (default)</option>
            <option value="smooth">Smooth</option>
            <option value="off">Off</option>
          </select>
        </label>
      </div>
      <div className="pro-toolbar" role="toolbar" aria-label="Timeline tools">
        {(
          [
            ["pointer", "Move V"],
            ["razor", "Razor C"],
            ["trim", "Trim T"],
            ["fade", "Fade F"],
            ["range", "Range R"],
            ["zoom", "Zoom Z"],
            ["hand", "Hand H"],
          ] as const
        ).map(([id, name]) => (
          <button
            type="button"
            key={id}
            className={`btn ${tool === id ? "" : "ghost"}`}
            aria-pressed={tool === id}
            onClick={() => setTool(id)}
          >
            {name}
          </button>
        ))}
        <button type="button" className="btn ghost" onClick={() => split()}>
          Split at playhead (S)
        </button>
        <button type="button" className="btn ghost" onClick={() => remove()}>
          Delete region
        </button>
      </div>
      <div className="pro-toolbar">
        <label>
          <input
            type="checkbox"
            checked={a.snap}
            onChange={(e) => commit("Snap", { ...a, snap: e.target.checked })}
          />
          Snap (default on)
        </label>
        <label>
          Grid
          <select
            value={snap}
            onChange={(e) => setSnap(e.target.value as SnapMode)}
          >
            {[
              "edges",
              "off",
              "frames24",
              "frames25",
              "frames30",
              "seconds",
              "milliseconds",
              "beats",
            ].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <label>
          Ruler
          <select value={ruler} onChange={(e) => setRuler(e.target.value)}>
            {["minsec", "timecode24", "timecode25", "timecode30", "bars"].map(
              (s) => (
                <option key={s}>{s}</option>
              ),
            )}
          </select>
        </label>
        <label>
          Tempo (default 120)
          <input
            type="number"
            min={20}
            max={300}
            value={a.tempo}
            onChange={(e) =>
              e.target.value &&
              commit("Tempo", { ...a, tempo: Number(e.target.value) })
            }
          />
        </label>
        <label>
          Time signature
          <input
            aria-label="Beats per bar"
            type="number"
            min={1}
            max={16}
            value={a.time_signature[0]}
            onChange={(e) =>
              e.target.value &&
              commit("Signature", {
                ...a,
                time_signature: [Number(e.target.value), a.time_signature[1]],
              })
            }
          />
          <select
            aria-label="Beat unit"
            value={a.time_signature[1]}
            onChange={(e) =>
              commit("Signature", {
                ...a,
                time_signature: [
                  a.time_signature[0],
                  Number(e.target.value) as 2 | 4 | 8 | 16,
                ],
              })
            }
          >
            {[2, 4, 8, 16].map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="btn ghost"
          aria-label="Zoom in"
          onClick={() => setZoom((z) => Math.min(2000, z * 1.25))}
        >
          +
        </button>
        <button
          type="button"
          className="btn ghost"
          aria-label="Zoom out"
          onClick={() => setZoom((z) => Math.max(0.1, z / 1.25))}
        >
          −
        </button>
        <button type="button" className="btn ghost" onClick={() => fit()}>
          Fit (Shift+Z)
        </button>
        <button type="button" className="btn ghost" onClick={() => fit(true)}>
          Zoom to selection
        </button>
      </div>
      {message && <p role="alert">{message}</p>}
      <div
        className="pro-scroll"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          setView((v) => ({ ...v, x: el.scrollLeft, y: el.scrollTop }));
        }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const u = a.unplaced[Number(e.dataTransfer.getData("text/plain"))];
          if (!u) return;
          const p = coordinates(e);
          commit("Place clip", {
            ...a,
            regions: [
              ...a.regions,
              {
                id: uid(),
                lane: p.lane,
                kind: "clip",
                clip: u.clip,
                src_start: u.src_start,
                src_end: u.src_end,
                start: p.time,
                gain_db: 0,
                line: 0,
                confidence: 0,
                mute: false,
                fade_in: 0,
                fade_out: 0,
                fade_curve: "linear",
                lines: [],
              },
            ],
            unplaced: a.unplaced.filter((x) => x !== u),
          });
        }}
      >
        <div
          style={{ width: totalWidth, height: Math.max(view.h, totalHeight) }}
        >
          <div
            className="pro-viewport"
            style={{ width: view.w, height: view.h }}
          >
            <canvas
              data-renderer="main"
              key={canvasEpoch}
              ref={canvas}
              aria-label="Timeline waveform canvas"
              onPointerDown={down}
              onPointerMove={move}
              onPointerUp={up}
              onPointerCancel={up}
              onContextMenu={context}
            />
            <canvas className="pro-overlay" ref={overlayCanvas} aria-hidden="true" />
            {videos.length > 0 && (
              <VideoStrip
                videos={videos}
                zoom={zoom}
                x={view.x}
                y={view.y}
                width={view.w}
              />
            )}
            <div
              className="pro-playhead-handle"
              role="slider"
              tabIndex={0}
              aria-label="Playhead"
              aria-valuemin={0}
              aria-valuemax={a.duration}
              aria-valuenow={position}
              style={{ left: 180 + position * zoom - view.x }}
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId);
                seek(position);
              }}
              onPointerMove={(e) => {
                if (e.buttons) seek(coordinates(e).time);
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                  e.preventDefault();
                  e.stopPropagation();
                  seek(position + (e.key === "ArrowRight" ? 0.1 : -0.1));
                }
              }}
            />
            <div className="pro-headers">
              {rows
                .filter(
                  (l) => l.y + l.height > view.y + 36 && l.y < view.y + view.h,
                )
                .map((l) => (
                  <div
                    key={l.id}
                    className="pro-header"
                    style={{
                      top: l.y - view.y,
                      height: l.height,
                      borderColor: l.color,
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setMenu({
                        x: 10,
                        y: l.y - view.y,
                        time: position,
                        lane: l.id,
                        kind: "track",
                      });
                    }}
                  >
                    <input
                      aria-label={`Track name ${l.id}`}
                      value={l.name}
                      onChange={(e) =>
                        updateLane(l.id, { name: e.target.value.slice(0, 60) })
                      }
                    />
                    <div className="pro-track-row">
                      <button
                        type="button"
                        aria-label={`Mute ${l.name}`}
                        aria-pressed={l.mute}
                        onClick={() => updateLane(l.id, { mute: !l.mute })}
                      >
                        M
                      </button>
                      <button
                        type="button"
                        aria-label={`Solo ${l.name}`}
                        aria-pressed={l.solo}
                        onClick={() => updateLane(l.id, { solo: !l.solo })}
                      >
                        S
                      </button>
                      <input
                        type="color"
                        aria-label={`Color ${l.name}`}
                        value={l.color}
                        onChange={(e) =>
                          updateLane(l.id, { color: e.target.value })
                        }
                      />
                    </div>
                    <label>
                      Volume dB
                      <input
                        aria-label={`Gain ${l.name}`}
                        type="range"
                        min={-60}
                        max={24}
                        step={0.1}
                        value={l.gain_db}
                        onChange={(e) =>
                          updateLane(l.id, { gain_db: Number(e.target.value) })
                        }
                      />
                      <small>{l.gain_db.toFixed(1)}</small>
                    </label>
                    {l.height >= 110 && (
                      <label>
                        Pan
                        <input
                          aria-label={`Pan ${l.name}`}
                          type="range"
                          min={-1}
                          max={1}
                          step={0.01}
                          value={l.pan}
                          onChange={(e) =>
                            updateLane(l.id, { pan: Number(e.target.value) })
                          }
                        />
                      </label>
                    )}
                    <div
                      role="separator"
                      aria-label={`Resize ${l.name}`}
                      tabIndex={0}
                      className="pro-resize"
                      onKeyDown={(e) => {
                        if (["ArrowUp", "ArrowDown"].includes(e.key))
                          updateLane(l.id, {
                            height: Math.max(
                              60,
                              Math.min(
                                400,
                                l.height + (e.key === "ArrowUp" ? -10 : 10),
                              ),
                            ),
                          });
                      }}
                      onPointerDown={(e) => {
                        e.currentTarget.setPointerCapture(e.pointerId);
                        e.currentTarget.dataset.y = String(e.clientY);
                        e.currentTarget.dataset.height = String(l.height);
                      }}
                      onPointerMove={(e) => {
                        if (
                          e.buttons &&
                          e.currentTarget.hasPointerCapture(e.pointerId)
                        )
                          updateLane(l.id, {
                            height: Math.round(
                              Math.max(
                                60,
                                Math.min(
                                  400,
                                  Number(e.currentTarget.dataset.height) +
                                    e.clientY -
                                    Number(e.currentTarget.dataset.y),
                                ),
                              ),
                            ),
                          });
                      }}
                    />
                  </div>
                ))}
            </div>
            {menu && (
              <div
                className="pro-context"
                role="menu"
                style={{
                  left: Math.min(view.w - 225, Math.max(0, menu.x)),
                  top: Math.min(view.h - 230, Math.max(36, menu.y)),
                }}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setMenu(null);
                }}
              >
                {(menu.kind === "region"
                  ? [
                      [
                        "Split at click",
                        () =>
                          split(
                            menu.time,
                            menu.region ? [menu.region] : selection,
                          ),
                      ],
                      ["Cut", () => copy(true)],
                      ["Copy", () => copy()],
                      ["Paste", () => paste(menu.time, menu.lane)],
                      ["Duplicate", duplicate],
                      ["Delete", () => remove()],
                      ["Ripple delete", () => remove(true)],
                      [
                        "Mute region",
                        () => patch(selection, { mute: !active?.mute }),
                      ],
                      [
                        "Rename",
                        () => {
                          const name = prompt(
                            "Region name",
                            active?.name ?? "",
                          );
                          if (name !== null)
                            patch(selection, { name: name.slice(0, 255) });
                        },
                      ],
                      [
                        "Color",
                        () => {
                          const color = prompt(
                            "Hex color",
                            active?.color ?? "#818CF8",
                          );
                          if (color) patch(selection, { color });
                        },
                      ],
                      [
                        "Fade in/out",
                        () => {
                          const n = prompt(
                            "Fade in / out seconds (default 0)",
                            "0",
                          );
                          if (n !== null)
                            patch(selection, {
                              fade_in: Number(n),
                              fade_out: Number(n),
                            });
                        },
                      ],
                      ["Normalize region", () => void normalize()],
                      [
                        "Region gain…",
                        () => {
                          const n = prompt(
                            "Region gain dB (default 0)",
                            String(active?.gain_db ?? 0),
                          );
                          if (n !== null)
                            patch(selection, { gain_db: Number(n) });
                        },
                      ],
                      ["Bounce in place", () => void bounce()],
                    ]
                  : menu.kind === "track"
                    ? [
                        [
                          "Select all on track",
                          () =>
                            setSelection(
                              a.regions
                                .filter((r) => r.lane === menu.lane)
                                .map((r) => r.id),
                            ),
                        ],
                        [
                          "Rename track",
                          () => {
                            const name = prompt(
                              "Track name",
                              a.lanes.find((l) => l.id === menu.lane)?.name,
                            );
                            if (name)
                              updateLane(menu.lane, {
                                name: name.slice(0, 60),
                              });
                          },
                        ],
                        [
                          "Move track up",
                          () => {
                            const lanes = [...a.lanes],
                              i = lanes.findIndex((l) => l.id === menu.lane);
                            if (i > 0) {
                              [lanes[i - 1], lanes[i]] = [
                                lanes[i],
                                lanes[i - 1],
                              ];
                              commit("Reorder tracks", { ...a, lanes });
                            }
                          },
                        ],
                        [
                          "Move track down",
                          () => {
                            const lanes = [...a.lanes],
                              i = lanes.findIndex((l) => l.id === menu.lane);
                            if (i < lanes.length - 1) {
                              [lanes[i + 1], lanes[i]] = [
                                lanes[i],
                                lanes[i + 1],
                              ];
                              commit("Reorder tracks", { ...a, lanes });
                            }
                          },
                        ],
                        [
                          "Remove track",
                          () => {
                            if (a.lanes.length > 1)
                              commit("Remove track", {
                                ...a,
                                lanes: a.lanes.filter(
                                  (l) => l.id !== menu.lane,
                                ),
                                regions: a.regions.filter(
                                  (r) => r.lane !== menu.lane,
                                ),
                                missing: a.missing.filter(
                                  (m) => m.lane !== menu.lane,
                                ),
                              });
                          },
                        ],
                      ]
                    : [
                        ["Paste", () => paste(menu.time, menu.lane)],
                        ["Add marker here", () => marker(menu.time)],
                        ["Set loop to selection", loopSelection],
                        [
                          "Select all on track",
                          () =>
                            setSelection(
                              a.regions
                                .filter((r) => r.lane === menu.lane)
                                .map((r) => r.id),
                            ),
                        ],
                      ]
                ).map(([label, action]) => (
                  <button
                    role="menuitem"
                    type="button"
                    key={String(label)}
                    onClick={() => {
                      (action as () => void)();
                      setMenu(null);
                    }}
                  >
                    {String(label)}
                  </button>
                ))}
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => setMenu(null)}
                >
                  Close
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="pro-toolbar">
        <button
          type="button"
          className="btn ghost"
          onClick={() =>
            commit("Add track", {
              ...a,
              lanes: [
                ...a.lanes,
                {
                  id: uid(),
                  name: `Track ${a.lanes.length + 1}`,
                  color: "#818CF8",
                  gain_db: 0,
                  pan: 0,
                  mute: false,
                  solo: false,
                  height: 120,
                  inserts: [],
                },
              ],
            })
          }
        >
          Add track
        </button>
        <button type="button" className="btn ghost" onClick={() => marker()}>
          Add marker (M)
        </button>
        <button
          type="button"
          className="btn ghost"
          onClick={() => {
            const previous = a.markers
              .filter((m) => m.time < position - 0.01)
              .sort((x, y) => y.time - x.time)[0];
            if (previous) seek(previous.time);
          }}
        >
          Previous marker
        </button>
        <button
          type="button"
          className="btn ghost"
          onClick={() => {
            const next = a.markers
              .filter((m) => m.time > position + 0.01)
              .sort((x, y) => x.time - y.time)[0];
            if (next) seek(next.time);
          }}
        >
          Next marker
        </button>
        <button
          type="button"
          className="btn ghost"
          aria-pressed={a.loop.enabled}
          onClick={() =>
            commit("Cycle", {
              ...a,
              loop: { ...a.loop, enabled: !a.loop.enabled },
            })
          }
        >
          Cycle (L)
        </button>
        <button type="button" className="btn ghost" onClick={loopSelection}>
          Set loop to selection
        </button>
        <label>
          Master (default 0 dB)
          <input
            type="range"
            min={-60}
            max={24}
            step={0.1}
            value={a.master.gain_db}
            onChange={(e) =>
              commit("Master", {
                ...a,
                master: { ...a.master, gain_db: Number(e.target.value) },
              })
            }
          />
          {a.master.gain_db} dB
        </label>
        <canvas
          className="pro-meter"
          width={120}
          height={20}
          ref={meter}
          aria-label="Master peak and RMS meter"
          onClick={() => {
            clipIndicator.current = false;
          }}
          title="Click to clear clipping indicator"
        />
      </div>
      {active && (
        <div className="pro-toolbar">
          <b>
            {active.name ?? a.clips.find((c) => c.id === active.clip)?.name}
          </b>
          <label>
            Region gain (dB)
            <input
              type="number"
              min={-60}
              max={24}
              value={active.gain_db}
              onChange={(e) =>
                e.target.value &&
                patch(selection, { gain_db: Number(e.target.value) })
              }
            />
          </label>
          <label>
            Fade in (default 0 s)
            <input
              type="number"
              min={0}
              step={0.01}
              value={active.fade_in}
              onChange={(e) =>
                e.target.value &&
                patch(selection, { fade_in: Number(e.target.value) })
              }
            />
          </label>
          <label>
            Fade out (default 0 s)
            <input
              type="number"
              min={0}
              step={0.01}
              value={active.fade_out}
              onChange={(e) =>
                e.target.value &&
                patch(selection, { fade_out: Number(e.target.value) })
              }
            />
          </label>
          <label>
            Fade curve
            <select
              value={active.fade_curve}
              onChange={(e) =>
                patch(selection, {
                  fade_curve: e.target.value as Region["fade_curve"],
                })
              }
            >
              <option value="linear">Linear (default)</option>
              <option value="equal_power">Equal power</option>
            </select>
          </label>
        </div>
      )}
      <details>
        <summary>Regions ({a.regions.length}) · select with keyboard</summary>
        <div className="pro-region-list">
          {a.regions.map((r) => (
            <button
              key={r.id}
              type="button"
              aria-label={`Region ${a.lines[r.line]?.text ?? r.name ?? r.id}`}
              aria-pressed={selection.includes(r.id)}
              onClick={(e) => {
                setSelection(e.shiftKey ? [...selection, r.id] : [r.id]);
                seek(r.start);
              }}
            >
              {r.name ??
                [...a.clips, ...a.derived_clips].find((c) => c.id === r.clip)
                  ?.name}{" "}
              · {rulerStamp(r.start, ruler, a)}
            </button>
          ))}
        </div>
      </details>
      <details>
        <summary>Markers ({a.markers.length})</summary>
        {a.markers.map((m) => (
          <div className="pro-toolbar" key={m.id}>
            <button type="button" onClick={() => seek(m.time)}>
              Jump
            </button>
            <input
              aria-label={`Marker name ${m.id}`}
              value={m.name}
              onChange={(e) =>
                commit("Rename marker", {
                  ...a,
                  markers: a.markers.map((x) =>
                    x.id === m.id
                      ? { ...x, name: e.target.value.slice(0, 80) }
                      : x,
                  ),
                })
              }
            />
            <input
              aria-label={`Marker color ${m.id}`}
              type="color"
              value={m.color}
              onChange={(e) =>
                commit("Marker color", {
                  ...a,
                  markers: a.markers.map((x) =>
                    x.id === m.id ? { ...x, color: e.target.value } : x,
                  ),
                })
              }
            />
            <button
              type="button"
              onClick={() =>
                commit("Delete marker", {
                  ...a,
                  markers: a.markers.filter((x) => x.id !== m.id),
                })
              }
            >
              Delete
            </button>
          </div>
        ))}
      </details>
      {help && (
        <div className="card" role="dialog" aria-label="Timeline shortcuts">
          <h3>Timeline shortcuts</h3>
          <p>
            V Move · C Razor · T Trim · F Fade · R Range · Z Zoom · H Hand ·
            Space Play/pause · Enter Stop/return · S Split · N Snap · M Marker ·
            L Cycle · Shift+Z Fit · Arrow keys Nudge · Shift+arrows 100 ms · Del
            Delete · Shift+Del Ripple delete · Cmd/Ctrl+C/X/V/D
            Copy/Cut/Paste/Duplicate · Cmd/Ctrl+Z Undo · Cmd/Ctrl+Shift+Z or
            Ctrl+Y Redo · Cmd/Ctrl +/− Zoom · Ctrl-wheel / pinch Zoom ·
            Alt-wheel Track height · Alt-drag Duplicate · Shift/Cmd-click
            Multi-select · ? Help.
          </p>
          <button type="button" className="btn" onClick={() => setHelp(false)}>
            Close shortcuts
          </button>
        </div>
      )}
    </section>
  );
}
