"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
export type MenuAction = {
  label: string;
  action: () => void;
  disabled?: boolean;
};
export default function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: MenuAction[];
  onClose: () => void;
}) {
  const previous = useRef<HTMLElement | null>(null);
  const ref = useRef<HTMLDivElement>(null),
    [point, setPoint] = useState({ x, y });
  useLayoutEffect(() => {
    previous.current = document.activeElement as HTMLElement;
    const el = ref.current!,
      box = el.getBoundingClientRect();
    setPoint({
      x: Math.max(8, Math.min(x, innerWidth - box.width - 8)),
      y: Math.max(8, Math.min(y, innerHeight - box.height - 8)),
    });
    el.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [x, y]);
  useEffect(() => {
    const close = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener("pointerdown", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      if (previous.current?.isConnected) previous.current.focus();
    };
  }, [onClose]);
  return createPortal(
    <div
      ref={ref}
      className="pro-context daw-menu"
      role="menu"
      aria-label="Timeline context menu"
      style={{ left: point.x, top: point.y }}
      onKeyDown={(e) => {
        e.stopPropagation();
        const buttons = [
            ...ref.current!.querySelectorAll<HTMLButtonElement>(
              "button:not(:disabled)",
            ),
          ],
          i = buttons.indexOf(document.activeElement as HTMLButtonElement);
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
          e.preventDefault();
          e.stopPropagation();
          buttons[
            e.key === "Home"
              ? 0
              : e.key === "End"
                ? buttons.length - 1
                : (i + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) %
                  buttons.length
          ]?.focus();
        }
        if (e.key === "Tab") onClose();
      }}
    >
      {items.map((item) => (
        <button
          key={item.label}
          role="menuitem"
          disabled={item.disabled}
          onClick={() => {
            item.action();
            onClose();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}
