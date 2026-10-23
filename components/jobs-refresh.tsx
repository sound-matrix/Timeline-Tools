"use client";
import { useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";
export default function JobsRefresh({ active }: { active: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      if (!document.hidden && !pending) startTransition(() => router.refresh());
    }, 5000);
    return () => clearInterval(timer);
  }, [active, router, pending]);
  return active ? (
    <p className="muted" role="status">
      Jobs update automatically while queued or processing.
    </p>
  ) : null;
}
