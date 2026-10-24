import type { Tool } from "@/lib/daw/commands";
const paths: Record<Tool, string> = {
  pointer: "M4 3 17 11 11 13 8 20Z M12 14l4 6",
  razor: "M5 4h6l8 8-7 7-8-8Z M9 8l7 7 M6 18l-2 2",
  trim: "M7 4v16M17 4v16M3 8h4M17 16h4",
  fade: "M3 19V5h18M4 18Q14 18 20 6",
  range: "M4 5v14M20 5v14M4 12h16M9 8l-4 4 4 4M15 8l4 4-4 4",
  zoom: "M16 16l5 5M10 5v10M5 10h10M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0",
  hand: "M6 11V7a2 2 0 0 1 4 0v5-8a2 2 0 0 1 4 0v8-5a2 2 0 0 1 4 0v6l2-2 2 2-5 7H9l-6-7 2-2 5 5",
};
export default function ToolIcon({ tool }: { tool: Tool }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[tool]} />
    </svg>
  );
}
