"use client";
import { useEffect, useRef } from "react";
import Link from "next/link";
export default function BillingSuccess({ minutes }: { minutes: number }) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    let cancelled = false;
    let generation = 0;
    let stop: (() => void) | undefined;
    async function play() {
      if (media.matches || cancelled || !root.current) return;
      const current = ++generation;
      const { gsap } = await import("gsap");
      if (cancelled || media.matches || !root.current || current !== generation)
        return;
      const ctx = gsap.context(() => {
        const element = root.current?.querySelector("[data-minutes]");
        if (element) element.textContent = "+0 min";
        const timeline = gsap.timeline();
        timeline
          .fromTo(
            ".rupee-coin",
            { y: 0, x: 0, opacity: 0, rotation: 0 },
            {
              y: -105,
              x: (i: number) => -55 + i * 55,
              opacity: 1,
              rotation: 25,
              duration: 0.7,
              stagger: 0.14,
              ease: "back.out(1.4)",
            },
          )
          .to(
            ".rupee-coin",
            { y: -65, duration: 0.5, ease: "bounce.out" },
            "-=0.2",
          )
          .fromTo(
            ".wallet-wave",
            { x: -40, opacity: 0 },
            { x: 55, opacity: 1, duration: 0.9, ease: "power2.inOut" },
            "-=0.3",
          )
          .fromTo(
            ".minutes-gain",
            { scale: 0.9 },
            { scale: 1, duration: 0.6, ease: "back.out(2)" },
            "-=0.4",
          );
        const counter = { value: 0 };
        timeline.to(
          counter,
          {
            value: minutes,
            duration: 1.1,
            onUpdate: () => {
              const element = root.current?.querySelector("[data-minutes]");
              if (element)
                element.textContent = `+${Math.round(counter.value).toLocaleString("en-IN")} min`;
            },
          },
          "-=0.9",
        );
      }, root);
      stop = () => {
        ctx.revert();
        const element = root.current?.querySelector("[data-minutes]");
        if (element)
          element.textContent = `+${minutes.toLocaleString("en-IN")} min`;
      };
    }
    function change() {
      generation++;
      stop?.();
      if (!media.matches) void play().catch(() => {});
    }
    void play().catch(() => {});
    media.addEventListener("change", change);
    return () => {
      cancelled = true;
      stop?.();
      media.removeEventListener("change", change);
    };
  }, [minutes]);
  return (
    <main className="card billing-preview" ref={root}>
      <span className="tag">Payment success · visual preview</span>
      <p className="eyebrow">A LITTLE MORE CREATIVE POSSIBILITY</p>
      <h1>More minutes. More stories.</h1>
      <div className="wallet-scene" aria-hidden="true">
        <div className="wallet">≋</div>
        {[0, 1, 2].map((i) => (
          <i className="rupee-coin" key={i}>
            ₹
          </i>
        ))}
        <span className="wallet-wave">∿∿∿</span>
      </div>
      <p className="minutes-gain" data-minutes aria-hidden="true">
        +{minutes.toLocaleString("en-IN")} min
      </p>
      <p className="sr-only">Preview: plus {minutes} minutes.</p>
      <p className="muted">
        This is a preview of the future payment success screen. No payment has
        been verified and no minutes have been added to your account.
      </p>
      <Link className="btn" href="/dashboard" prefetch={false}>
        Go to your studio ↗
      </Link>
    </main>
  );
}
