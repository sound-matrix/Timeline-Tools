"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
export default function Sidebar({ items }: { items: string[][] }) {
  const path = usePathname();
  return (
    <aside className="side">
      {items.map(([href, label]) => (
        <Link
          key={href}
          href={href}
          className={path === href ? "on" : ""}
          aria-current={path === href ? "page" : undefined}
        >
          {label}
        </Link>
      ))}
    </aside>
  );
}
