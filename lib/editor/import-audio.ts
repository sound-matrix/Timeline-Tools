import { audioType } from "./model.ts";
import { wavHeader } from "../studio-preview.ts";
import { localEntry, putEntry } from "./storage.ts";
export type ImportedAudio = {
  hash: string;
  audio: Blob;
  waveform: Blob;
  duration: number;
  sample_rate: number;
  channels: number;
};
class ImportWorker {
  worker = new Worker("/daw/import-worker.js", { type: "module" });
  next = 0;
  pending = new Map<
    number,
    { resolve: (data: any) => void; reject: (e: Error) => void }
  >();
  constructor() {
    this.worker.onmessage = ({ data }) => {
      const p = this.pending.get(data.id);
      this.pending.delete(data.id);
      if (data.error) p?.reject(Error(data.error));
      else p?.resolve(data);
    };
    this.worker.onerror = () => {
      for (const p of this.pending.values())
        p.reject(Error("Audio import worker failed"));
      this.pending.clear();
    };
  }
  request(
    data: Record<string, unknown>,
    transfer: Transferable[] = [],
  ): Promise<any> {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...data, id }, transfer);
    });
  }
  close() {
    this.worker.terminate();
    for (const p of this.pending.values()) p.reject(Error("Import cancelled"));
    this.pending.clear();
  }
}
export async function importAudio(
  file: File,
  projectRate: number,
  maxMb: number,
  userId: string,
  onLocal: (
    audio: Blob,
    metadata: {
      duration: number;
      sample_rate: number;
      channels: number;
      hash: string;
    },
  ) => void,
): Promise<ImportedAudio> {
  if (!audioType(file.name))
    throw Error("Unsupported type. Use WAV, MP3, FLAC, M4A/AAC, AIFF or OGG.");
  if (file.size > maxMb * 1048576)
    throw Error(`File exceeds your ${maxMb} MB plan limit.`);
  const w = new ImportWorker();
  let context: AudioContext | undefined;
  try {
    const { hash } = await w.request({ op: "hash", file }),
      key = `audio/${userId}/${hash}/${projectRate}`;
    const cached = await localEntry<ImportedAudio>(key).catch(() => undefined);
    if (cached) {
      onLocal(cached.audio, cached);
      return cached;
    }
    // PCM WAV needs no full decode: native sample-rate conversion occurs in Web Audio.
    let h: ReturnType<typeof wavHeader> | undefined;
    try {
      h = wavHeader(new Uint8Array(await file.slice(0, 65536).arrayBuffer()));
    } catch {}
    let result: ImportedAudio;
    if (h) {
      const duration = h.length / h.block / h.rate;
      if (
        !Number.isFinite(duration) ||
        duration <= 0 ||
        duration > 14400 ||
        h.length + h.offset > file.size
      )
        throw Error("Corrupt WAV or duration exceeds four hours.");
      const metadata = {
        duration,
        sample_rate: h.rate,
        channels: h.channels,
        hash,
      };
      onLocal(file, metadata);
      const { waveform } = await w.request({ op: "pcmPeaks", file, header: h });
      result = { ...metadata, audio: file, waveform };
    } else {
      context = new AudioContext({ sampleRate: projectRate });
      let buffer: AudioBuffer;
      try {
        buffer = await context.decodeAudioData(await file.arrayBuffer());
      } catch {
        throw Error(
          "This file is corrupt or its codec is unsupported by your browser.",
        );
      }
      if (buffer.duration > 14400 || buffer.numberOfChannels > 2)
        throw Error("Use mono/stereo audio up to four hours.");
      if (buffer.length * buffer.numberOfChannels * 4 + 44 > maxMb * 1048576)
        throw Error(`Decoded audio exceeds your ${maxMb} MB plan limit.`);
      const channels = buffer.numberOfChannels,
        metadata = {
          hash,
          duration: buffer.duration,
          sample_rate: buffer.sampleRate,
          channels,
        };
      await w.request({ op: "begin", rate: buffer.sampleRate, channels });
      for (let at = 0; at < buffer.length; at += 65536) {
        const values = Array.from({ length: channels }, (_, ch) =>
          buffer.getChannelData(ch).slice(at, at + 65536),
        );
        await w.request(
          { op: "chunk", channels: values },
          values.map((v) => v.buffer),
        );
      }
      const { audio, waveform } = await w.request({ op: "finish" });
      result = { ...metadata, audio, waveform };
      onLocal(audio, metadata);
    }
    // A failed local cache must not prevent an otherwise successful import/upload.
    await putEntry(key, result).catch(() => {});
    return result;
  } finally {
    w.close();
    await context?.close();
  }
}
