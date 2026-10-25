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
import {
  TimelineRenderer,
  IntervalIndex,
} from "../../public/daw/render-core.js";
import { ClipScene } from "../../public/daw/clip-scene.js";
import { createPortal } from "react-dom";
import ContextMenu, { type MenuAction } from "./context-menu";
import EffectsRack, { Mixer, Knob } from "./effects-rack";
import { importPlacement, COLORS } from "@/lib/editor/model";
import { moveSection } from "@/lib/daw/sections";
import { newEffect } from "@/lib/daw/effects";
import ToolIcon from "./icons/tool-icon";
import { shortcutTool, type ShortcutPreset } from "@/lib/daw/shortcuts";
import type { Placement } from "@/lib/editor/model";
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
  fullPage?: boolean;
  viewOpen?: boolean;
  onViewClose?: () => void;
  onProjectSettings?: () => void;
  onImport?: (files: File[], placement: Placement) => void;
  onRangeChange?: (span: [number, number] | null) => void;
  shortcutPreset?: ShortcutPreset;
  transport?: RefObject<DawTransport | null>;
  onPlayingChange?: (playing: boolean) => void;
  readWindow?: DawPlayback["reader"];
  playbackArrangement?: Arrangement;
  playbackPosition?: number;
  onPlaybackTick?: (time: number) => void;
  onPlaybackFrame?: (time: number, presenting?: boolean) => number | void;
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
  onSeek?: (t: number) => number | void;
  playing?: boolean;
  onToggle?: () => void;
  readOnly?: boolean;
};
const EMPTY = {};
const EMPTY_OVERLAYS: DawOverlay[] = [];
const EMPTY_VIDEOS: DawVideo[] = [];
export default function DawTimeline({
  fullPage = false,
  viewOpen = false,
  onViewClose,
  onProjectSettings,
  onImport,
  onRangeChange,
  shortcutPreset = "timeline",
  transport,
  onPlayingChange,
  readWindow,
  playbackArrangement,
  playbackPosition,
  onPlaybackTick,
  onPlaybackFrame,
  arrangement: a,
  onChange,
  onPreview,
  onUndo,
  onRedo,
  assets = EMPTY,
  audioUrls = EMPTY,
  overlays = EMPTY_OVERLAYS,
  videos = EMPTY_VIDEOS,
  playhead: externalHead,
  onSeek,
  playing: externalPlaying,
  onToggle,
  readOnly = false,
}: Props) {
  const [dropHint, setDropHint] = useState<{
    x: number;
    y: number;
    time: number;
    lane: string;
  } | null>(null);
  const [dock, setDock] = useState<
      "Effects" | "Mixer" | "Markers" | "Regions" | null
    >(null),
    [fxTrack, setFxTrack] = useState(""),
    [fxClip, setFxClip] = useState<string | undefined>(),
    [dockHeight, setDockHeight] = useState(320),
    [headerWidth, setHeaderWidth] = useState(fullPage ? 200 : 180),
    [inspector, setInspector] = useState(false),
    [transportMount, setTransportMount] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (fullPage)
      setTransportMount(document.getElementById("editor-transport"));
  }, [fullPage]);
  const [sectionMenu, setSectionMenu] = useState<{
    x: number;
    y: number;
    id: string;
  } | null>(null);
  const closeSectionMenu = useCallback(() => setSectionMenu(null), []);
  const closeMenu = useCallback(() => setMenu(null), []);
  function openFX(id: string, clip?: string) {
    setFxTrack(id);
    setFxClip(clip);
    setDock("Effects");
  }
  const [ripple, setRipple] = useState(false);
  const [tool, setTool] = useState<Tool>("pointer"),
    [selection, setSelection] = useState<string[]>([]),
    [head, setHead] = useState(0),
    [playing, setPlaying] = useState(false),
    [, publishZoom] = useState(0),
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
  // Scroll coordinates belong to the painter. React only updates the coarse
  // row window (or video-strip props), never every audio-timeline scroll frame.
  const liveZoom = useRef(50);
  const zoom = liveZoom.current;
  const liveView = useRef(view);
  const clipSceneRoot = useRef<HTMLDivElement>(null);
  const clipScene = useRef(new ClipScene());
  const sceneCanvas = useRef<HTMLCanvasElement>(null);
  const rulerCanvas = useRef<HTMLCanvasElement>(null);
  const rulerRenderer = useRef(new TimelineRenderer());
  const headerPositions = useRef<HTMLDivElement>(null);
  const sectionStrip = useRef<HTMLDivElement>(null);
  const playheadHandle = useRef<HTMLDivElement>(null);
  const renderView = useRef<() => void>(() => {});
  const scheduleDraw = useCallback(() => {
    if (drawFrame.current) return;
    drawFrame.current = requestAnimationFrame(() => {
      drawFrame.current = 0;
      renderView.current();
    });
  }, []);
  function updateZoom(
    value: number | ((current: number) => number),
    publish = true,
  ) {
    liveZoom.current =
      typeof value === "function" ? value(liveZoom.current) : value;
    if (publish) publishZoom((revision) => revision + 1);
    scheduleDraw();
  }
  const setZoom = (value: number | ((current: number) => number)) =>
    updateZoom(value);
  useEffect(
    () => () => {
      cancelAnimationFrame(drawFrame.current);
      clipScene.current.close();
      renderer.current.close();
      rulerRenderer.current.close();
    },
    [],
  );
  const geometry = useRef({ left: 0, top: 0 });
  const [canvasEpoch, setCanvasEpoch] = useState(0);
  const painter = useRef<Worker | null>(null),
    paintCache = useRef<Record<string, unknown>>({});
  const renderer = useRef(new TimelineRenderer());
  const regionIndex = useMemo(() => new IntervalIndex(a.regions), [a.regions]);
  const overlayCanvas = useRef<HTMLCanvasElement>(null);
  const peaks = usePeaks(assets);
  useEffect(() => {
    const c = sceneCanvas.current;
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
    } catch (error) {
      c.dataset.rendererError = String(error);
      painter.current = null;
    }
  }, []);
  state.current = a;
  const paintHead = useRef<(t: number) => void>(() => {});
  const lastClock = useRef(0);
  const playbackCallbacks = useRef({ onPlaybackFrame, onPlaybackTick, onSeek });
  playbackCallbacks.current = { onPlaybackFrame, onPlaybackTick, onSeek };
  const playbackConfig = useRef({
    arrangement: playbackArrangement ?? a,
    urls: audioUrls,
  });
  playbackConfig.current = {
    arrangement: playbackArrangement ?? a,
    urls: audioUrls,
  };
  const publishPlayback = (time: number, presenting = true) => {
    const viewTime =
      playbackCallbacks.current.onPlaybackFrame?.(time, presenting) ?? time;
    headRef.current = viewTime;
    paintHead.current(viewTime);
    if (performance.now() - lastClock.current > 100) {
      lastClock.current = performance.now();
      setHead(viewTime);
      (
        playbackCallbacks.current.onPlaybackTick ??
        playbackCallbacks.current.onSeek
      )?.(time);
    }
  };
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
  useEffect(() => onRangeChange?.(range), [range, onRangeChange]);
  const totalHeight = (rows.at(-1)?.y ?? 36) + (rows.at(-1)?.height ?? 120);
  const totalWidth = Math.max(view.w, headerWidth + a.duration * zoom + 100);
  function stop() {
    engine.current?.stop();
    setPlaying(false);
  }
  const seek = useCallback((t: number) => {
    const wasPlaying = engine.current?.running;
    stop();
    t = Math.max(0, Math.min(state.current.duration, t));
    setHead(t);
    const output = playbackCallbacks.current.onSeek?.(t) ?? t;
    if (wasPlaying)
      void engine.current
        ?.play(
          playbackConfig.current.arrangement,
          output,
          playbackConfig.current.urls,
          publishPlayback,
          () => setPlaying(false),
        )
        .then(() => setPlaying(true))
        .catch((e) => setMessage(e.message));
  }, []);
  function commit(label: string, next: Arrangement, before = state.current) {
    if (readOnly) {
      setMessage("This timeline is read-only.");
      return false;
    }
    const result = arrangementSchema.safeParse(duration(next));
    if (!result.success) {
      (onPreview ?? onChange)(before);
      setMessage(result.error.issues[0]?.message ?? "Invalid edit");
      return false;
    }
    if (engine.current?.running) engine.current.update(result.data, audioUrls);
    onChange(history.current.execute(label, before, result.data), before);
    setHistoryTick((n) => n + 1);
    setMessage("");
    return true;
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
    if (!a.regions.length) {
      setMessage("Import or place audio before playing.");
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
        publishPlayback,
        () => setPlaying(false),
      );
    } catch (e) {
      setPlaying(false);
      setMessage((e as Error).message);
    }
  }
  useEffect(() => {
    if (engine.current?.running)
      engine.current.update(playbackArrangement ?? a, audioUrls);
  }, [a, playbackArrangement, audioUrls]);
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
      const rect = el.getBoundingClientRect();
      geometry.current = { left: rect.left, top: rect.top };
      liveView.current = {
        x: el.scrollLeft,
        y: el.scrollTop,
        w: el.clientWidth,
        h: el.clientHeight,
      };
      setView(liveView.current);
      scheduleDraw();
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
      if ((e.ctrlKey || e.metaKey) && e.shiftKey) {
        e.preventDefault();
        commit("Track zoom", {
          ...state.current,
          lanes: state.current.lanes.map((l) => ({
            ...l,
            height: Math.round(
              Math.max(60, Math.min(400, l.height - e.deltaY)),
            ),
          })),
        });
      } else if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        updateZoom(
          (z) =>
            Math.max(
              0.1,
              Math.min(
                2000,
                Math.round(z * Math.exp(-e.deltaY * 0.005) * 1e6) / 1e6,
              ),
            ),
          !fullPage ||
            !!videos.length ||
            !!overlays.length ||
            !!state.current.missing.length,
        );
      } else if (e.altKey) {
        e.preventDefault();
        const row = rows.find(
          (l) =>
            l.y <= e.clientY - geometry.current.top + el.scrollTop &&
            l.y + l.height > e.clientY - geometry.current.top + el.scrollTop,
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
      } else if (!el.contains(e.target as Node)) {
        // The fixed painting layer is a sibling of the native scrollbar. Let
        // the scroller own offsets without a huge scrolling canvas layer.
        e.preventDefault();
        const unit =
          e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1;
        el.scrollLeft += (e.deltaX + (e.shiftKey ? e.deltaY : 0)) * unit;
        if (!e.shiftKey) el.scrollTop += e.deltaY * unit;
      }
    };
    const shell = el.parentElement!;
    shell.addEventListener("wheel", wheel, { passive: false });
    return () => shell.removeEventListener("wheel", wheel);
  });
  useEffect(() => {
    if (!isPlaying || autoscroll === "off" || !scroller.current) return;
    const el = scroller.current,
      x = headerWidth + position * zoom;
    if (autoscroll === "smooth")
      el.scrollLeft = Math.max(0, x - el.clientWidth * 0.4);
    else if (
      x < el.scrollLeft + headerWidth ||
      x > el.scrollLeft + el.clientWidth - 30
    )
      el.scrollLeft = Math.max(0, x - headerWidth);
  }, [position, isPlaying, autoscroll, zoom]);
  renderView.current = () => {
    const zoom = liveZoom.current;
    const currentView = liveView.current;
    if (headerPositions.current)
      headerPositions.current.style.transform = `translate3d(0, ${-currentView.y}px, 0)`;
    const space = scroller.current?.firstElementChild as HTMLElement | null;
    if (space)
      space.style.width = `${Math.max(currentView.w, headerWidth + a.duration * zoom + 100)}px`;
    if (playheadHandle.current) {
      playheadHandle.current.style.left = `${headerWidth + headRef.current * zoom}px`;
      playheadHandle.current.style.transform = `translateX(${-currentView.x}px)`;
    }
    sectionStrip.current
      ?.querySelectorAll<HTMLElement>("[data-section-position]")
      .forEach((el) => {
        const section = a.sections.find(
          (s) => s.id === el.dataset.sectionPosition,
        );
        if (section) {
          el.style.left = `${headerWidth + section.start * zoom}px`;
          el.style.width = `${Math.max(35, (section.end - section.start) * zoom)}px`;
        }
        el.style.transform = `translateX(${-currentView.x}px)`;
      });
    paintHead.current(headRef.current);
    const common = {
      a,
      peaks,
      zoom,
      selection,
      range,
      ruler,
      rows,
      overlays,
      videos,
      headerWidth,
      dualRuler: fullPage,
      dpr: Math.min(devicePixelRatio || 1, 2),
    };
    if (rulerCanvas.current)
      rulerRenderer.current.draw(rulerCanvas.current, {
        ...common,
        view: { ...currentView, y: 0, h: 36 },
        rulerOnly: true,
      });
    if (
      clipSceneRoot.current &&
      fullPage &&
      !videos.length &&
      !overlays.length &&
      !a.missing.length
    ) {
      clipSceneRoot.current.style.display = "block";
      if (sceneCanvas.current)
        sceneCanvas.current.parentElement!.style.display = "none";
      clipScene.current.draw(clipSceneRoot.current, {
        ...common,
        view: currentView,
      });
      return;
    }
    if (clipSceneRoot.current) clipSceneRoot.current.style.display = "none";
    if (sceneCanvas.current)
      sceneCanvas.current.parentElement!.style.display = "block";
    const sceneView = currentView;
    const c = sceneCanvas.current;
    if (!c) return;
    c.style.width = `${sceneView.w}px`;
    c.style.height = `${sceneView.h}px`;
    c.style.transform = `translate(${-headerWidth}px, -36px)`;
    if (painter.current) {
      const cache = paintCache.current,
        packet: Record<string, unknown> = {
          view: sceneView,
          contentOnly: true,
          zoom,
          selection,
          range,
          ruler,
          rows,
          videos,
          headerWidth,
          dualRuler: fullPage,
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
      Object.assign(packet, { headerWidth, dualRuler: fullPage });
      painter.current.postMessage(packet);
      return;
    }
    const draw = () => {
      const c = sceneCanvas.current;
      if (!c) return;
      renderer.current.draw(c, {
        a,
        peaks,
        view: sceneView,
        contentOnly: true,
        zoom,
        selection,
        range,
        ruler,
        rows,
        overlays,
        videos,
        headerWidth,
        dualRuler: fullPage,
        dpr: Math.min(devicePixelRatio || 1, 2),
      });
    };
    draw();
  };
  useEffect(scheduleDraw, [
    canvasEpoch,
    headerWidth,
    fullPage,
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
  const headPaint = useRef<{
    width: number;
    height: number;
    dpr: number;
    x: number | null;
  } | null>(null);
  paintHead.current = (time: number) => {
    const zoom = liveZoom.current;
    const c = overlayCanvas.current,
      ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    if (
      c.width !== Math.round(view.w * dpr) ||
      c.height !== Math.round(view.h * dpr)
    ) {
      c.width = Math.round(view.w * dpr);
      c.height = Math.round(view.h * dpr);
    }
    const px = headerWidth + time * zoom - liveView.current.x;
    const x = px >= headerWidth && px <= view.w ? px : null;
    const old = headPaint.current;
    const resized =
      !old ||
      old.width !== c.width ||
      old.height !== c.height ||
      old.dpr !== dpr;
    if (!resized && old.x === x) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (resized) ctx.clearRect(0, 0, view.w, view.h);
    else if (old.x !== null) ctx.clearRect(Math.floor(old.x) - 1, 0, 4, view.h);
    if (x !== null) {
      ctx.fillStyle = "#F472B6";
      ctx.fillRect(x, 0, 2, view.h);
    }
    headPaint.current = { width: c.width, height: c.height, dpr, x };
  };
  useEffect(() => paintHead.current(position), [position, view, zoom]);
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
    const zoom = liveZoom.current;
    const rect = geometry.current;
    const x = e.clientX - rect.left,
      y = e.clientY - rect.top;
    return {
      x,
      y,
      time: Math.max(0, (x + liveView.current.x - headerWidth) / zoom),
      lane:
        rows.find(
          (l) =>
            y + liveView.current.y >= l.y &&
            y + liveView.current.y < l.y + l.height,
        )?.id ?? "",
    };
  }
  function hit(time: number, lane: string) {
    return regionIndex
      .query(lane, time, time)
      .reverse()
      .find((r) => r.lane === lane && time >= r.start && time <= end(r));
  }
  function split(time = headRef.current, ids = selection) {
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
  function remove(follow = ripple) {
    commit(
      follow ? "Ripple delete" : "Delete",
      deleteRegions(a, selection, follow),
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
    const zoom = liveZoom.current;
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
    const zoom = liveZoom.current;
    if (e.button !== 0) return;
    setMenu(null);
    root.current?.focus({ preventScroll: true });
    const rect = scroller.current!.getBoundingClientRect();
    geometry.current = { left: rect.left, top: rect.top };
    const p = coordinates(e);
    if (p.x < headerWidth) return;
    const r = hit(p.time, p.lane),
      overlay = overlays.find(
        (o) =>
          o.lane === p.lane &&
          p.time >= o.start &&
          p.time <= o.end &&
          p.y + liveView.current.y >
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
        time: liveView.current.x,
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
      const row = rows.find((l) => l.id === r.lane),
        gainY =
          (row?.y ?? 0) +
          25 +
          ((24 - r.gain_db) / 84) * ((row?.height ?? 96) - 40);
      const nearGain =
        fullPage && Math.abs(p.y + liveView.current.y - gainY) < 4;
      const edge = 6 / zoom;
      if (tool === "fade")
        mode =
          Math.abs(p.time - r.start) < Math.abs(p.time - end(r))
            ? "fade_in"
            : "fade_out";
      else if (
        tool === "pointer" &&
        p.y + liveView.current.y <
          (rows.find((l) => l.id === r.lane)?.y ?? 0) + 22 &&
        p.time - r.start < Math.max(edge, 15 / zoom)
      )
        mode = "fade_in";
      else if (
        tool === "pointer" &&
        p.y + liveView.current.y <
          (rows.find((l) => l.id === r.lane)?.y ?? 0) + 22 &&
        end(r) - p.time < Math.max(edge, 15 / zoom)
      )
        mode = "fade_out";
      else if (nearGain && tool === "pointer") mode = "gain";
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
    const zoom = liveZoom.current;
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
        const minY = Math.min(d.y, p.y) + liveView.current.y,
          maxY = Math.max(d.y, p.y) + liveView.current.y;
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
      if (d.mode === "gain") {
        const row = rows.find((l) => l.id === r.lane);
        return {
          ...r,
          gain_db: Math.max(
            -60,
            Math.min(
              24,
              r.gain_db + ((d.y - p.y) * 84) / ((row?.height ?? 96) - 40),
            ),
          ),
        };
      }
      if (r.reverse && d.mode === "trim_start") {
        const limit = [...a.clips, ...a.derived_clips].find(
          (c) => c.id === r.clip,
        )!.duration;
        const value = Math.max(
          r.src_start + 0.001,
          Math.min(limit, r.src_end - delta),
        );
        return {
          ...r,
          src_end: value,
          start: Math.max(0, r.start + r.src_end - value),
        };
      }
      if (r.reverse && d.mode === "trim_end")
        return {
          ...r,
          src_start: Math.max(
            0,
            Math.min(r.src_end - 0.001, r.src_start - delta),
          ),
        };
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
    if (ripple && d.mode === "move" && !d.clone) {
      for (const old of d.before.regions) {
        if (d.ids.includes(old.id)) continue;
        const selected = d.before.regions.filter(
          (r) => d.ids.includes(r.id) && r.lane === old.lane,
        );
        if (selected.length && old.start >= Math.max(...selected.map(end))) {
          const i = altered.findIndex((r) => r.id === old.id);
          altered[i] = {
            ...old,
            start: Math.max(0, old.start + Math.max(-minStart, snapped)),
          };
        }
      }
    }
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
            first.fade_curve = second.fade_curve = "equal_power";
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
          reverse: r.reverse,
          inserts: r.inserts,
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
          reverse: false,
          inserts: [],
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
      if (commit("Bounce in place", { ...a, derived_clips: derived, regions }))
        setMessage(
          "Bounced in place. No export job or processing minutes used.",
        );
    } catch {
      setMessage(
        "Bounce could not read the source. Your regions are unchanged.",
      );
    }
  }
  function context(e: React.MouseEvent) {
    const zoom = liveZoom.current;
    e.preventDefault();
    const p = coordinates(e),
      r = hit(p.time, p.lane);
    if (r && !selection.includes(r.id)) setSelection([r.id]);
    setMenu({
      x: e.clientX,
      y: e.clientY,
      time: p.time,
      lane: p.lane,
      region: r?.id,
      kind:
        p.x < headerWidth
          ? "track"
          : p.y < 36
            ? "ruler"
            : r
              ? "region"
              : "lane",
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
    const zoom = liveZoom.current;
    if (
      (e.target as HTMLElement).closest(
        "input,textarea,select,[contenteditable]",
      )
    )
      return;
    if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
      e.preventDefault();
      const box = scroller.current!.getBoundingClientRect(),
        r = a.regions.find((r) => selection.includes(r.id)),
        lane = (e.target as HTMLElement).closest<HTMLElement>("[data-track]")
          ?.dataset.track;
      setMenu({
        x: box.left + headerWidth + 20,
        y: box.top + 60,
        time: r?.start ?? position,
        lane: lane ?? r?.lane ?? a.lanes[0]?.id ?? "",
        region: r?.id,
        kind:
          (e.target as HTMLElement).getAttribute("aria-label") === "Playhead"
            ? "ruler"
            : lane
              ? "track"
              : r
                ? "region"
                : "lane",
      });
      return;
    }
    if (e.key === "Escape") {
      setMenu(null);
      return;
    }
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
      stop();
      setHead(0);
      onSeek?.(0);
      return;
    }
    if (k === "delete" || k === "backspace") {
      e.preventDefault();
      remove(e.shiftKey || ripple);
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
      commit("Loop Window", {
        ...a,
        loop: { ...a.loop, enabled: !a.loop.enabled },
      });
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
    const mapped = shortcutTool(k, shortcutPreset);
    if (mapped) {
      e.preventDefault();
      setTool(mapped as Tool);
    }
    if (k === "x" && !mod) {
      setDock((d) => (d ? null : "Mixer"));
      setFxTrack((t) => t || a.lanes[0]?.id || "master");
    }
  }
  function addTrack() {
    commit("Add track", {
      ...a,
      lanes: [
        ...a.lanes,
        {
          id: uid(),
          name: `Track ${a.lanes.length + 1}`,
          color: COLORS[a.lanes.length % COLORS.length],
          gain_db: 0,
          pan: 0,
          mute: false,
          solo: false,
          height: 96,
          inserts: [],
        },
      ],
    });
  }
  function menuItems(): MenuAction[] {
    if (!menu) return [];
    const l = a.lanes.find((l) => l.id === menu.lane),
      r = a.regions.find((r) => r.id === menu.region);
    const action = (label: string, action: () => void, disabled = false) => ({
      label,
      action,
      disabled,
    });
    const colour = (track = false) => {
      const value = prompt(
        "Hex colour",
        track ? l?.color : (r?.color ?? l?.color),
      );
      if (value && /^#[0-9a-fA-F]{6}$/.test(value))
        track
          ? updateLane(menu.lane, { color: value })
          : patch(selection, { color: value });
    };
    if (menu.kind === "region" && r)
      return [
        action("Cut", () => copy(true)),
        action("Copy", () => copy()),
        action(
          "Paste",
          () => paste(menu.time, menu.lane),
          !clipboard.current.length,
        ),
        action("Duplicate", duplicate),
        action("Split at playhead", () => split()),
        action("Split at cursor", () => split(menu.time, [r.id])),
        action("Delete", () => remove()),
        action("Ripple delete", () => remove(true)),
        action("Mute clip", () => patch(selection, { mute: !r.mute })),
        action("Rename", () => {
          const name = prompt("Clip name", r.name ?? "");
          if (name !== null) patch(selection, { name: name.slice(0, 255) });
        }),
        action("Colour", () => colour()),
        action("Clip gain +1 dB", () =>
          patch(selection, { gain_db: Math.min(24, r.gain_db + 1) }),
        ),
        action("Clip gain −1 dB", () =>
          patch(selection, { gain_db: Math.max(-60, r.gain_db - 1) }),
        ),
        action("Normalize clip", () => void normalize()),
        action("Fade in / out", () => {
          const n = Number(prompt("Fade seconds", "0.1"));
          if (Number.isFinite(n) && n >= 0)
            patch(selection, {
              fade_in: Math.min(n, end(r) - r.start),
              fade_out: Math.min(n, end(r) - r.start),
            });
        }),
        action("Crossfade", () => {
          patch(selection, {
            fade_in: Math.min(0.05, end(r) - r.start),
            fade_out: Math.min(0.05, end(r) - r.start),
            fade_curve: "equal_power",
          });
        }),
        action("Reverse", () => patch(selection, { reverse: !r.reverse })),
        action("Bounce / consolidate", () => void bounce()),
        action("Add effect to clip", () => openFX(r.lane, r.id)),
      ];
    if (menu.kind === "track" && l)
      return [
        action("Rename track", () => {
          const name = prompt("Track name", l.name);
          if (name) updateLane(l.id, { name: name.slice(0, 60) });
        }),
        action("Colour", () => colour(true)),
        action("Duplicate track", () => {
          const id = uid();
          commit("Duplicate track", {
            ...a,
            lanes: [
              ...a.lanes,
              { ...l, id, name: `${l.name} copy`.slice(0, 60) },
            ],
            regions: [
              ...a.regions,
              ...a.regions
                .filter((r) => r.lane === l.id)
                .map((r) => ({ ...r, id: uid(), lane: id })),
            ],
          });
        }),
        action(
          "Delete track",
          () =>
            commit("Delete track", {
              ...a,
              lanes: a.lanes.filter((x) => x.id !== l.id),
              regions: a.regions.filter((r) => r.lane !== l.id),
              missing: a.missing.filter((m) => m.lane !== l.id),
            }),
          !a.editor_project && a.lanes.length === 1,
        ),
        action("Add effect", () => openFX(l.id)),
        action("Freeze (later)", () => {}, true),
        ...[-1, 1].map((d) =>
          action(
            d < 0 ? "Move up" : "Move down",
            () => {
              const lanes = [...a.lanes],
                i = lanes.findIndex((x) => x.id === l.id);
              if (lanes[i + d]) {
                [lanes[i], lanes[i + d]] = [lanes[i + d], lanes[i]];
                commit("Move track", { ...a, lanes });
              }
            },
            d < 0 ? a.lanes[0].id === l.id : a.lanes.at(-1)?.id === l.id,
          ),
        ),
        ...([72, 96, 180] as const).map((height, i) =>
          action(`Height ${["S", "M", "L"][i]}`, () =>
            updateLane(l.id, { height }),
          ),
        ),
      ];
    if (menu.kind === "ruler")
      return [
        action("Add marker", () => marker(menu.time)),
        action("Set loop start", () =>
          commit("Loop start", {
            ...a,
            loop: { ...a.loop, start: Math.min(menu.time, a.loop.end - 0.001) },
          }),
        ),
        action("Set loop end", () =>
          commit("Loop end", {
            ...a,
            loop: {
              ...a.loop,
              end: Math.max(
                a.loop.start + 0.001,
                Math.min(a.duration, menu.time),
              ),
            },
          }),
        ),
        action("Zoom to fit", () => fit()),
      ];
    return [
      action(
        "Paste",
        () => paste(menu.time, menu.lane || undefined),
        !clipboard.current.length,
      ),
      action("Add track", addTrack),
      action("Add marker", () => marker(menu.time)),
      action("Set loop here", () =>
        commit("Loop here", {
          ...a,
          loop: {
            enabled: true,
            start: menu.time,
            end: Math.min(a.duration, menu.time + (60 / a.tempo) * 4),
          },
        }),
      ),
      action("Import audio here", () => {
        const input = document.createElement("input");
        input.type = "file";
        input.multiple = true;
        input.accept = "audio/*";
        input.onchange = () =>
          onImport?.(Array.from(input.files ?? []), {
            time: menu.time,
            lane: menu.lane || undefined,
          });
        input.click();
      }),
    ];
  }
  return (
    <section
      className={`pro-daw ${fullPage ? "daw-fullpage" : ""}`}
      style={{ "--header-width": `${headerWidth}px` } as React.CSSProperties}
      aria-label="DAW timeline"
      tabIndex={0}
      ref={root}
      onKeyDown={shortcut}
      data-history={historyTick}
    >
      {fullPage &&
        transportMount &&
        createPortal(
          <div className="daw-transport">
            <button
              aria-label={isPlaying ? "Pause" : "Play"}
              title="Play / pause · Space"
              onClick={() => void toggle()}
            >
              {isPlaying ? "Ⅱ" : "▶"}
            </button>
            <button
              aria-label="Stop / return"
              title="Stop · Enter"
              onClick={() => {
                stop();
                seek(0);
              }}
            >
              ■
            </button>
            <button
              disabled
              aria-label="Record disabled"
              title="Recording is not available"
            >
              ●
            </button>
            <button
              aria-label="Loop"
              aria-pressed={a.loop.enabled}
              onClick={() =>
                commit("Loop", {
                  ...a,
                  loop: { ...a.loop, enabled: !a.loop.enabled },
                })
              }
            >
              ↻
            </button>
            <output aria-label="Current time">
              {rulerStamp(position, "minsec", a)}
            </output>
            <label>
              BPM
              <input
                aria-label="Tempo"
                type="number"
                min={20}
                max={300}
                value={a.tempo}
                onChange={(e) => {
                  if (e.target.value)
                    commit("Tempo", { ...a, tempo: +e.target.value });
                }}
              />
            </label>
            <span>{a.time_signature.join("/")}</span>
            <button
              aria-pressed={a.snap}
              onClick={() => commit("Snap", { ...a, snap: !a.snap })}
            >
              Snap
            </button>
          </div>,
          transportMount,
        )}
      {fullPage && (
        <div
          className="daw-toolstrip"
          role="toolbar"
          aria-label="Timeline tools"
        >
          {(
            [
              ["pointer", "Shape V"],
              ["razor", "Blade C"],
              ["trim", "Trim T"],
              ["fade", "Fade F"],
              ["range", "Span R"],
              ["zoom", "Lens Z"],
              ["hand", "Pan Hand H"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              title={label}
              aria-label={label}
              aria-pressed={tool === id}
              onClick={() => setTool(id)}
            >
              <ToolIcon tool={id} />
            </button>
          ))}
          <span className="daw-tool-divider" />
          <button title="Undo · Cmd/Ctrl+Z" aria-label="Undo" onClick={undo}>
            ↶
          </button>
          <button
            title="Redo · Cmd/Ctrl+Shift+Z"
            aria-label="Redo"
            onClick={redo}
          >
            ↷
          </button>
          <button
            onClick={() => setInspector((i) => !i)}
            aria-pressed={inspector}
          >
            Track Panel
          </button>
          <button
            onClick={() => setDock((d) => (d ? null : "Mixer"))}
            aria-pressed={!!dock}
          >
            Dock · X
          </button>
          <button onClick={() => fit()}>Fit</button>
          <span className="daw-tool-fill" />
          <span>
            {a.lanes.length} tracks · {a.regions.length} clips
          </span>
          <button aria-label="Shortcuts" onClick={() => setHelp((h) => !h)}>
            ?
          </button>
        </div>
      )}
      {(!fullPage || viewOpen) && (
        <div
          className={fullPage ? "daw-view-popover" : ""}
          aria-label="View settings"
        >
          {" "}
          <div className="pro-toolbar daw-view-controls">
            <button type="button" className="btn" onClick={() => void toggle()}>
              {isPlaying ? "Pause" : "Play"}
            </button>
            <button
              type="button"
              className="btn ghost"
              onClick={() => {
                stop();
                setHead(0);
                onSeek?.(0);
              }}
            >
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
            <button
              type="button"
              className="btn ghost"
              disabled
              title="Recording coming soon"
            >
              Record arm · Coming soon
            </button>
            <button
              type="button"
              className="btn ghost"
              onClick={() => setMessage("Mixer · Coming soon")}
            >
              Mixer (X)
            </button>
            <label>
              Edit movement
              <select
                value={ripple ? "ripple" : "free"}
                onChange={(e) => setRipple(e.target.value === "ripple")}
              >
                <option value="free">Free Place</option>
                <option value="ripple">Ripple Follow</option>
              </select>
            </label>
            <label>
              Autoscroll
              <select
                value={autoscroll}
                onChange={(e) => setAutoscroll(e.target.value)}
              >
                <option value="page">Page</option>
                <option value="smooth">Smooth</option>
                <option value="off">Off</option>
              </select>
            </label>
          </div>
          <div
            className="pro-toolbar"
            role="toolbar"
            aria-label="Timeline tools"
          >
            {(
              [
                ["pointer", "Shape V"],
                ["razor", "Blade C"],
                ["trim", "Trim T"],
                ["fade", "Fade F"],
                ["range", "Span R"],
                ["zoom", "Lens Z"],
                ["hand", "Pan Hand H"],
              ] as const
            ).map(([id, name]) => (
              <button
                type="button"
                key={id}
                className={`btn ${tool === id ? "" : "ghost"}`}
                aria-pressed={tool === id}
                onClick={() => setTool(id)}
              >
                <ToolIcon tool={id} />
                {name}
              </button>
            ))}
            <button type="button" className="btn ghost" onClick={() => split()}>
              Split at playhead (S)
            </button>
            <button
              type="button"
              className="btn ghost"
              onClick={() => remove()}
            >
              Delete region
            </button>
          </div>
          <div className="pro-toolbar">
            <label>
              <input
                type="checkbox"
                checked={a.snap}
                onChange={(e) =>
                  commit("Snap", { ...a, snap: e.target.checked })
                }
              />
              Snap
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
                  "bars",
                  "markers",
                ].map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </label>
            <label>
              Ruler
              <select value={ruler} onChange={(e) => setRuler(e.target.value)}>
                {[
                  "minsec",
                  "timecode24",
                  "timecode25",
                  "timecode30",
                  "bars",
                ].map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </label>
            <label>
              Tempo
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
                    time_signature: [
                      Number(e.target.value),
                      a.time_signature[1],
                    ],
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
            <button
              type="button"
              className="btn ghost"
              onClick={() => fit(true)}
            >
              Zoom to selection
            </button>
          </div>
          {fullPage && (
            <>
              <button onClick={onProjectSettings}>
                Project settings / shortcuts
              </button>
              <button onClick={onViewClose}>Close view settings</button>
            </>
          )}
        </div>
      )}
      {fullPage && active && (
        <div className="daw-info" aria-label="Selected clip info">
          <input
            aria-label="Selected clip name"
            value={active.name ?? ""}
            onChange={(e) =>
              patch(selection, { name: e.target.value.slice(0, 255) })
            }
          />
          {(
            [
              ["Start", active.start],
              ["End", end(active)],
              ["Length", end(active) - active.start],
            ] as const
          ).map(([label, value]) => (
            <label key={label}>
              {label}
              <input
                aria-label={`Clip ${label.toLowerCase()}`}
                type="number"
                step={0.01}
                value={value}
                onChange={(e) => {
                  const n = +e.target.value;
                  if (!Number.isFinite(n)) return;
                  if (label === "Start") patch(selection, { start: n });
                  else
                    patch(selection, {
                      src_end:
                        active.src_start +
                        (label === "End" ? n - active.start : n),
                    });
                }}
              />
            </label>
          ))}
        </div>
      )}
      {fullPage && inspector && (
        <aside className="daw-inspector">
          <b>Track Panel</b>
          <select
            aria-label="Inspect track"
            value={fxTrack}
            onChange={(e) => setFxTrack(e.target.value)}
          >
            <option value="">Choose track…</option>
            {a.lanes.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
          {a.lanes
            .filter((l) => l.id === fxTrack)
            .map((l) => (
              <div key={l.id}>
                <b>{l.name}</b>
                <p>
                  Input: imported audio
                  <br />
                  Output: Master
                </p>
                <Knob
                  label="Track volume"
                  value={l.gain_db}
                  spec={[0, -60, 24, 0.1]}
                  onChange={(gain_db) => updateLane(l.id, { gain_db })}
                />
                <Knob
                  label="Track pan"
                  value={l.pan}
                  spec={[0, -1, 1, 0.01]}
                  onChange={(pan) => updateLane(l.id, { pan })}
                />
                <button onClick={() => openFX(l.id)}>
                  Inserts ({l.inserts.length})
                </button>
                <p>Sends: not routed</p>
              </div>
            ))}
          <b>Sections</b>
          {a.sections.map((section) => (
            <button key={section.id} onClick={() => seek(section.start)}>
              {section.name}
            </button>
          ))}
        </aside>
      )}
      {fullPage && (
        <div
          className="daw-sections"
          ref={sectionStrip}
          aria-label="Sections lane"
        >
          <span style={{ width: headerWidth }}>Sections</span>
          {a.sections.map((s, i) => (
            <button
              key={s.id}
              draggable
              data-section-position={s.id}
              title="Drag to reorder · Alt+D duplicate · Enter loop · Shift+F10 menu"
              aria-label={`Section ${s.name}`}
              style={{
                left: headerWidth + s.start * zoom,
                transform: `translateX(${-liveView.current.x}px)`,
                width: Math.max(35, (s.end - s.start) * zoom),
                background: s.color + "66",
                borderColor: s.color,
              }}
              onDragStart={(e) =>
                e.dataTransfer.setData("application/x-section", s.id)
              }
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                commit(
                  "Move section",
                  moveSection(
                    a,
                    e.dataTransfer.getData("application/x-section"),
                    i,
                  ),
                );
              }}
              onDoubleClick={() => {
                const name = prompt("Section name", s.name);
                if (name)
                  commit("Rename section", {
                    ...a,
                    sections: a.sections.map((x) =>
                      x.id === s.id ? { ...x, name: name.slice(0, 60) } : x,
                    ),
                  });
              }}
              onClick={() => seek(s.start)}
              onContextMenu={(e) => {
                e.preventDefault();
                setSectionMenu({ x: e.clientX, y: e.clientY, id: s.id });
              }}
              onKeyDown={(e) => {
                if (
                  e.key === "ContextMenu" ||
                  (e.shiftKey && e.key === "F10")
                ) {
                  e.preventDefault();
                  e.stopPropagation();
                  const b = e.currentTarget.getBoundingClientRect();
                  setSectionMenu({ x: b.left, y: b.bottom, id: s.id });
                }
                if (e.altKey && e.key.toLowerCase() === "d") {
                  e.preventDefault();
                  commit(
                    "Duplicate section",
                    moveSection(a, s.id, i + 1, true),
                  );
                }
                if (e.key === "Enter") {
                  e.preventDefault();
                  e.stopPropagation();
                  commit("Loop section", {
                    ...a,
                    loop: { enabled: true, start: s.start, end: s.end },
                  });
                }
                if (e.altKey && ["ArrowLeft", "ArrowRight"].includes(e.key)) {
                  e.preventDefault();
                  e.stopPropagation();
                  commit(
                    "Reorder section",
                    moveSection(a, s.id, i + (e.key === "ArrowLeft" ? -1 : 1)),
                  );
                }
              }}
            >
              {s.name}
            </button>
          ))}
          <button
            className="section-add"
            onClick={() => {
              const start = a.sections.at(-1)?.end ?? 0,
                finish = start + (60 / a.tempo) * a.time_signature[0] * 4;
              commit("Add section", {
                ...a,
                duration: Math.max(a.duration, finish),
                sections: [
                  ...a.sections,
                  {
                    id: uid(),
                    name: `Section ${a.sections.length + 1}`,
                    start,
                    end: finish,
                    color: COLORS[a.sections.length % COLORS.length],
                  },
                ],
              });
            }}
          >
            + Section
          </button>
        </div>
      )}
      {sectionMenu && (
        <ContextMenu
          x={sectionMenu.x}
          y={sectionMenu.y}
          onClose={closeSectionMenu}
          items={[
            {
              label: "Loop section",
              action: () => {
                const s = a.sections.find((s) => s.id === sectionMenu.id)!;
                commit("Loop section", {
                  ...a,
                  loop: { enabled: true, start: s.start, end: s.end },
                });
              },
            },
            {
              label: "Duplicate section",
              action: () =>
                commit(
                  "Duplicate section",
                  moveSection(
                    a,
                    sectionMenu.id,
                    a.sections.findIndex((s) => s.id === sectionMenu.id) + 1,
                    true,
                  ),
                ),
            },
            {
              label: "Rename section",
              action: () => {
                const name = prompt("Section name");
                if (name)
                  commit("Rename section", {
                    ...a,
                    sections: a.sections.map((s) =>
                      s.id === sectionMenu.id
                        ? { ...s, name: name.slice(0, 60) }
                        : s,
                    ),
                  });
              },
            },
            {
              label: "Delete section",
              action: () =>
                commit("Delete section", {
                  ...a,
                  sections: a.sections.filter((s) => s.id !== sectionMenu.id),
                }),
            },
          ]}
        />
      )}
      {message && <p role="alert">{message}</p>}
      <div
        className="pro-scroll-shell"
        onDragOver={(e) => {
          e.preventDefault();
          if (e.dataTransfer.types.includes("Files")) {
            const p = coordinates(e);
            e.dataTransfer.dropEffect = "copy";
            setDropHint(p);
          }
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node))
            setDropHint(null);
        }}
        onDrop={(e) => {
          const zoom = liveZoom.current;
          e.preventDefault();
          setDropHint(null);
          if (e.dataTransfer.files.length) {
            const p = coordinates(e);
            const point = {
              time: snapTime(a, p.time, snap, zoom),
              lane: p.lane || undefined,
            };
            if (onImport) onImport(Array.from(e.dataTransfer.files), point);
            else setMessage("Open in Editor Studio to import audio files.");
            return;
          }
          const libraryId = e.dataTransfer.getData("application/x-editor-clip");
          if (libraryId) {
            const clip = a.clips.find((c) => c.id === libraryId);
            if (clip) {
              const p = coordinates(e);
              commit(
                "Place library clip",
                importPlacement(
                  a,
                  clip,
                  { time: p.time, lane: p.lane || undefined },
                  snap,
                  zoom,
                ),
              );
            }
            return;
          }
          if (!e.dataTransfer.getData("text/plain")) return;
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
                reverse: false,
                inserts: [],
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
          className="pro-scroll"
          ref={scroller}
          onScroll={(e) => {
            const el = e.currentTarget;
            const x = el.scrollLeft,
              y = el.scrollTop;
            liveView.current = { ...liveView.current, x, y };
            const band = Math.floor(y / Math.max(1, view.h)) * view.h;
            if (videos.length || band !== view.y)
              setView((v) => ({
                ...v,
                x: videos.length ? x : 0,
                y: videos.length ? y : band,
              }));
            scheduleDraw();
          }}
        >
          <div
            className="pro-scroll-space"
            style={{ width: totalWidth, height: Math.max(view.h, totalHeight) }}
          />
        </div>
        <div className="pro-viewport" style={{ width: view.w, height: view.h }}>
          <div
            ref={clipSceneRoot}
            className="pro-clip-scene"
            style={{ left: headerWidth, top: 36 }}
            aria-hidden="true"
          />
          <div
            className="pro-scene-clip"
            style={{ left: headerWidth, top: 36 }}
            aria-hidden="true"
          >
            <canvas ref={sceneCanvas} key={canvasEpoch} />
          </div>
          <canvas ref={rulerCanvas} className="pro-ruler" aria-hidden="true" />
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
          {dropHint && (
            <div
              className="pro-drop-ghost"
              style={{
                left: Math.max(headerWidth, dropHint.x),
                top: Math.max(36, dropHint.y),
              }}
            >
              Import at {dropHint.time.toFixed(2)} s{" "}
              {dropHint.lane ? "" : "· New tracks"}
            </div>
          )}
          <canvas
            className="pro-overlay"
            ref={overlayCanvas}
            aria-hidden="true"
          />
          {videos.length > 0 && (
            <VideoStrip
              videos={videos}
              headerWidth={headerWidth}
              zoom={zoom}
              x={liveView.current.x}
              y={liveView.current.y}
              width={view.w}
            />
          )}
          <div
            className="pro-playhead-handle"
            ref={playheadHandle}
            role="slider"
            tabIndex={0}
            aria-label="Playhead"
            aria-valuemin={0}
            aria-valuemax={a.duration}
            aria-valuenow={position}
            style={{
              left: headerWidth + position * zoom,
              transform: `translateX(${-liveView.current.x}px)`,
            }}
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
            <div
              className="pro-header-positions"
              ref={headerPositions}
              style={{
                transform: `translate3d(0, ${-liveView.current.y}px, 0)`,
              }}
            >
              {rows
                .filter(
                  (l) =>
                    l.y + l.height > view.y - view.h &&
                    l.y < view.y + view.h * 3,
                )
                .map((l) => (
                  <div
                    key={l.id}
                    className="pro-header"
                    tabIndex={0}
                    data-track={l.id}
                    onClick={() => setFxTrack(l.id)}
                    style={{
                      top: l.y,
                      height: l.height,
                      borderColor: l.color,
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setMenu({
                        x: e.clientX,
                        y: e.clientY,
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
                        updateLane(l.id, {
                          name: e.target.value.slice(0, 60),
                        })
                      }
                    />
                    <div className="pro-track-row">
                      {fullPage && (
                        <>
                          <button
                            disabled
                            aria-label={`Arm ${l.name}`}
                            title="Recording is not available"
                          >
                            ●
                          </button>
                          <button
                            aria-label={`FX ${l.name}`}
                            onClick={() => openFX(l.id)}
                          >
                            FX
                          </button>
                        </>
                      )}
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
                    {fullPage ? (
                      <div className="daw-track-knobs">
                        <Knob
                          label={`Gain ${l.name}`}
                          value={l.gain_db}
                          spec={[0, -60, 24, 0.1]}
                          onChange={(gain_db) => updateLane(l.id, { gain_db })}
                        />
                        <Knob
                          label={`Pan ${l.name}`}
                          value={l.pan}
                          spec={[0, -1, 1, 0.01]}
                          onChange={(pan) => updateLane(l.id, { pan })}
                        />
                      </div>
                    ) : (
                      <>
                        {" "}
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
                              updateLane(l.id, {
                                gain_db: Number(e.target.value),
                              })
                            }
                          />
                          <small>{l.gain_db.toFixed(1)}</small>
                        </label>
                        {(fullPage || l.height >= 110) && (
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
                                updateLane(l.id, {
                                  pan: Number(e.target.value),
                                })
                              }
                            />
                          </label>
                        )}
                      </>
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
          </div>
          {menu && (
            <ContextMenu
              x={menu.x}
              y={menu.y}
              items={menuItems()}
              onClose={closeMenu}
            />
          )}
          {fullPage && (
            <div
              className="daw-header-width"
              role="separator"
              aria-label="Track header width"
              aria-orientation="vertical"
              tabIndex={0}
              style={{ left: headerWidth - 3 }}
              onKeyDown={(e) => {
                if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                  e.preventDefault();
                  setHeaderWidth((w) =>
                    Math.max(
                      160,
                      Math.min(340, w + (e.key === "ArrowLeft" ? -10 : 10)),
                    ),
                  );
                }
              }}
              onPointerDown={(e) =>
                e.currentTarget.setPointerCapture(e.pointerId)
              }
              onPointerMove={(e) => {
                if (e.currentTarget.hasPointerCapture(e.pointerId))
                  setHeaderWidth(
                    Math.round(
                      Math.max(
                        160,
                        Math.min(
                          340,
                          e.clientX -
                            scroller.current!.getBoundingClientRect().left,
                        ),
                      ),
                    ),
                  );
              }}
              onPointerUp={(e) =>
                e.currentTarget.releasePointerCapture(e.pointerId)
              }
            />
          )}
        </div>
      </div>
      {!fullPage && (
        <>
          {" "}
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
            <button
              type="button"
              className="btn ghost"
              onClick={() => marker()}
            >
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
                commit("Loop Window", {
                  ...a,
                  loop: { ...a.loop, enabled: !a.loop.enabled },
                })
              }
            >
              Loop Window (L)
            </button>
            <button type="button" className="btn ghost" onClick={loopSelection}>
              Set loop to selection
            </button>
            <label>
              Master
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
                Fade in
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
                Fade out
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
                  <option value="linear">Linear</option>
                  <option value="equal_power">Equal power</option>
                </select>
              </label>
            </div>
          )}
          <details>
            <summary>
              Regions ({a.regions.length}) · select with keyboard
            </summary>
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
                    [...a.clips, ...a.derived_clips].find(
                      (c) => c.id === r.clip,
                    )?.name}{" "}
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
        </>
      )}
      {fullPage && (
        <>
          <div className="daw-statusbar">
            <button onClick={addTrack}>+ Add new track</button>
            <button onClick={() => setDock((d) => (d ? null : "Effects"))}>
              {dock ? "Hide dock" : "Effects / Mixer"}
            </button>
            <span>
              {a.sample_rate / 1000} kHz · {a.time_signature.join("/")} ·{" "}
              {isPlaying ? "Playing" : "Ready"}
            </span>
            <button onClick={() => openFX("master")}>Master FX</button>
            <output aria-label="Master level">
              {a.master.gain_db.toFixed(1)} dB
            </output>
            <canvas
              className="pro-meter"
              width={120}
              height={20}
              ref={meter}
              aria-label="Master peak and RMS meter"
            />
          </div>
          {dock && (
            <section
              className="daw-dock"
              aria-label="Bottom dock"
              style={{ height: dockHeight }}
            >
              <div
                role="separator"
                aria-label="Resize dock"
                aria-orientation="horizontal"
                tabIndex={0}
                className="daw-dock-resize"
                onKeyDown={(e) => {
                  if (e.key === "ArrowUp" || e.key === "ArrowDown") {
                    e.preventDefault();
                    setDockHeight((h) =>
                      Math.max(
                        160,
                        Math.min(
                          innerHeight * 0.6,
                          h + (e.key === "ArrowUp" ? 20 : -20),
                        ),
                      ),
                    );
                  }
                }}
                onPointerDown={(e) =>
                  e.currentTarget.setPointerCapture(e.pointerId)
                }
                onPointerMove={(e) => {
                  if (e.currentTarget.hasPointerCapture(e.pointerId))
                    setDockHeight(
                      Math.max(
                        160,
                        Math.min(innerHeight * 0.6, innerHeight - e.clientY),
                      ),
                    );
                }}
                onPointerUp={(e) =>
                  e.currentTarget.releasePointerCapture(e.pointerId)
                }
              />
              <div
                role="tablist"
                aria-label="Dock tabs"
                onKeyDown={(e) => {
                  if ((e.target as HTMLElement).getAttribute("role") !== "tab")
                    return;
                  const tabs = [
                      ...e.currentTarget.querySelectorAll<HTMLButtonElement>(
                        '[role="tab"]',
                      ),
                    ],
                    index = tabs.indexOf(e.target as HTMLButtonElement);
                  if (
                    ["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)
                  ) {
                    e.preventDefault();
                    const next =
                      e.key === "Home"
                        ? 0
                        : e.key === "End"
                          ? tabs.length - 1
                          : (index +
                              (e.key === "ArrowLeft" ? -1 : 1) +
                              tabs.length) %
                            tabs.length;
                    tabs[next].click();
                    tabs[next].focus();
                  }
                }}
              >
                {(["Effects", "Mixer", "Markers", "Regions"] as const).map(
                  (tab) => (
                    <button
                      key={tab}
                      role="tab"
                      aria-selected={dock === tab}
                      tabIndex={dock === tab ? 0 : -1}
                      onClick={() => setDock(tab)}
                    >
                      {tab}
                    </button>
                  ),
                )}
                <select
                  aria-label="Effects target"
                  value={fxTrack}
                  onChange={(e) => {
                    setFxTrack(e.target.value);
                    setFxClip(undefined);
                  }}
                >
                  <option value="">Select track…</option>
                  {a.lanes.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                  <option value="master">Master</option>
                </select>
                <button aria-label="Close dock" onClick={() => setDock(null)}>
                  ×
                </button>
              </div>
              <div role="tabpanel" aria-label={dock}>
                {dock === "Effects" ? (
                  <EffectsRack
                    a={a}
                    target={fxTrack}
                    clip={fxClip}
                    onChange={(next) => commit("Effect chain", next)}
                    getGraph={(id) => engine.current?.effects.get(id)?.graph}
                  />
                ) : dock === "Mixer" ? (
                  <Mixer
                    a={a}
                    onChange={(next) => commit("Mixer", next)}
                    getGraph={(id) => engine.current?.effects.get(id)?.graph}
                    onFX={openFX}
                  />
                ) : (
                  <>
                    {dock === "Regions" && (
                      <>
                        {active && (
                          <div className="pro-toolbar">
                            <b>
                              {active.name ??
                                a.clips.find((c) => c.id === active.clip)?.name}
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
                                  patch(selection, {
                                    gain_db: Number(e.target.value),
                                  })
                                }
                              />
                            </label>
                            <label>
                              Fade in
                              <input
                                type="number"
                                min={0}
                                step={0.01}
                                value={active.fade_in}
                                onChange={(e) =>
                                  e.target.value &&
                                  patch(selection, {
                                    fade_in: Number(e.target.value),
                                  })
                                }
                              />
                            </label>
                            <label>
                              Fade out
                              <input
                                type="number"
                                min={0}
                                step={0.01}
                                value={active.fade_out}
                                onChange={(e) =>
                                  e.target.value &&
                                  patch(selection, {
                                    fade_out: Number(e.target.value),
                                  })
                                }
                              />
                            </label>
                            <label>
                              Fade curve
                              <select
                                value={active.fade_curve}
                                onChange={(e) =>
                                  patch(selection, {
                                    fade_curve: e.target
                                      .value as Region["fade_curve"],
                                  })
                                }
                              >
                                <option value="linear">Linear</option>
                                <option value="equal_power">Equal power</option>
                              </select>
                            </label>
                          </div>
                        )}
                        <details open>
                          <summary>
                            Regions ({a.regions.length}) · select with keyboard
                          </summary>
                          <div className="pro-region-list">
                            {a.regions.map((r) => (
                              <button
                                key={r.id}
                                type="button"
                                aria-label={`Region ${a.lines[r.line]?.text ?? r.name ?? r.id}`}
                                aria-pressed={selection.includes(r.id)}
                                onClick={(e) => {
                                  setSelection(
                                    e.shiftKey ? [...selection, r.id] : [r.id],
                                  );
                                  seek(r.start);
                                }}
                              >
                                {r.name ??
                                  [...a.clips, ...a.derived_clips].find(
                                    (c) => c.id === r.clip,
                                  )?.name}{" "}
                                · {rulerStamp(r.start, ruler, a)}
                              </button>
                            ))}
                          </div>
                        </details>
                      </>
                    )}
                    {dock === "Markers" && (
                      <>
                        <div className="pro-toolbar">
                          <button onClick={() => marker()}>
                            Add marker (M)
                          </button>
                          <button onClick={loopSelection}>
                            Set loop to selection
                          </button>
                          <button
                            onClick={() =>
                              seek(
                                a.markers
                                  .filter((m) => m.time > position)
                                  .sort((x, y) => x.time - y.time)[0]?.time ??
                                  position,
                              )
                            }
                          >
                            Next marker
                          </button>
                          <button
                            onClick={() =>
                              seek(
                                a.markers
                                  .filter((m) => m.time < position)
                                  .sort((x, y) => y.time - x.time)[0]?.time ??
                                  position,
                              )
                            }
                          >
                            Previous marker
                          </button>
                        </div>
                        <details open>
                          <summary>Markers ({a.markers.length})</summary>
                          {a.markers.map((m) => (
                            <div className="pro-toolbar" key={m.id}>
                              <button
                                type="button"
                                onClick={() => seek(m.time)}
                              >
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
                                        ? {
                                            ...x,
                                            name: e.target.value.slice(0, 80),
                                          }
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
                                      x.id === m.id
                                        ? { ...x, color: e.target.value }
                                        : x,
                                    ),
                                  })
                                }
                              />
                              <button
                                type="button"
                                onClick={() =>
                                  commit("Delete marker", {
                                    ...a,
                                    markers: a.markers.filter(
                                      (x) => x.id !== m.id,
                                    ),
                                  })
                                }
                              >
                                Delete
                              </button>
                            </div>
                          ))}
                        </details>
                      </>
                    )}
                  </>
                )}
              </div>
            </section>
          )}
        </>
      )}
      {help && (
        <div className="card" role="dialog" aria-label="Timeline shortcuts">
          <h3>Timeline shortcuts</h3>
          <p>
            V Shape · C Blade · T Trim · F Fade · R Span · Z Lens · H Pan Hand ·
            Space Play/pause · Enter Stop/return · S Split · N Snap · M Marker ·
            L Loop Window · Shift+Z Fit · Arrow keys Nudge · Shift+arrows 100 ms
            · Del Delete · Shift+Del Ripple delete · Cmd/Ctrl+C/X/V/D
            Copy/Cut/Paste/Duplicate · Cmd/Ctrl+Z Undo · Cmd/Ctrl+Shift+Z or
            Ctrl+Y Redo · Cmd/Ctrl +/− Zoom · Ctrl-wheel / pinch Zoom ·
            Alt-wheel Track height · Ctrl/Cmd+Shift+wheel All track heights ·
            Alt-drag Duplicate · Shift/Cmd-click Multi-select · ? Help.
          </p>
          <button type="button" className="btn" onClick={() => setHelp(false)}>
            Close shortcuts
          </button>
        </div>
      )}
    </section>
  );
}
