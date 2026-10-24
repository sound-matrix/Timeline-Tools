export type ShortcutPreset = "timeline" | "logic" | "protools" | "cubase";
// Text-only familiarity presets; transport/edit commands remain Timeline Tools operations.
const tools: Record<ShortcutPreset, Record<string, string>> = {
  timeline: {
    v: "pointer",
    c: "razor",
    t: "trim",
    f: "fade",
    r: "range",
    z: "zoom",
    h: "hand",
  },
  logic: {
    "1": "pointer",
    "2": "razor",
    "3": "range",
    "4": "zoom",
    "5": "hand",
  },
  protools: {
    f6: "trim",
    f7: "pointer",
    f8: "razor",
    f9: "range",
    f10: "zoom",
  },
  cubase: {
    "1": "pointer",
    "2": "range",
    "3": "razor",
    "4": "zoom",
    "5": "hand",
  },
};
export function shortcutTool(key: string, preset: ShortcutPreset = "timeline") {
  return tools[preset][key.toLowerCase()];
}
