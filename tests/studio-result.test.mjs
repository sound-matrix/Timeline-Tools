import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { arrangementSchema } from "../lib/arrangement.ts";
import { studioCues, editedStudioCues } from "../lib/studio-result.ts";
import { serializeSubtitles } from "../lib/subtitles.ts";
test("studio transcription remaps trimmed source cues and saved edits preserve timestamps", () => {
  const a = arrangementSchema.parse(
    JSON.parse(readFileSync("tests/fixtures/daw-arrangement.json", "utf8")),
  );
  const cues = studioCues(a);
  assert.deepEqual(cues, [
    { start: 0, end: 2, text: "Hello there" },
    { start: 2.25, end: 4.25, text: "Welcome home" },
  ]);
  const edited = editedStudioCues(cues, "Corrected తెలుగు\n\nWelcome back");
  assert.equal(edited[1].start, 2.25);
  assert.equal(edited[1].end, 4.25);
  assert.match(
    serializeSubtitles(edited, "srt"),
    /00:00:02,250 --> 00:00:04,250\nWelcome back/,
  );
  assert.equal(cues[0].text, "Hello there");
  assert.throws(() => editedStudioCues(cues, ""), /one paragraph/);
  assert.throws(
    () => editedStudioCues(cues, "Just one paragraph"),
    /one paragraph/,
  );
  a.regions[0].src_start = 1;
  a.regions[1].mute = true;
  assert.deepEqual(studioCues(a), [{ start: 0, end: 1, text: "Hello there" }]);
});
