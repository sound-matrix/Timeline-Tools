/** Read a bounded PCM WAV window; never decode an hour-long stem into browser RAM. */
async function boundedBody(response: Response, limit: number) {
  if (!response.ok || !response.body) throw Error("Preview unavailable");
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw Error("Preview requires byte-range support");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const result = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    result.set(chunk, at);
    at += chunk.length;
  }
  return result;
}
export function wavHeader(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (p: number, n: number) =>
    String.fromCharCode(...bytes.subarray(p, p + n));
  if (text(0, 4) !== "RIFF" || text(8, 4) !== "WAVE")
    throw Error("Unsupported preview stem");
  let at = 12,
    rate = 0,
    channels = 0,
    bits = 0,
    format = 0,
    block = 0;
  while (at + 8 <= bytes.length) {
    const kind = text(at, 4),
      length = view.getUint32(at + 4, true),
      start = at + 8;
    if (kind === "fmt " && length >= 16 && start + length <= bytes.length) {
      format = view.getUint16(start, true);
      channels = view.getUint16(start + 2, true);
      rate = view.getUint32(start + 4, true);
      block = view.getUint16(start + 12, true);
      bits = view.getUint16(start + 14, true);
      if (format === 65534 && length >= 40)
        format = view.getUint16(start + 24, true);
    }
    if (kind === "data") {
      if (
        ![1, 3].includes(format) ||
        channels < 1 ||
        channels > 2 ||
        ![16, 24, 32].includes(bits) ||
        block !== (channels * bits) / 8 ||
        rate < 8000 ||
        rate > 192000
      )
        throw Error("Unsupported PCM");
      return { offset: start, length, rate, channels, bits, format, block };
    }
    at = start + length + (length % 2);
  }
  throw Error("WAV header unavailable");
}
export async function pcmWindow(
  context: AudioContext,
  url: string,
  start: number,
  length: number,
) {
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(length) ||
    start < 0 ||
    length <= 0 ||
    length > 5.01
  )
    throw Error("Invalid preview window");
  const first = await fetch(url, { headers: { Range: "bytes=0-65535" } });
  // Small files may ignore Range; large files must honor it. Read at most 4 MB.
  const head = await boundedBody(first, 4 * 1024 * 1024),
    header = wavHeader(head);
  const firstFrame = Math.round(start * header.rate),
    frames = Math.min(
      Math.round(length * header.rate),
      Math.floor(header.length / header.block) - firstFrame,
    );
  if (frames <= 0) throw Error("Empty preview window");
  const from = header.offset + firstFrame * header.block,
    to = from + frames * header.block - 1;
  let bytes: Uint8Array;
  if (first.status === 200 && head.length > to)
    bytes = head.subarray(from, to + 1);
  else {
    const response = await fetch(url, {
      headers: { Range: `bytes=${from}-${to}` },
    });
    const raw = await boundedBody(response, 4 * 1024 * 1024);
    bytes = response.status === 206 ? raw : raw.subarray(from, to + 1);
  }
  const count = Math.min(frames, Math.floor(bytes.length / header.block));
  if (!count) throw Error("No preview samples");
  const buffer = context.createBuffer(header.channels, count, header.rate),
    view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let channel = 0; channel < header.channels; channel++) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < count; i++) {
      const p = i * header.block + (channel * header.bits) / 8;
      let value = 0;
      if (header.format === 3 && header.bits === 32)
        value = view.getFloat32(p, true);
      else if (header.bits === 16) value = view.getInt16(p, true) / 32768;
      else if (header.bits === 24) {
        let v = bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16);
        if (v & 0x800000) v |= ~0xffffff;
        value = v / 8388608;
      } else value = view.getInt32(p, true) / 2147483648;
      data[i] = Number.isFinite(value) ? value : 0;
    }
  }
  return buffer;
}
