// Incremental SHA-256. The streaming state is 64 bytes plus 8 words, regardless of file length.
export class Sha256 {
  constructor() {
    this.h = new Uint32Array([
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
      0x1f83d9ab, 0x5be0cd19,
    ]);
    this.tail = new Uint8Array(64);
    this.used = 0;
    this.length = 0;
  }
  block(bytes) {
    const k = [
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
      0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
      0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
      0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
      0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
      0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
      0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
      0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
      0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ];
    const rr = (v, n) => (v >>> n) | (v << (32 - n)),
      w = new Uint32Array(64),
      v = new DataView(bytes.buffer, bytes.byteOffset, 64);
    for (let i = 0; i < 16; i++) w[i] = v.getUint32(i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15],
        b = w[i - 2];
      w[i] =
        (w[i - 16] +
          (rr(a, 7) ^ rr(a, 18) ^ (a >>> 3)) +
          w[i - 7] +
          (rr(b, 17) ^ rr(b, 19) ^ (b >>> 10))) >>>
        0;
    }
    let [a, b, c, d, e, f, g, h] = this.h;
    for (let i = 0; i < 64; i++) {
      const x =
          (h +
            (rr(e, 6) ^ rr(e, 11) ^ rr(e, 25)) +
            ((e & f) ^ (~e & g)) +
            k[i] +
            w[i]) >>>
          0,
        y =
          ((rr(a, 2) ^ rr(a, 13) ^ rr(a, 22)) +
            ((a & b) ^ (a & c) ^ (b & c))) >>>
          0;
      h = g;
      g = f;
      f = e;
      e = (d + x) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (x + y) >>> 0;
    }
    [a, b, c, d, e, f, g, h].forEach(
      (v, i) => (this.h[i] = (this.h[i] + v) >>> 0),
    );
  }
  update(bytes) {
    this.length += bytes.length;
    let at = 0;
    while (at < bytes.length) {
      const n = Math.min(64 - this.used, bytes.length - at);
      this.tail.set(bytes.subarray(at, at + n), this.used);
      this.used += n;
      at += n;
      if (this.used === 64) {
        this.block(this.tail);
        this.used = 0;
      }
    }
    return this;
  }
  digest() {
    const length = this.length,
      pad = new Uint8Array(this.used < 56 ? 64 - this.used : 128 - this.used);
    pad[0] = 128;
    const view = new DataView(pad.buffer);
    view.setUint32(pad.length - 8, Math.floor(length / 0x20000000));
    view.setUint32(pad.length - 4, (length * 8) >>> 0);
    this.update(pad);
    return Array.from(this.h, (v) => v.toString(16).padStart(8, "0")).join("");
  }
}
let parts = [],
  peaks = [],
  frame = 0,
  low = 0,
  high = 0,
  rate = 48000,
  channels = 2,
  binSize = 480,
  binCount = 0;
function addPeaks(values, frames) {
  for (let i = 0; i < frames; i++) {
    for (let ch = 0; ch < values.length; ch++) {
      const v = values[ch][i] ?? 0;
      low = Math.min(low, v);
      high = Math.max(high, v);
    }
    if (++binCount >= binSize) {
      peaks.push([
        Math.max(-128, Math.round(low * 127)),
        Math.min(127, Math.round(high * 127)),
      ]);
      low = 0;
      high = 0;
      binCount = 0;
    }
  }
}
function header(frames, channels, rate) {
  const out = new ArrayBuffer(44),
    v = new DataView(out),
    text = (p, s) =>
      Array.from(s).forEach((c, i) => v.setUint8(p + i, c.charCodeAt(0)));
  text(0, "RIFF");
  v.setUint32(4, 36 + frames * channels * 4, true);
  text(8, "WAVEfmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 3, true);
  v.setUint16(22, channels, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * channels * 4, true);
  v.setUint16(32, channels * 4, true);
  v.setUint16(34, 32, true);
  text(36, "data");
  v.setUint32(40, frames * channels * 4, true);
  return out;
}
if (typeof self !== "undefined")
  self.onmessage = async ({ data }) => {
    try {
      if (data.op === "hash") {
        const hash = new Sha256();
        for (let at = 0; at < data.file.size; at += 1048576)
          hash.update(
            new Uint8Array(
              await data.file.slice(at, at + 1048576).arrayBuffer(),
            ),
          );
        self.postMessage({ id: data.id, hash: hash.digest() });
        return;
      }
      if (data.op === "begin") {
        parts = [];
        peaks = [];
        frame = 0;
        rate = data.rate;
        channels = data.channels;
        binSize = Math.round(rate / 100);
        binCount = 0;
        low = high = 0;
      }
      if (data.op === "chunk") {
        const values = data.channels,
          n = values[0].length,
          bytes = new Float32Array(n * channels);
        for (let i = 0; i < n; i++)
          for (let ch = 0; ch < channels; ch++)
            bytes[i * channels + ch] = values[ch][i];
        parts.push(bytes.buffer);
        frame += n;
        addPeaks(values, n);
      }
      if (data.op === "finish") {
        if (binCount)
          peaks.push([Math.round(low * 127), Math.round(high * 127)]);
        const audio = new Blob([header(frame, channels, rate), ...parts], {
            type: "audio/wav",
          }),
          waveform = new Blob([JSON.stringify({ rate: 100, peaks })], {
            type: "application/json",
          });
        self.postMessage({ id: data.id, audio, waveform });
        parts = [];
        peaks = [];
        return;
      }
      if (data.op === "pcmPeaks") {
        const h = data.header,
          file = data.file;
        peaks = [];
        low = high = 0;
        binCount = 0;
        binSize = Math.round(h.rate / 100);
        for (let at = 0; at < h.length; at += h.block * 65536) {
          const bytes = new Uint8Array(
              await file
                .slice(
                  h.offset + at,
                  h.offset + Math.min(h.length, at + h.block * 65536),
                )
                .arrayBuffer(),
            ),
            v = new DataView(bytes.buffer),
            n = Math.floor(bytes.length / h.block),
            values = Array.from(
              { length: h.channels },
              () => new Float32Array(n),
            );
          for (let i = 0; i < n; i++)
            for (let ch = 0; ch < h.channels; ch++) {
              const p = i * h.block + (ch * h.bits) / 8;
              let x;
              if (h.format === 3) x = v.getFloat32(p, true);
              else if (h.bits === 16) x = v.getInt16(p, true) / 32768;
              else if (h.bits === 24) {
                let raw = bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16);
                if (raw & 0x800000) raw |= ~0xffffff;
                x = raw / 8388608;
              } else x = v.getInt32(p, true) / 2147483648;
              values[ch][i] = Number.isFinite(x) ? x : 0;
            }
          addPeaks(values, n);
        }
        if (binCount)
          peaks.push([Math.round(low * 127), Math.round(high * 127)]);
        const waveform = new Blob([JSON.stringify({ rate: 100, peaks })], {
          type: "application/json",
        });
        self.postMessage({ id: data.id, waveform });
        peaks = [];
        return;
      }
      self.postMessage({ id: data.id, ok: true });
    } catch (e) {
      self.postMessage({ id: data.id, error: e.message });
    }
  };
