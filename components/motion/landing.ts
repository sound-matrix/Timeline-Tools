import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import Lenis from "lenis";
import { mountWave } from "./waves";
export function mountLanding(root: HTMLElement) {
  gsap.registerPlugin(ScrollTrigger);
  const lenis = new Lenis({
    duration: 0.95,
    smoothWheel: true,
    syncTouch: false,
    anchors: true,
  });
  lenis.on("scroll", ScrollTrigger.update);
  const tick = (time: number) => {
    if (!document.hidden) lenis.raf(time * 1000);
  };
  gsap.ticker.add(tick);
  const cleanups = Array.from(
    root.querySelectorAll<HTMLCanvasElement>("canvas[data-wave]"),
  ).map((c) => mountWave(c, c.dataset.wave || "hero"));
  const ctx = gsap.context(() => {
    gsap.to(".audio-object", {
      y: -14,
      rotationZ: 3,
      duration: 3,
      ease: "sine.inOut",
      repeat: -1,
      yoyo: true,
    });
    gsap.to(".sound-stage", {
      rotationX: 3,
      rotationY: -6,
      y: 70,
      ease: "none",
      scrollTrigger: {
        trigger: ".sound-hero",
        start: "top top",
        end: "bottom top",
        scrub: 1,
      },
    });
    root.querySelectorAll<HTMLElement>(".story-section").forEach((section) => {
      const scene = section.querySelector(".scene-card");
      gsap.fromTo(
        scene,
        { y: 55, rotationX: 7, rotationY: -5 },
        {
          y: -20,
          rotationX: 0,
          rotationY: 2,
          ease: "none",
          scrollTrigger: {
            trigger: section,
            start: "top 90%",
            end: "bottom 25%",
            scrub: 1,
          },
        },
      );
    });
    gsap.to(".noisy i", {
      scaleY: 0.28,
      stagger: 0.008,
      ease: "none",
      scrollTrigger: {
        trigger: ".cleanup-story",
        start: "top 70%",
        end: "bottom 40%",
        scrub: 1,
      },
    });
    gsap.fromTo(
      '[data-meter="lufs"]',
      { scaleX: 0.28 },
      {
        scaleX: 0.76,
        scrollTrigger: {
          trigger: ".mastering-story",
          start: "top 80%",
          end: "center center",
          scrub: 1,
        },
      },
    );
    gsap.fromTo(
      '[data-meter="peak"]',
      { scaleX: 0.5 },
      {
        scaleX: 0.94,
        scrollTrigger: {
          trigger: ".mastering-story",
          start: "top 80%",
          end: "center center",
          scrub: 1,
        },
      },
    );
    const meters = { lufs: -32, peak: -8 };
    gsap.to(meters, {
      lufs: -14,
      peak: -1,
      scrollTrigger: {
        trigger: ".mastering-story",
        start: "top 80%",
        end: "center center",
        scrub: 1,
      },
      onUpdate: () => {
        root.querySelector("[data-lufs]")!.textContent = meters.lufs.toFixed(1);
        root.querySelector("[data-peak]")!.textContent = meters.peak.toFixed(1);
      },
    });
    gsap.from("[data-clip]", {
      x: 65,
      stagger: 0.18,
      duration: 0.8,
      ease: "back.out(1.4)",
      scrollTrigger: {
        trigger: ".timeline-visual",
        start: "top 75%",
        toggleActions: "play none none reverse",
      },
    });
    gsap.from("[data-script], [data-caption]", {
      opacity: 0.25,
      y: 10,
      stagger: 0.3,
      scrollTrigger: {
        trigger: ".timeline-visual",
        start: "top 80%",
        end: "center center",
        scrub: 1,
      },
    });
  }, root);
  return () => {
    ctx.revert();
    gsap.ticker.remove(tick);
    lenis.destroy();
    cleanups.forEach((fn) => fn());
    root.querySelector("[data-lufs]")!.textContent = "-14.0";
    root.querySelector("[data-peak]")!.textContent = "-1.0";
  };
}
