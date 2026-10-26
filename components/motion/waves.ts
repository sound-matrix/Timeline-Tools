import { theme } from "@/public/theme.js";
export function mountWave(canvas: HTMLCanvasElement, mode: string) {
  const context = canvas.getContext("2d");
  if (!context) return () => {};
  let frame = 0,
    visible = false,
    width = 0,
    height = 0,
    pointer = 0.5,
    last = 0;
  function resize() {
    const rect = canvas.getBoundingClientRect();
    width = rect.width;
    height = rect.height;
    const ratio = Math.min(devicePixelRatio || 1, 1.5);
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    context!.setTransform(ratio, 0, 0, ratio, 0, 0);
  }
  function draw(time: number) {
    if (!visible || document.hidden) {
      frame = 0;
      return;
    }
    frame = requestAnimationFrame(draw);
    if (time - last < 32) return;
    last = time;
    context!.clearRect(0, 0, width, height);
    for (let layer = 0; layer < 4; layer++) {
      context!.beginPath();
      context!.strokeStyle = [theme["primary"], theme["accent-text"], theme["track-teal"], theme["track-violet"]][
        layer
      ];
      context!.lineWidth = layer === 0 ? 2.5 : 1.2;
      for (let x = 0; x <= width; x += 3) {
        const p = x / Math.max(width, 1);
        const envelope = Math.pow(Math.sin(p * Math.PI), 1.6);
        const y =
          height / 2 +
          Math.sin(
            p * (mode === "clean" ? 55 : 38) + time * 0.0007 + layer * 0.7,
          ) *
            envelope *
            height *
            (0.2 + layer * 0.025) *
            (0.8 + pointer * 0.4);
        if (!x) context!.moveTo(x, y);
        else context!.lineTo(x, y);
      }
      context!.stroke();
    }
  }
  function resume() {
    if (visible && !document.hidden && !frame)
      frame = requestAnimationFrame(draw);
  }
  const observer = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    resume();
  });
  observer.observe(canvas);
  const sizes = new ResizeObserver(resize);
  sizes.observe(canvas);
  resize();
  function move(e: PointerEvent) {
    pointer = Math.max(0, Math.min(1, e.offsetX / Math.max(width, 1)));
  }
  canvas.addEventListener("pointermove", move, { passive: true });
  document.addEventListener("visibilitychange", resume);
  canvas.classList.add("wave-ready");
  return () => {
    cancelAnimationFrame(frame);
    observer.disconnect();
    sizes.disconnect();
    canvas.removeEventListener("pointermove", move);
    document.removeEventListener("visibilitychange", resume);
    canvas.classList.remove("wave-ready");
    context.clearRect(0, 0, width, height);
  };
}
