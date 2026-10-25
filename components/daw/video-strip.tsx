"use client";
import { useEffect, useState } from "react";
import type { DawVideo } from "./daw-timeline";
const memory = new Map<string, string>();
async function db() {
  return new Promise<IDBDatabase | null>((resolve) => {
    const r = indexedDB.open("daw-video-thumbnails-v1", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("frames");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => resolve(null);
  });
}
async function cache(key: string, value?: Blob) {
  const store = await db();
  if (!store) return null;
  return new Promise<Blob | null>((resolve) => {
    const t = store.transaction("frames", value ? "readwrite" : "readonly"),
      r = value
        ? t.objectStore("frames").put(value, key)
        : t.objectStore("frames").get(key);
    r.onsuccess = () => {
      store.close();
      resolve(value ?? r.result ?? null);
    };
    r.onerror = () => {
      store.close();
      resolve(null);
    };
  });
}
function event(target: HTMLVideoElement, name: string) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      clean();
      reject(Error("Frame timeout"));
    }, 5000);
    const clean = () => {
        clearTimeout(timer);
        target.removeEventListener(name, ok);
        target.removeEventListener("error", bad);
      },
      ok = () => {
        clean();
        resolve();
      },
      bad = () => {
        clean();
        reject(Error("Video unavailable"));
      };
    target.addEventListener(name, ok, { once: true });
    target.addEventListener("error", bad, { once: true });
  });
}
export default function VideoStrip({
  headerWidth = 180,
  videos,
  zoom,
  x,
  y,
  width,
}: {
  headerWidth?: number;
  videos: DawVideo[];
  zoom: number;
  x: number;
  y: number;
  width: number;
}) {
  const [frames, setFrames] = useState<
    { key: string; time: number; url: string }[]
  >([]);
  useEffect(() => {
    let cancelled = false;
    const elements: HTMLVideoElement[] = [];
    void (async () => {
      const interval = Math.max(1, Math.ceil(110 / zoom)),
        left = Math.max(0, (x - headerWidth) / zoom),
        right = (x + width - headerWidth) / zoom,
        result: { key: string; time: number; url: string }[] = [];
      for (const item of videos) {
        if (item.start + item.duration < left || item.start > right) continue;
        let video: HTMLVideoElement | undefined;
        for (
          let time = Math.max(
            item.start,
            Math.floor(left / interval) * interval,
          );
          time < Math.min(right, item.start + item.duration) &&
          result.length < 30;
          time += interval
        ) {
          const key = `${item.url}/${Math.round((time - item.start) * 1000)}`;
          let url = memory.get(key);
          try {
            if (!url) {
              let blob = await cache(key);
              if (cancelled) return;
              if (!blob) {
                if (!video) {
                  video = document.createElement("video");
                  elements.push(video);
                  video.crossOrigin = "anonymous";
                  video.muted = true;
                  video.preload = "auto";
                  const loaded = event(video, "loadeddata");
                  video.src = item.url;
                  await loaded;
                }
                const target = Math.min(
                  item.duration - 0.001,
                  Math.max(0.001, time - item.start),
                );
                const sought = event(video, "seeked");
                video.currentTime = target;
                await sought;
                if (cancelled) return;
                const canvas = document.createElement("canvas");
                canvas.width = 176;
                canvas.height = 100;
                canvas.getContext("2d")!.drawImage(video, 0, 0, 176, 100);
                blob = await new Promise<Blob | null>((resolve) =>
                  canvas.toBlob(resolve, "image/jpeg", 0.65),
                );
                if (blob) await cache(key, blob);
              }
              if (blob) {
                url = URL.createObjectURL(blob);
                memory.set(key, url);
                if (memory.size > 160) {
                  const oldest = memory.keys().next().value!;
                  URL.revokeObjectURL(memory.get(oldest)!);
                  memory.delete(oldest);
                }
              }
            }
            if (url) result.push({ key, time, url });
          } catch {
            /* An unavailable proxy leaves its tile blank without blocking audio. */
          }
          if (!cancelled) setFrames([...result]);
        }
      }
    })();
    return () => {
      cancelled = true;
      for (const v of elements) {
        v.pause();
        v.removeAttribute("src");
        v.load();
      }
    };
  }, [videos, zoom, x, width, headerWidth]);
  return (
    <div
      className="pro-thumbnails"
      style={{ left: headerWidth, top: 36 - y }}
      aria-label="Video thumbnail lane"
    >
      {frames.map((f) => (
        <img
          key={f.key}
          src={f.url}
          alt="Video frame"
          style={{
            left: f.time * zoom - x,
            width: Math.max(110, Math.ceil(110 / zoom) * zoom),
          }}
        />
      ))}
    </div>
  );
}
