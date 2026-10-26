"use client";
import { theme } from "@/public/theme.js";

import { useEffect, useRef, useState } from "react";

/** Illustrative signal activity; never presented as measured audio levels. */
export default function Visualizer({
  compact = false,
  sidebar = false,
}: {
  compact?: boolean;
  sidebar?: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    let context: CanvasRenderingContext2D | null;
    try {
      context = element.getContext("2d");
    } catch {
      return;
    }
    if (!context) return;
    const ctx = context;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0,
      phase = 0,
      width = 0,
      height = 0;
    const measure = () => {
      ({ width, height } = element.getBoundingClientRect());
      const ratio = Math.min(devicePixelRatio || 1, 2);
      element.width = width * ratio;
      element.height = height * ratio;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    };
    const draw = () => {
      if (!width || !height) return;
      ctx.clearRect(0, 0, width, height);
      const radius = Math.min(width, height) * (compact ? 0.27 : 0.32);
      for (let i = 0; i < 160; i++) {
        const angle = (i / 160) * Math.PI * 2;
        const energy = 5 + 16 * Math.pow(Math.sin(i * 0.17 + phase), 2);
        ctx.strokeStyle = i % 2 ? theme["primary"] : theme["accent-text"];
        ctx.globalAlpha = 0.35 + 0.5 * Math.abs(Math.sin(i * 0.1));
        ctx.beginPath();
        ctx.moveTo(
          width / 2 + Math.cos(angle) * radius,
          height / 2 + Math.sin(angle) * radius,
        );
        ctx.lineTo(
          width / 2 + Math.cos(angle) * (radius + energy),
          height / 2 + Math.sin(angle) * (radius + energy),
        );
        ctx.stroke();
        if (!compact) {
          const orbit = radius + 30 + (i % 23) * 3;
          ctx.fillStyle = theme["accent-text"];
          ctx.fillRect(
            width / 2 + Math.cos(angle + phase * 0.08) * orbit,
            height / 2 + Math.sin(angle + phase * 0.08) * orbit,
            1.5,
            1.5,
          );
        }
      }
    };
    const animate = () => {
      phase += sidebar ? 0.003 : 0.012;
      draw();
      frame = requestAnimationFrame(animate);
    };
    const sync = () => {
      cancelAnimationFrame(frame);
      draw();
      if (!document.hidden && !reduced.matches && !paused)
        frame = requestAnimationFrame(animate);
    };
    const resize = new ResizeObserver(() => {
      measure();
      sync();
    });
    resize.observe(element);
    reduced.addEventListener("change", sync);
    document.addEventListener("visibilitychange", sync);
    measure();
    sync();
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      reduced.removeEventListener("change", sync);
      document.removeEventListener("visibilitychange", sync);
    };
  }, [compact, sidebar, paused]);
  return (
    <div
      className={`portal${compact ? " scope-dock" : ""}${sidebar ? " sidebar-scope" : ""}`}
    >
      <canvas ref={canvas} aria-hidden="true" />
      <span className="portal-caption">
        {compact ? "SIGNAL SPACE · ILLUSTRATIVE" : "A SPACE TO SHAPE SOUND"}
      </span>
      <button
        type="button"
        className="portal-pause"
        aria-label={paused ? "Resume visualizer" : "Pause visualizer"}
        aria-pressed={paused}
        onClick={() => setPaused(!paused)}
      >
        {paused ? "Resume" : "Pause"}
      </button>
    </div>
  );
}
