import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { theme, themeCss, trackColor, trackColors } from "../public/theme.js";
const luminance = (hex) =>
  [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    .reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
const contrast = (a, b) =>
  (Math.max(luminance(a), luminance(b)) + 0.05) /
  (Math.min(luminance(a), luminance(b)) + 0.05);
test("silver semantic text, controls and selections meet AA", () => {
  for (const background of ["bg", "surface", "surface-2"]) {
    for (const foreground of [
      "text",
      "text-muted",
      "primary",
      "accent-text",
      "success-text",
      "danger-text",
      "warning-text",
    ])
      assert.ok(
        contrast(theme[foreground], theme[background]) >= 4.5,
        `${foreground} / ${background}`,
      );
    for (const foreground of ["focus", "border-strong"])
      assert.ok(
        contrast(theme[foreground], theme[background]) >= 3,
        `${foreground} / ${background}`,
      );
  }
  for (const background of ["primary", "primary-hover", "danger"])
    assert.ok(contrast(theme["on-primary"], theme[background]) >= 4.5);
  assert.ok(contrast(theme.text, theme.accent) >= 4.5);
  for (const track of trackColors) {
    assert.ok(contrast(track, theme.bg) >= 3);
    assert.ok(contrast(theme["on-primary"], track) >= 4.5);
  }
  for (const color of [theme.accent, theme["surface-2"], ...trackColors])
    assert.ok(contrast(trackColor(color), theme.bg) >= 4.5);
  assert.match(themeCss, /color-scheme: light/);
  assert.ok(themeCss.includes(`--bg: ${theme.bg}`));
});
test("active UI colour literals live only in the shared theme", () => {
  const walk = (path) =>
    readdirSync(path, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(`${path}/${e.name}`) : [`${path}/${e.name}`],
    );
  for (const file of ["app", "components", "lib", "public/daw"]
    .flatMap(walk)
    .filter((f) => /\.(?:css|tsx?|js)$/.test(f) && !f.includes("/vendor/"))) {
    assert.doesNotMatch(readFileSync(file, "utf8"), /#[\da-f]{3,8}\b/i, file);
  }
});
