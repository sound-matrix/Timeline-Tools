import test from "node:test";
import assert from "node:assert/strict";
import { wavHeader, pcmWindow } from "../lib/studio-preview.ts";
function wav() {
  const b = Buffer.alloc(48);
  b.write("RIFF");
  b.writeUInt32LE(40, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24);
  b.writeUInt32LE(16000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(4, 40);
  b.writeInt16LE(-32768, 44);
  b.writeInt16LE(16384, 46);
  return b;
}
test("bounded PCM preview decodes signed samples and reads range windows", async () => {
  const b = wav();
  assert.deepEqual(wavHeader(b), {
    offset: 44,
    length: 4,
    rate: 8000,
    channels: 1,
    bits: 16,
    format: 1,
    block: 2,
  });
  const previous = globalThis.fetch;
  globalThis.fetch = async () => new Response(b, { status: 200 });
  const values = [];
  const context = {
    createBuffer: (channels, count, rate) => ({
      getChannelData: () => {
        const a = new Float32Array(count);
        values.push(a);
        return a;
      },
    }),
  };
  try {
    await pcmWindow(context, "https://invalid.test/stem.wav", 0, 0.00025);
    assert.deepEqual([...values[0]], [-1, 0.5]);
    await assert.rejects(pcmWindow(context, "x", 0, 60), /Invalid/);
  } finally {
    globalThis.fetch = previous;
  }
});
