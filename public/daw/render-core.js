// Shared by the main-thread fallback and the module painter worker.
export class IntervalIndex {
  constructor(regions = []) {
    this.lanes = new Map();
    for (const r of regions) {
      const lane = this.lanes.get(r.lane) ?? [];
      lane.push(r);
      this.lanes.set(r.lane, lane);
    }
    const build = (rs) => {
      if (!rs.length) return null;
      const mid = rs.length >> 1,
        r = rs[mid],
        left = build(rs.slice(0, mid)),
        right = build(rs.slice(mid + 1));
      return {
        r,
        left,
        right,
        max: Math.max(end(r), left?.max ?? 0, right?.max ?? 0),
      };
    };
    for (const [id, rs] of this.lanes)
      this.lanes.set(id, build(rs.sort((a, b) => a.start - b.start)));
  }
  query(lane, from, to) {
    const found = [];
    const walk = (node) => {
      if (!node || node.max < from) return;
      walk(node.left);
      if (node.r.start <= to && end(node.r) >= from) found.push(node.r);
      if (node.r.start <= to) walk(node.right);
    };
    walk(this.lanes.get(lane));
    return found;
  }
}
export class TileCache {
  constructor(limit = 32 * 1024 * 1024) {
    this.limit = limit;
    this.bytes = 0;
    this.items = new Map();
  }
  get(key) {
    const v = this.items.get(key);
    if (v) {
      this.items.delete(key);
      this.items.set(key, v);
    }
    return v;
  }
  set(key, value) {
    if (this.items.has(key)) return;
    this.items.set(key, value);
    this.bytes += value.width * value.height * 4;
    while (this.bytes > this.limit && this.items.size) {
      const [k, v] = this.items.entries().next().value;
      this.items.delete(k);
      this.bytes -= v.width * v.height * 4;
      v.close?.();
    }
  }
  clear() {
    for (const v of this.items.values()) v.close?.();
    this.items.clear();
    this.bytes = 0;
  }
}
function makeSurface(w, h) {
  const c =
    typeof OffscreenCanvas !== "undefined"
      ? new OffscreenCanvas(w, h)
      : document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}
