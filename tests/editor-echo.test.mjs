import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

test("Echo preserves stereo tails across render quanta, irregular blocks and silent input", () => {
  let Echo;
  vm.runInNewContext(readFileSync("public/daw/delay-processor.js", "utf8"), {
    AudioWorkletProcessor: class {
      port = {};
    },
    Float32Array,
    registerProcessor(name, processor) {
      Echo = processor;
    },
  });
  for (const delayFrames of [1, 2000, 2205]) {
    for (const feedback of [0, 0.3, 0.85]) {
      const length = delayFrames * 5 + 128 * 4 + 31;
      const expected = [new Float32Array(length), new Float32Array(length)];
      for (let ch = 0; ch < 2; ch++)
        for (let repeat = 0; repeat < 5; repeat++) {
          const at = ch * 31 + delayFrames + repeat * (delayFrames + 128);
          if (at < length)
            expected[ch][at] = (ch ? -0.5 : 1) * feedback ** repeat;
        }
      for (const block of [128, 137]) {
        const echo = new Echo({ processorOptions: { delayFrames, feedback } });
        const result = [new Float32Array(length), new Float32Array(length)];
        for (let from = 0; from < length; from += block) {
          const count = Math.min(block, length - from);
          const input = [new Float32Array(count), new Float32Array(count)];
          if (!from) input[0][0] = 1;
          if (from <= 31 && from + count > 31) input[1][31 - from] = -0.5;
          const output = [new Float32Array(count), new Float32Array(count)];
          assert.equal(echo.process([from > 31 ? [] : input], [output]), true);
          output.forEach((channel, ch) => result[ch].set(channel, from));
        }
        for (let ch = 0; ch < 2; ch++)
          for (let i = 0; i < length; i++)
            assert.ok(
              Math.abs(result[ch][i] - expected[ch][i]) < 1e-7,
              `${delayFrames}/${feedback}/${block}/${ch}/${i}`,
            );
        echo.port.onmessage({ data: "dispose" });
        assert.equal(echo.process([], []), false);
      }
    }
  }
});
