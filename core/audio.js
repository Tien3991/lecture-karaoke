// Copies an MP4's AAC audio track into an ADTS stream (.aac): the same compressed frames, not
// re-encoded, each behind a 7-byte header, so any decoder (ffmpeg in the transcription job) reads
// it on its own. About 1 MB per minute at 128 kbit/s, against 3-10 MB per minute for the video.
// The frames are found through the track's sample tables: stsd/esds for the decoder configuration
// (AudioSpecificConfig), stsz (or stz2) for their sizes, stsc for how many sit in each chunk, and
// stco (or co64) for where each chunk is; the file is read in slices of up to 8 MB.
// An ADTS stream has no edit list, so its decoded audio starts skipMs before the video's (the
// media time of the audio's first edit, usually decoder priming): the transcription job moves the
// transcript's times earlier by that much.
import { boxes } from "./mp4.js";

export const CANT_COPY = "This video's audio can't be copied; use Upload to Dropbox instead";
const RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
// Reads cover up to 8 MB, taking in the video between audio chunks when it is under 256 KB.
const WINDOW = 8 * 1024 * 1024, GAP = 256 * 1024;

const cant = () => new Error(CANT_COPY);
function child(buf, start, end, type) {
  for (const b of boxes(buf, start, end)) if (b.type === type) return b;
  return null;
}
function descend(buf, [start, end], path) {
  let b = { start, end };
  for (const type of path) if (!(b = child(buf, b.start, b.end, type))) return null;
  return b;
}

/** MPEG-4 descriptors inside esds: {tag, start, end}. */
function* descriptors(buf, start, end) {
  for (let at = start; at + 2 <= end;) {
    const tag = buf[at++];
    let len = 0;
    for (let i = 0; i < 4 && at < end; i++) {
      const b = buf[at++];
      len = len * 128 + (b & 0x7f);
      if (!(b & 0x80)) break;
    }
    yield { tag, start: at, end: Math.min(at + len, end) };
    at += len;
  }
}
function bitReader(buf, start, end) {
  let pos = start * 8;
  return (n) => {
    let v = 0;
    for (let i = 0; i < n; i++, pos++) {
      if (pos >= end * 8) throw cant();
      v = v * 2 + ((buf[pos >> 3] >> (7 - (pos & 7))) & 1);
    }
    return v;
  };
}

/** What an ADTS header needs from the track's AudioSpecificConfig: {profile, freqIndex, channels}. */
function decoderConfig(buf, stsd) {
  const entry = boxes(buf, stsd.start + 8, stsd.end).next().value;
  if (!entry || entry.type !== "mp4a") throw cant();             // AC-3, Opus, ALAC, PCM, MP3...
  const version = entry.dv.getUint16(entry.start + 8);           // QuickTime sound descriptions add fields
  const kids = entry.start + (version === 1 ? 44 : version === 2 ? 64 : 28);
  let esds = child(buf, kids, entry.end, "esds");
  if (!esds) { const wave = child(buf, kids, entry.end, "wave"); esds = wave && child(buf, wave.start, wave.end, "esds"); }
  const es = esds && [...descriptors(buf, esds.start + 4, esds.end)].find((d) => d.tag === 3);
  if (!es) throw cant();
  let at = es.start + 2;
  const flags = buf[at++];
  if (flags & 0x80) at += 2;              // depends on another stream
  if (flags & 0x40) at += 1 + buf[at];    // URL
  if (flags & 0x20) at += 2;              // OCR stream
  const dec = [...descriptors(buf, at, es.end)].find((d) => d.tag === 4);
  // MPEG-4 audio, or MPEG-2 AAC Main/LC/SSR (MP3 and others can't go into ADTS)
  if (!dec || ![0x40, 0x66, 0x67, 0x68].includes(buf[dec.start])) throw cant();
  const asc = [...descriptors(buf, dec.start + 13, dec.end)].find((d) => d.tag === 5);
  if (!asc) throw cant();
  const bits = bitReader(buf, asc.start, asc.end);
  const objectType = () => { const t = bits(5); return t === 31 ? 32 + bits(6) : t; };
  let aot = objectType();
  const freqIndex = bits(4);
  if (freqIndex === 15) throw cant();     // a frequency ADTS can't name
  const channels = bits(4);
  if (aot === 5 || aot === 29) {          // HE-AAC signalled explicitly: ADTS carries the AAC core
    if (bits(4) === 15) bits(24);         // and decoders find the SBR part by themselves
    aot = objectType();
  }
  if (aot < 1 || aot > 4 || freqIndex >= RATES.length || channels < 1 || channels > 7) throw cant();
  return { profile: aot - 1, freqIndex, channels };
}

