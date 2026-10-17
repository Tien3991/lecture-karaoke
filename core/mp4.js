// Minimal MP4 reader. It finds the moov box (at the start or the end of the file, reading only
// that box) and reports what the player needs: duration, video size, and how long each track's
// leading empty edit delays its start. Soniox counts from the first audio sample, so the audio
// track's delay is the offset between the transcript's clock and the video's clock.
const latin1 = new TextDecoder("latin1");

/** read(offset, length) -> Promise<Uint8Array>; size = file size in bytes. */
export async function readMp4Info(read, size) {
  let offset = 0, moov = null;
  while (offset + 8 <= size) {
    const h = await read(offset, 16);
    const dv = new DataView(h.buffer, h.byteOffset, h.byteLength);
    let boxSize = dv.getUint32(0), header = 8;
    const type = latin1.decode(h.subarray(4, 8));
    if (boxSize === 1) { boxSize = Number(dv.getBigUint64(8)); header = 16; }
    else if (boxSize === 0) boxSize = size - offset;
    if (boxSize < header) throw new Error("not a valid MP4 file");
    if (type === "moov") { moov = await read(offset + header, boxSize - header); break; }
    offset += boxSize;
  }
  if (!moov) throw new Error("no moov box: is this an MP4 file?");
  return { ...parseMoov(moov), moov };
}

/**
 * Identifies a video file whatever its name: SHA-256 of its size and its moov box (the index of
 * every sample, which differs between any two encodes). Uses only what readMp4Info read, so it
 * costs about a millisecond per MB of moov. vertical_video_maker computes the same value.
 */
export async function videoFingerprint(info, size) {
  const head = new TextEncoder().encode(`lk-fp1:${size}:`);
  const buf = new Uint8Array(head.length + info.moov.length);
  buf.set(head);
  buf.set(info.moov, head.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
  return "fp1-" + [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Read from a browser File/Blob. */
export const blobReader = (blob) => async (offset, length) =>
  new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer());

function* boxes(buf, start = 0, end = buf.length) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let off = start; off + 8 <= end;) {
    let size = dv.getUint32(off), header = 8;
    const type = latin1.decode(buf.subarray(off + 4, off + 8));
    if (size === 1) { size = Number(dv.getBigUint64(off + 8)); header = 16; }
    else if (size === 0) size = end - off;
    if (size < header || off + size > end) return;
    yield { type, start: off + header, end: off + size, dv };
    off += size;
  }
}

function parseElst(buf, box) {
  const version = buf[box.start], count = box.dv.getUint32(box.start + 4), edits = [];
  for (let i = 0, p = box.start + 8; i < count; i++) {
    if (version === 1) {
      edits.push({ duration: Number(box.dv.getBigUint64(p)), mediaTime: Number(box.dv.getBigInt64(p + 8)) });
      p += 20;
    } else {
      edits.push({ duration: box.dv.getUint32(p), mediaTime: box.dv.getInt32(p + 4) });
      p += 12;
    }
  }
  return edits;
}

function parseTrak(buf, trak) {
  const t = { handler: "", width: 0, height: 0, edits: [], mediaTimescale: 0 };
  for (const b of boxes(buf, trak.start, trak.end)) {
    if (b.type === "tkhd") {
      t.width = b.dv.getUint32(b.end - 8) / 65536;
      t.height = b.dv.getUint32(b.end - 4) / 65536;
    } else if (b.type === "edts") {
      for (const e of boxes(buf, b.start, b.end)) if (e.type === "elst") t.edits = parseElst(buf, e);
    } else if (b.type === "mdia") {
      for (const m of boxes(buf, b.start, b.end)) {
        if (m.type === "mdhd") t.mediaTimescale = m.dv.getUint32(m.start + (buf[m.start] === 1 ? 20 : 12));
        else if (m.type === "hdlr") t.handler = latin1.decode(buf.subarray(m.start + 8, m.start + 12));
      }
    }
  }
  return t;
}

function parseMoov(buf) {
  let timescale = 0, duration = 0;
  const tracks = [];
  for (const b of boxes(buf)) {
    if (b.type === "mvhd") {
      const v1 = buf[b.start] === 1;
      timescale = b.dv.getUint32(b.start + (v1 ? 20 : 12));
      duration = v1 ? Number(b.dv.getBigUint64(b.start + 24)) : b.dv.getUint32(b.start + 16);
    } else if (b.type === "trak") {
      tracks.push(parseTrak(buf, b));
    }
  }
  for (const t of tracks) {   // leading empty edits (media time -1) delay the track's start
    let empty = 0;
    for (const e of t.edits) { if (e.mediaTime !== -1) break; empty += e.duration; }
    t.startSec = timescale ? empty / timescale : 0;
  }
  const video = tracks.find((t) => t.handler === "vide");
  const audio = tracks.find((t) => t.handler === "soun");
  return {
    durationSec: timescale ? duration / timescale : 0,
    width: video ? video.width : 0, height: video ? video.height : 0,
    videoStartSec: video ? video.startSec : 0, audioStartSec: audio ? audio.startSec : 0, tracks,
  };
}
