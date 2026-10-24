"use client";
import { useEffect, useRef } from "react";
export default function Peaks({
  values,
  start,
  end,
  color,
  zoom,
}: {
  values: number[][];
  start: number;
  end: number;
  color: string;
  zoom: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    let ctx: CanvasRenderingContext2D | null;
    try {
      ctx = canvas.getContext("2d");
    } catch {
      return;
    }
    if (!ctx) return;
    const width = Math.min(canvas.clientWidth, 8192),
      height = 40;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);
    ctx.strokeStyle = color;
    for (let x = 0; x < width; x++) {
      const index = Math.floor(
        start * 100 + (x / Math.max(width, 1)) * (end - start) * 100,
      );
      const value = values[index] ?? [0, 0];
      ctx.beginPath();
      ctx.moveTo(x, height / 2 + ((value[0] / 128) * height) / 2);
      ctx.lineTo(x, height / 2 + ((value[1] / 128) * height) / 2);
      ctx.stroke();
    }
  }, [values, start, end, color, zoom]);
  return <canvas ref={ref} className="daw-peaks" aria-hidden="true" />;
}