/** The track's frames: sizes[i], and chunks {offset, first, count, bytes} in file order. */
function sampleTables(buf, stbl) {
  const get = (type) => child(buf, stbl.start, stbl.end, type);
  const stsz = get("stsz"), stz2 = get("stz2"), stsc = get("stsc"), stco = get("stco"), co64 = get("co64");
  if (!(stsz || stz2) || !stsc || !(stco || co64)) throw new Error("This video's audio track is incomplete.");
  let sizes;
  if (stsz) {
    const fixed = stsz.dv.getUint32(stsz.start + 4), count = stsz.dv.getUint32(stsz.start + 8), at = stsz.start + 12;
    sizes = fixed ? new Uint32Array(count).fill(fixed) : new Uint32Array(count).map((_, i) => stsz.dv.getUint32(at + 4 * i));
  } else {
    const field = stz2.dv.getUint8(stz2.start + 7), count = stz2.dv.getUint32(stz2.start + 8), at = stz2.start + 12;
    sizes = new Uint32Array(count).map((_, i) => (field === 16 ? stz2.dv.getUint16(at + 2 * i) : field === 8 ? buf[at + i]
      : (buf[at + (i >> 1)] >> (i & 1 ? 0 : 4)) & 15));
  }
  const co = stco || co64, nChunks = co.dv.getUint32(co.start + 4);
  const offset = (c) => (stco ? co.dv.getUint32(co.start + 8 + 4 * c) : Number(co.dv.getBigUint64(co.start + 8 + 8 * c)));
  const chunks = [], nRuns = stsc.dv.getUint32(stsc.start + 4), run = (r, k) => stsc.dv.getUint32(stsc.start + 8 + 12 * r + 4 * k);
  let sample = 0;
  for (let r = 0; r < nRuns; r++) {
    const until = r + 1 < nRuns ? run(r + 1, 0) : nChunks + 1, count = run(r, 1);
    if (run(r, 2) !== 1) throw cant();   // frames with another decoder configuration
    for (let c = run(r, 0); c < until && c <= nChunks; c++) {
      let bytes = 0;
      for (let k = sample; k < sample + count; k++) bytes += sizes[k];
      chunks.push({ offset: offset(c - 1), first: sample, count, bytes });
      sample += count;
    }
  }
  if (sample !== sizes.length) throw new Error("This video's audio track is damaged (its tables disagree).");
  return { sizes, chunks };
}

/** The audio track's ADTS copy. read(offset, length) -> Uint8Array reads the file; info is
 *  readMp4Info's. Returns {blob, skipMs, frames}; onProgress(audio bytes copied, total). */
export async function extractAdts(read, info, { onProgress, signal } = {}) {
  const track = info.tracks.find((t) => t.handler === "soun");
  if (!track) throw new Error("This video has no sound.");
  const buf = info.moov, stbl = descend(buf, track.box, ["mdia", "minf", "stbl"]);
  const stsd = stbl && child(buf, stbl.start, stbl.end, "stsd");
  if (!stsd) throw new Error("This video's audio track is incomplete.");
  const { profile, freqIndex, channels } = decoderConfig(buf, stsd);
  const { sizes, chunks } = sampleTables(buf, stbl);
  const windows = [];
  for (const c of chunks) {
    const w = windows[windows.length - 1];
    if (w && c.offset >= w.end && c.offset - w.end <= GAP && c.offset + c.bytes - w.start <= WINDOW) {
      w.chunks.push(c);
      w.end = c.offset + c.bytes;
    } else windows.push({ start: c.offset, end: c.offset + c.bytes, chunks: [c] });
  }
  const total = chunks.reduce((n, c) => n + c.bytes, 0), parts = [];
  let done = 0;
  for (const w of windows) {
    signal?.throwIfAborted();
    const data = await read(w.start, w.end - w.start);
    if (data.length < w.end - w.start) throw new Error("The video file ends too early (damaged?).");
    const out = new Uint8Array(w.chunks.reduce((n, c) => n + c.bytes + 7 * c.count, 0));
    let o = 0;
    for (const c of w.chunks) {
      for (let k = c.first, at = c.offset - w.start; k < c.first + c.count; k++) {
        const size = sizes[k], len = size + 7;
        if (len > 8191) throw cant();
        // ADTS header: sync word, MPEG-4, no CRC, profile, frequency, channels, frame length,
        // buffer fullness 0x7FF (variable rate), one raw data block
        out[o] = 0xff;
        out[o + 1] = 0xf1;
        out[o + 2] = (profile << 6) | (freqIndex << 2) | (channels >> 2);
        out[o + 3] = ((channels & 3) << 6) | (len >> 11);
        out[o + 4] = (len >> 3) & 0xff;
        out[o + 5] = ((len & 7) << 5) | 0x1f;
        out[o + 6] = 0xfc;
        out.set(data.subarray(at, at + size), o + 7);
        o += len;
        at += size;
      }
      done += c.bytes;
    }
    parts.push(out);
    onProgress?.(done, total);
  }
  return { blob: new Blob(parts, { type: "audio/aac" }), skipMs: Math.round(info.audioSkipSec * 1000), frames: sizes.length };
}
