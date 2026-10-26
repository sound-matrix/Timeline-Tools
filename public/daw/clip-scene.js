import { theme, trackColor } from "../theme.js";
import { IntervalIndex, TileCache, TimelineRenderer } from "./render-core.js";

// Small, retained clip textures keep software Safari from uploading a full
// viewport canvas on every scroll. Only visible rows and clip tiles are mounted.
export class ClipScene {
  constructor() {
    this.cache = new TileCache();
    this.painter = new TimelineRenderer();
    this.attached = new Map();
    this.rows = new Map();
    this.pool = [];
    this.version = 0;
  }
  close() {
    this.cache.clear();
    this.painter.close();
  }
  draw(root, state) {
    const { a, view, zoom, peaks, rows, selection, dpr, headerWidth } = state;
    if (this.arrangement !== a || this.peaks !== peaks) {
      this.arrangement = a;
      this.peaks = peaks;
      this.index = new IntervalIndex(a.regions);
      this.regions = new Map(a.regions.map((r) => [r.id, r]));
      this.order = new Map(
        [...a.regions]
          .sort((a, b) => a.start - b.start)
          .map((r, i) => [r.id, i + 1]),
      );
      this.version++;
    }
    // Eight raster levels per octave keep pinch/scroll zoom on retained
    // textures. CSS supplies the exact continuous scale between levels.
    const bitmapZoom = 2 ** (Math.round(Math.log2(zoom) * 8) / 8);
    const scale = zoom / bitmapZoom;
    const from = Math.max(0, view.x / zoom);
    const to = (view.x + view.w - headerWidth) / zoom;
    const rowMap = new Map(rows.map((row) => [row.id, row]));
    for (const [key, node] of this.attached) {
      const r = this.regions.get(node.regionId),
        row = r && rowMap.get(r.lane);
      const x = r
        ? r.start * zoom +
          (node.tileIndex * 256 * zoom) / (node.bitmapZoom ?? bitmapZoom) -
          view.x
        : -Infinity;
      if (
        !row ||
        row.y + row.height <= view.y + 36 ||
        row.y >= view.y + view.h ||
        x + 256 <= 0 ||
        x >= view.w - headerWidth
      ) {
        this.attached.delete(key);
        node.style.display = "none";
        this.pool.push(node);
      }
    }
    const visible = new Map(),
      visibleRows = new Set();
    for (const row of rows) {
      const y = row.y - view.y - 36;
      if (y + row.height <= 0 || y >= view.h - 36) continue;
      visibleRows.add(row.id);
      let background = this.rows.get(row.id);
      if (!background) {
        background = document.createElement("div");
        background.className = "pro-scene-row";
        root.prepend(background);
        this.rows.set(row.id, background);
      }
      background.style.height = `${row.height - 1}px`;
      background.style.transform = `translateY(${y}px)`;
      for (const r of this.index.query(row.id, from, to)) {
        const left = r.start * zoom - view.x;
        const width = (r.src_end - r.src_start) * bitmapZoom;
        const first = Math.max(0, Math.floor(-left / (256 * scale)));
        const last = Math.min(
          Math.ceil(width / 256),
          Math.ceil((view.w - headerWidth - left) / (256 * scale)),
        );
        for (let i = first; i < last; i++) {
          const { id, lane, start, ...appearance } = r;
          const key = JSON.stringify([
            this.version,
            bitmapZoom,
            dpr,
            row.height,
            row.color,
            selection.includes(r.id),
            appearance,
            i,
          ]);
          const nodeKey = `${r.id}/${i}`;
          let tile = this.cache.get(key);
          const w = Math.min(256, Math.ceil(width - i * 256));
          if (!tile) {
            tile = document.createElement("canvas");
            this.painter.draw(tile, {
              ...state,
              zoom: bitmapZoom,
              a: {
                ...a,
                regions: [r],
                missing: [],
                markers: [],
                loop: { ...a.loop, enabled: false },
              },
              view: {
                x: headerWidth + r.start * bitmapZoom + i * 256,
                y: row.y,
                w,
                h: row.height,
              },
              rows: [row],
              range: null,
              overlays: [],
              videos: [],
              contentOnly: true,
              tileOnly: true,
            });
            this.cache.set(key, tile);
          }
          let node = this.attached.get(nodeKey);
          if (!node) {
            node = this.pool.pop();
            if (!node) {
              node = document.createElement("img");
              node.alt = "";
              node.draggable = false;
              node.className = "pro-scene-tile";
              root.append(node);
            }
            node.regionId = r.id;
            node.tileIndex = i;
            node.style.zIndex = this.order.get(r.id);
            node.style.display = "block";
          }
          if (node.paintKey !== key) {
            node.style.width = `${w}px`;
            node.style.height = `${row.height}px`;
            tile.imageUrl ??= tile.toDataURL();
            node.src = tile.imageUrl;
            node.paintKey = key;
            node.bitmapZoom = bitmapZoom;
            node.style.zIndex = this.order.get(r.id);
          }
          node.style.transform = `translate3d(${left + i * 256 * scale}px, ${y}px, 0) scaleX(${scale})`;
          visible.set(nodeKey, node);
        }
      }
    }
    for (const [id, row] of this.rows)
      if (!visibleRows.has(id)) {
        row.remove();
        this.rows.delete(id);
      }
    for (const [key, tile] of this.attached)
      if (!visible.has(key)) {
        tile.style.display = "none";
        this.pool.push(tile);
      }
    while (this.pool.length > 128) this.pool.pop().remove();
    this.attached = visible;
    // Range, loop and marker overlays stay independent of cached clip textures.
    root
      .querySelectorAll(".pro-scene-range, .pro-scene-marker")
      .forEach((el) => el.remove());
    for (const [span, color] of [
      [state.range, theme["selection-wash"]],
      [a.loop.enabled ? [a.loop.start, a.loop.end] : null, theme["loop-wash"]],
    ]) {
      if (!span) continue;
      const left = Math.max(0, span[0] * zoom - view.x),
        right = Math.min(view.w - headerWidth, span[1] * zoom - view.x);
      if (right <= left) continue;
      const el = document.createElement("div");
      el.className = "pro-scene-range";
      Object.assign(el.style, {
        left: `${left}px`,
        width: `${right - left}px`,
        background: color,
      });
      root.append(el);
    }
    for (const m of a.markers) {
      const x = m.time * zoom - view.x;
      if (x < 0 || x > view.w - headerWidth) continue;
      const el = document.createElement("div");
      el.className = "pro-scene-marker";
      Object.assign(el.style, {
        transform: `translateX(${x}px)`,
        background: trackColor(m.color),
      });
      root.append(el);
    }
  }
}
