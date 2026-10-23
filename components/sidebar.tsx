"use client";
import { useState } from "react";
import Visualizer from "./visualizer";
import Link from "next/link";
import { usePathname } from "next/navigation";
export default function Sidebar({
  items,
  name,
  minutes,
}: {
  items: string[][];
  name: string;
  minutes?: number;
}) {
  const [open, setOpen] = useState(false);
  const path = usePathname();
  return (
    <aside className={`side${open ? " is-open" : ""}`}>
      <button
        className="btn ghost side-menu"
        aria-expanded={open}
        aria-controls="workplace-nav"
        onClick={() => setOpen(!open)}
      >
        ☰ Studio menu
      </button>
      <nav id="workplace-nav" aria-label="Workplace">
        {items.map(([href, label]) => (
          <Link
            onClick={() => setOpen(false)}
            key={href}
            href={href}
            className={path === href ? "on" : ""}
            aria-current={path === href ? "page" : undefined}
          >
            {label}
          </Link>
        ))}
      </nav>
      <div className="side-footer">
        <Visualizer compact sidebar />
        <div className="side-user">
          {name}
          {minutes !== undefined && <p>{minutes} minutes available</p>}
        </div>
        <Link href="/plans">Your plan & minutes ↗</Link>
      </div>
    </aside>
  );
}
