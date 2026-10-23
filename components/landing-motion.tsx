"use client";
import { useEffect, useState } from "react";
export default function LandingMotion() {
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    const root = document.getElementById("landing");
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    let cleanup: (() => void) | undefined;
    let cancelled = false;
    let generation = 0;
    function stop() {
      generation++;
      cleanup?.();
      cleanup = undefined;
    }
    async function start() {
      if (!root || paused || media.matches || cancelled) return;
      const current = ++generation;
      try {
        const { mountLanding } = await import("./motion/landing");
        if (!cancelled && !media.matches && current === generation)
          cleanup = mountLanding(root);
      } catch {
        /* Static content remains available if an optional chunk fails. */
      }
    }
    function change() {
      stop();
      if (!media.matches) void start();
    }
    const idle =
      "requestIdleCallback" in window
        ? requestIdleCallback(() => void start(), { timeout: 2000 })
        : undefined;
    const fallback =
      idle === undefined ? setTimeout(() => void start(), 300) : undefined;
    media.addEventListener("change", change);
    return () => {
      cancelled = true;
      if (idle !== undefined) cancelIdleCallback(idle);
      clearTimeout(fallback);
      media.removeEventListener("change", change);
      stop();
    };
  }, [paused]);
  return (
    <button
      className="motion-toggle"
      aria-pressed={paused}
      onClick={() => setPaused(!paused)}
    >
      {paused ? "▶ Resume motion" : "Ⅱ Pause motion"}
    </button>
  );
}
