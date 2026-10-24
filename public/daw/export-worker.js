// PCM WAV encoding and optional LGPL lamejs MP3 encoding run off the UI thread.
let parts = [],
  encoder,
  format = "wav",
  rate = 48000,
  depth = 24,
  frames = 0;
function wavHeader(frames, rate, depth) {
  const data = frames * 2 * (depth / 8),
    v = new DataView(new ArrayBuffer(44)),
    text = (p, s) =>
      Array.from(s).forEach((c, i) => v.setUint8(p + i, c.charCodeAt(0)));
  text(0, "RIFF");
  v.setUint32(4, 36 + data, true);
  text(8, "WAVEfmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 2, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, (rate * 2 * depth) / 8, true);
  v.setUint16(32, (2 * depth) / 8, true);
  v.setUint16(34, depth, true);
  text(36, "data");
  v.setUint32(40, data, true);
  return v.buffer;
}
self.onmessage = ({ data }) => {
  try {
    if (data.op === "begin") {
      parts = [];
      format = data.format;
      rate = data.rate;
      depth = data.depth;
      frames = 0;
      if (format === "mp3") {
        importScripts("/daw/vendor/lame.min.js");
        encoder = new lamejs.Mp3Encoder(2, rate, data.bitrate);
      }
      self.postMessage({ id: data.id });
      return;
    }
    if (data.op === "chunk") {
      const [l, r] = data.channels;
      frames += l.length;
      if (format === "mp3") {
        const to16 = (x) =>
          Int16Array.from(x, (v) =>
            Math.max(-32768, Math.min(32767, Math.round(v * 32767))),
          );
        const bytes = encoder.encodeBuffer(to16(l), to16(r));
        if (bytes.length) parts.push(new Uint8Array(bytes));
      } else {
        const bytes = new Uint8Array((l.length * 2 * depth) / 8),
          v = new DataView(bytes.buffer);
        for (let i = 0; i < l.length; i++)
          for (let ch = 0; ch < 2; ch++) {
            const x = Math.max(-1, Math.min(1, (ch ? r : l)[i])),
              p = ((i * 2 + ch) * depth) / 8;
            if (depth === 16)
              v.setInt16(
                p,
                Math.max(-32768, Math.min(32767, Math.round(x * 32768))),
                true,
              );
            else {
              const n = Math.max(
                -8388608,
                Math.min(8388607, Math.round(x * 8388608)),
              );
              bytes[p] = n;
              bytes[p + 1] = n >> 8;
              bytes[p + 2] = n >> 16;
            }
          }
        parts.push(bytes.buffer);
      }
      self.postMessage({ id: data.id });
      return;
    }
    if (data.op === "finish") {
      if (format === "mp3") {
        const bytes = encoder.flush();
        if (bytes.length) parts.push(new Uint8Array(bytes));
      } else parts.unshift(wavHeader(frames, rate, depth));
      const blob = new Blob(parts, {
        type: format === "mp3" ? "audio/mpeg" : "audio/wav",
      });
      parts = [];
      self.postMessage({ id: data.id, blob });
    }
  } catch (e) {
    self.postMessage({ id: data.id, error: e.message });
  }
};