function snapshot(surface) {
  // Bitmap export can fail on a software/context-lost renderer. Retain the canvas.
  try { return surface.transferToImageBitmap?.() ?? surface; }
  catch { return surface; }
}
function fadeValue(r, position) {
  const ramp = (x, n) => (n > 0 ? Math.min(1, Math.max(0, x / n)) : 1);
  const curve = (x) =>
    r.fade_curve === "equal_power" ? Math.sin((x * Math.PI) / 2) : x;
  return (
    curve(ramp(position, r.fade_in)) *
    curve(ramp(r.src_end - r.src_start - position, r.fade_out))
  );
}
function end(r) {
  return r.start + r.src_end - r.src_start;
}
function rulerStamp(t, mode, a) {
  if (mode === "bars") {
    const beats = (((t * a.tempo) / 60) * a.time_signature[1]) / 4;
    return `${Math.floor(beats / a.time_signature[0]) + 1}|${Math.floor(beats % a.time_signature[0]) + 1}|${String(Math.round((beats % 1) * 960)).padStart(3, "0")}`;
  }
  if (mode.startsWith("timecode")) {
    const fps = Number(mode.slice(8)) || 25;
    return `${String(Math.floor(t / 3600)).padStart(2, "0")}:${String(Math.floor(t / 60) % 60).padStart(2, "0")}:${String(Math.floor(t) % 60).padStart(2, "0")}:${String(Math.floor((t % 1) * fps)).padStart(2, "0")}`;
  }
  return `${Math.floor(t / 60)}:${(t % 60).toFixed(3).padStart(6, "0")}`;
}
export class TimelineRenderer {
  constructor() {
    this.tiles = new TileCache();
    this.index = new IntervalIndex();
    this.arrangement = null;
    this.grid = null;
    this.gridKey = "";
  }
  close() {
    this.tiles.clear();
    this.grid?.close?.();
    this.grid = null;
  }
  draw(surface, state) {
    if (this.arrangement !== state.a) {
      this.arrangement = state.a;
      this.index = new IntervalIndex(state.a.regions);
    }
    const {
      a,
      peaks,
      view,
      zoom,
      selection,
      position,
      range,
      ruler,
      rows,
      overlays,
      videos,
    } = state;
    if (!surface || !a || !view) return;

    const c = surface;
    if (!c) return;
    const dpr = state.dpr,
      { x: sx, y: sy, w, h } = view;
    if (w <= 0 || h <= 0) return;
    const ctx = surface.getContext("2d");
    if (!ctx) return;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const x = (t) => 180 + t * zoom - sx,
      visibleStart = Math.max(0, (sx - 180) / zoom),
      visibleEnd = (sx + w - 180) / zoom;
    const gridKey = JSON.stringify([
      sx,
      sy,
      w,
      h,
      dpr,
      zoom,
      ruler,
      a.tempo,
      a.time_signature,
    ]);
    if (this.gridKey !== gridKey) {
      const grid = makeSurface(Math.round(w * dpr), Math.round(h * dpr)),
        gridCtx = grid.getContext("2d");
      gridCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      gridCtx.fillStyle = "#0F1220";
      gridCtx.fillRect(0, 0, w, h);
      const base = 10 ** Math.floor(Math.log10(100 / zoom));
      const step =
        [1, 2, 5, 10].map((n) => n * base).find((s) => s * zoom >= 100) ??
        base * 10;
      gridCtx.font = "11px ui-monospace";
      for (
        let t = Math.floor(visibleStart / step) * step;
        t <= visibleEnd;
        t += step
      ) {
        const px = x(t);
        if (px < 180) continue;
        gridCtx.strokeStyle = "#303952";
        gridCtx.beginPath();
        gridCtx.moveTo(px, 0);
        gridCtx.lineTo(px, h);
        gridCtx.stroke();
        gridCtx.fillStyle = "#ABB3CE";
        gridCtx.fillText(rulerStamp(t, ruler, a), px + 3, 16);
      }

      this.grid?.close?.();
      this.grid = snapshot(grid);
      this.gridKey = gridKey;
    }
    ctx.drawImage(this.grid, 0, 0, w, h);
    ctx.font = "11px ui-monospace";
    ctx.save();
    ctx.beginPath();
    ctx.rect(180, 36, w - 180, h - 36);
    ctx.clip();
    if (videos.length) {
      ctx.fillStyle = "#1A2136";
      ctx.fillRect(180, 36 - sy, w, 72);
      ctx.fillStyle = "#E0E7FF";
      for (const video of videos) {
        ctx.fillRect(
          x(video.start),
          60 - sy,
          Math.max(2, video.duration * zoom),
          20,
        );
      }
    }
    for (const lane of rows) {
      const y = lane.y - sy;
      if (y + lane.height < 36 || y > h) continue;
      ctx.fillStyle = "#161B2E";
      ctx.fillRect(180, y, w, lane.height - 1);
      for (const r of this.index.query(lane.id, visibleStart, visibleEnd)) {
        if (r.lane !== lane.id || end(r) < visibleStart || r.start > visibleEnd)
          continue;
        const left = x(r.start),
          right = x(end(r)),
          top = y + 6,
          rh = lane.height - 12,
          color = r.color ?? lane.color;
        ctx.fillStyle = selection.includes(r.id) ? "#303E68" : "#222A42";
        ctx.fillRect(left, top, right - left, rh);
        ctx.strokeStyle = selection.includes(r.id) ? "#E0E7FF" : color;
        ctx.strokeRect(left + 0.5, top + 0.5, right - left - 1, rh - 1);
        ctx.save();
        ctx.beginPath();
        ctx.rect(
          Math.max(180, left + 1),
          top + 1,
          Math.max(0, right - Math.max(180, left + 1) - 1),
          rh - 2,
        );
        ctx.clip();
        const derived = a.derived_clips.find((c) => c.id === r.clip);
        const asset = peaks[derived?.source ?? r.clip];
        let level = asset?.levels[0];
        if (asset)
          for (const candidate of asset.levels)
            if (candidate.rate >= zoom * 0.6) level = candidate;
        const center = top + rh * 0.55,
          amp = Math.max(5, rh * 0.31);
        ctx.strokeStyle = color;
        ctx.globalAlpha = r.mute ? 0.25 : 1;
        for (
          let tileStart = Math.floor(Math.max(180, left) / 256) * 256;
          tileStart < Math.min(w, right);
          tileStart += 256
        ) {
          const tileEnd = Math.min(tileStart + 256, Math.ceil(right));
          const key = [
            asset?.hash,
            level?.rate,
            derived?.src_start,
            r.src_start,
            r.src_end,
            r.fade_in,
            r.fade_out,
            r.fade_curve,
            color,
            rh,
            zoom,
            tileStart - left,
          ].join("/");
          let tile = this.tiles.get(key);
          if (!tile) {
            const image = makeSurface(256, Math.ceil(lane.height));
            const tileCtx = image.getContext("2d");
            tileCtx.strokeStyle = color;
            const center = rh * 0.55 + 6,
              amp = Math.max(5, rh * 0.31);
            // Continuous per-pixel min/max: sample all bins represented by the pixel.
            tileCtx.beginPath();
            for (let px = tileStart; px < tileEnd; px++) {
              const source = r.src_start + (px - left) / zoom;
              let lo = 0,
                hi = 0;
              if (level) {
                const i = Math.max(
                    0,
                    Math.floor(
                      (source + (derived?.src_start ?? 0)) * level.rate,
                    ),
                  ),
                  last = Math.min(
                    level.values.length / 2 - 1,
                    Math.max(
                      i,
                      Math.ceil(
                        (source + 1 / zoom + (derived?.src_start ?? 0)) *
                          level.rate,
                      ),
                    ),
                  );
                lo = 127;
                hi = -128;
                for (let k = i; k <= last; k++) {
                  lo = Math.min(lo, level.values[2 * k] ?? 0);
                  hi = Math.max(hi, level.values[2 * k + 1] ?? 0);
                }
              }
              const env = fadeValue(r, source - r.src_start);
              tileCtx.moveTo(px - tileStart, center + (lo / 128) * amp * env);
              tileCtx.lineTo(
                px - tileStart,
                center + (hi / 128) * amp * env + 1,
              );
            }
            tileCtx.stroke();

            tile = snapshot(image);
            this.tiles.set(key, tile);
          }
          ctx.drawImage(tile, tileStart, y);
        }
        ctx.globalAlpha = 1;
        ctx.fillStyle = "#E0E7FF";
        ctx.fillText(
          `${r.confidence < 0.7 ? "⚑ " : ""}${r.name ?? [...a.clips, ...a.derived_clips].find((c) => c.id === r.clip)?.name ?? r.id}`,
          left + 6,
          top + 14,
        );
        ctx.strokeStyle = "#FCD34D";
        for (const [seconds, inward] of [
          [r.fade_in, 1],
          [r.fade_out, -1],
        ]) {
          if (seconds <= 0) continue;
          const edge = inward === 1 ? left : right;
          ctx.beginPath();
          for (let i = 0; i <= 30; i++) {
            const xx = edge + (inward * seconds * zoom * i) / 30,
              yy =
                top +
                rh *
                  (1 -
                    (r.fade_curve === "equal_power"
                      ? Math.sin(((i / 30) * Math.PI) / 2)
                      : i / 30));
            i ? ctx.lineTo(xx, yy) : ctx.moveTo(xx, yy);
          }
          ctx.stroke();
        }
        ctx.fillStyle = "#FCD34D";
        ctx.fillRect(left + 2, top + 2, 7, 7);
        ctx.fillRect(right - 9, top + 2, 7, 7);
        for (const line of r.lines) {
          const at = r.start + line.src_start - r.src_start;
          if (at < r.start || at > end(r)) continue;
          ctx.fillStyle = line.confidence < 0.7 ? "#FCD34D" : "#ABB3CE";
          ctx.fillText(a.lines[line.line]?.text ?? "", x(at) + 4, top + rh - 5);
        }
        ctx.restore();
      }
      for (const m of a.missing.filter((m) => m.lane === lane.id)) {
        ctx.fillStyle = "#F8717140";
        ctx.fillRect(x(m.start), y + 20, m.length * zoom, lane.height - 28);
        ctx.fillStyle = "#FCA5A5";
        ctx.fillText(`Missing: ${m.text}`, x(m.start) + 4, y + 35);
      }
      for (const o of overlays) {
        if (o.lane !== lane.id || o.end < visibleStart || o.start > visibleEnd)
          continue;
        ctx.fillStyle = o.selected
          ? "#818CF8"
          : o.muted
            ? "#7F1D1D"
            : "#3B4666";
        ctx.fillRect(
          x(o.start),
          y + lane.height - 30,
          Math.max(2, (o.end - o.start) * zoom),
          24,
        );
        ctx.fillStyle = "#FFFFFF";
        ctx.fillText(o.text, x(o.start) + 3, y + lane.height - 13);
      }
    }
    if (range) {
      ctx.fillStyle = "#818CF833";
      ctx.fillRect(x(range[0]), 36, (range[1] - range[0]) * zoom, h);
    }
    if (a.loop.enabled) {
      ctx.fillStyle = "#FCD34D12";
      ctx.fillRect(x(a.loop.start), 36, (a.loop.end - a.loop.start) * zoom, h);
    }
    ctx.restore();
    ctx.fillStyle = "#161B2E";
    ctx.fillRect(0, 0, 180, h);
    ctx.fillStyle = "#ABB3CE";
    ctx.fillText(videos.length ? "VIDEO / TRACKS" : "TRACKS", 10, 20);
    for (const m of a.markers) {
      const px = x(m.time);
      if (px < 180 || px > w) continue;
      ctx.fillStyle = m.color;
      ctx.fillRect(px, 20, 2, h);
      ctx.fillText(`◆ ${m.name}`, px + 4, 30);
    }
  }
}
