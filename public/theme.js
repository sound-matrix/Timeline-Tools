/** Timeline Tools silver theme. The only source of literal application colours.
 * Shared by CSS, SVG, the timeline painter worker and canvas fallbacks.
 */
export const theme = {
  bg: "#B2BABB",
  surface: "#C9D0D1",
  "surface-2": "#DDE2E3",
  border: "#8E979A",
  "border-strong": "#586366",
  text: "#1E2427",
  "text-muted": "#424B4F",
  primary: "#1F3A4D",
  "primary-hover": "#2B4E66",
  "on-primary": "#FFFFFF",
  accent: "#C2783B",
  "accent-text": "#6F3B16",
  focus: "#8A4B1E",
  success: "#2E7D4F",
  "success-text": "#1D5233",
  danger: "#B23A3A",
  "danger-text": "#852727",
  warning: "#B7841F",
  "warning-text": "#604307",
  "track-slate": "#1F3A4D",
  "track-violet": "#653C7D",
  "track-green": "#225D3E",
  "track-gold": "#6A4A0D",
  "track-rose": "#7D3459",
  "track-teal": "#1E5962",
  "accent-wash": "#C2783B18",
  "primary-wash": "#1F3A4D18",
  "selection-wash": "#C2783B33",
  "loop-wash": "#B7841F18",
  "danger-wash": "#B23A3A18",
  "shadow-soft": "#1E242714",
  shadow: "#1E242733",
  "shadow-strong": "#1E242755",
  scrim: "#1E242766",
  "glass-highlight": "#FFFFFF",
};

export const trackColors = [
  "track-slate",
  "track-violet",
  "track-green",
  "track-gold",
  "track-rose",
  "track-teal",
].map((key) => theme[key]);

// Keep saved/custom track hues, but darken bright legacy colours for silver.
// Presentation only: never changes stored arrangement data.
const trackCache = new Map();
export function trackColor(color) {
  if (!/^#[\da-f]{6}$/i.test(color ?? "")) return theme.primary;
  if (trackCache.has(color)) return trackCache.get(color);
  let rgb = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
  const luminance = (values) =>
    values
      .map((v) => v / 255)
      .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
      .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
  const backdrop = luminance([178, 186, 187]);
  while ((backdrop + 0.05) / (luminance(rgb) + 0.05) < 4.5)
    rgb = rgb.map((v) => Math.floor(v * 0.94));
  const result = "#" + rgb.map((v) => v.toString(16).padStart(2, "0")).join("");
  trackCache.set(color, result);
  return result;
}

const aliases = {
  canvas: "bg",
  sidebar: "surface",
  panel: "surface",
  "panel-2": "surface-2",
  muted: "text-muted",
  faint: "text-muted",
  "on-accent": "on-primary",
  "accent-hover": "primary-hover",
  "accent-pressed": "primary",
  "scope-a": "primary",
  "scope-b": "accent-text",
  "studio-indigo": "primary",
};
export const themeCss = `:root { color-scheme: light; ${Object.entries(theme)
  .map(([key, value]) => `--${key}: ${value};`)
  .join(" ")} ${Object.entries(aliases)
  .map(([key, value]) => `--${key}: var(--${value});`)
  .join(" ")} }`;
