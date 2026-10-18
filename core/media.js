// Audio recordings: which files the app plays, how a recording is identified, and its cover art.
//   MP4 family (.mp4 .m4v .mov, and .m4a .m4b audio): identified by the moov box (fp1, core/mp4.js);
//     an MP4 without a video track is a recording, its art in moov/udta/meta/ilst/covr.
//   Other audio (MP3, AAC, WAV, FLAC, Ogg, Opus): identified by Dropbox's content hash, "fa1-" +
//     the hash, which Dropbox lists for its files and the app computes for a picked one; art in an
//     ID3v2 tag (MP3, AAC, and WAV's "id3 " chunk) or a FLAC PICTURE block.
// vertical_video_maker classifies files by the same extensions and computes the same fingerprints.
// Pure functions: they run in the browser and in the Node tests.
import { boxes } from "./mp4.js";

export const MP4_FILE = /\.(mp4|m4v|mov|m4a|m4b)$/i;
export const AUDIO_FILE = /\.(m4a|m4b|mp3|aac|wav|flac|ogg|oga|opus)$/i;
export const MEDIA_FILE = /\.(mp4|m4v|mov|m4a|m4b|mp3|aac|wav|flac|ogg|oga|opus)$/i;

/** "mp4" (read its moov), "audio" (identified by its content hash), or null for a file the app
 *  doesn't play. The extension decides, as in the job; a file without a known one is sniffed:
 *  head is its first 12 bytes (an MP4 starts with an ftyp box), type its MIME type. */
export function mediaKind(name, type = "", head = null) {
  if (MP4_FILE.test(name)) return "mp4";
  if (AUDIO_FILE.test(name)) return "audio";
  if (head && head.length >= 8 && text(head, 4, 8) === "ftyp") return "mp4";
  return type.startsWith("audio/") ? "audio" : type.startsWith("video/") ? "mp4" : null;
}

/** A recording's fingerprint from its Dropbox content hash (the same hash for the same bytes). */
export const hashFingerprint = (contentHash) => `fa1-${contentHash}`;

const latin1 = new TextDecoder("latin1");
const text = (buf, start, end) => latin1.decode(buf.subarray(start, end));
const u32 = (buf, at) => ((buf[at] << 24) | (buf[at + 1] << 16) | (buf[at + 2] << 8) | buf[at + 3]) >>> 0;
const syncsafe = (buf, at) => ((buf[at] & 0x7f) << 21) | ((buf[at + 1] & 0x7f) << 14) | ((buf[at + 2] & 0x7f) << 7) | (buf[at + 3] & 0x7f);
const MAX_ART = 16 * 1024 * 1024;   // tags bigger than this aren't read

/** The image type from its first bytes, else from what the file says. */
function imageType(data, said = "") {
  if (data[0] === 0xff && data[1] === 0xd8) return "image/jpeg";
  if (data[0] === 0x89 && text(data, 1, 4) === "PNG") return "image/png";
  if (text(data, 0, 4) === "GIF8") return "image/gif";
  if (text(data, 0, 4) === "RIFF" && text(data, 8, 12) === "WEBP") return "image/webp";
  if (data[0] === 0x42 && data[1] === 0x4d) return "image/bmp";
  said = said.toLowerCase();
  return said === "jpg" ? "image/jpeg" : said.includes("/") ? said : said ? `image/${said}` : "";
}
const art = (data, said) => {
  const type = imageType(data, said);
  return type && data.length > 16 ? { type, data: data.slice() } : null;   // its own copy, not a view of the tag
};

/** Undoes ID3 unsynchronisation: every 0xFF 0x00 was written for a lone 0xFF. */
function resync(buf) {
  const out = new Uint8Array(buf.length);
  let o = 0;
  for (let i = 0; i < buf.length; i++) {
    out[o++] = buf[i];
    if (buf[i] === 0xff && buf[i + 1] === 0x00) i++;
  }
  return out.subarray(0, o);
}

/** Where a string in an ID3 text encoding ends (its terminator: one zero byte, or two aligned
 *  ones for UTF-16), and where what follows it starts. */
function skipString(buf, at, encoding) {
  if (encoding === 1 || encoding === 2) {
    for (let i = at; i + 1 < buf.length; i += 2) if (buf[i] === 0 && buf[i + 1] === 0) return i + 2;
  } else {
    for (let i = at; i < buf.length; i++) if (buf[i] === 0) return i + 1;
  }
  return buf.length;
}

/** The cover from a whole ID3v2 tag (the 10-byte header included): the front cover (picture type
 *  3) if there is one, else the first picture. Versions 2.2, 2.3 and 2.4. */
export function id3Artwork(tag) {
  if (tag.length < 10 || text(tag, 0, 3) !== "ID3") return null;
  const major = tag[3], flags = tag[5];
  if (major < 2 || major > 4 || (major === 2 && flags & 0x40)) return null;   // 2.2's compressed tags aren't read
  let body = tag.subarray(10, 10 + syncsafe(tag, 6));
  if (flags & 0x80 && major < 4) body = resync(body);   // 2.4 marks it per frame instead
  let at = 0;
  if (flags & 0x40 && major === 3) at = 4 + u32(body, 0);          // extended header: its size leaves out itself
  else if (flags & 0x40 && major === 4) at = syncsafe(body, 0);    // ... and includes itself in 2.4
  const idLen = major === 2 ? 3 : 4, headLen = major === 2 ? 6 : 10;
  let first = null;
  while (at + headLen <= body.length && body[at] !== 0) {
    const id = text(body, at, at + idLen);
    const size = major === 2 ? (body[at + 3] << 16) | (body[at + 4] << 8) | body[at + 5]
      : major === 4 ? syncsafe(body, at + 4) : u32(body, at + 4);
    const fflags = major === 2 ? 0 : body[at + 9];
    let frame = body.subarray(at + headLen, Math.min(at + headLen + size, body.length));
    at += headLen + size;
    if (id !== "APIC" && id !== "PIC") continue;
    if (major === 3 && fflags & 0xc0) continue;                    // compressed or encrypted
    if (major === 3 && fflags & 0x20) frame = frame.subarray(1);   // grouping identity
    if (major === 4) {
      if (fflags & 0x0c) continue;                                 // compressed or encrypted
      if (fflags & 0x40) frame = frame.subarray(1);                // grouping identity
      if (fflags & 0x01) frame = frame.subarray(4);                // data length indicator
      if (fflags & 0x02 || flags & 0x80) frame = resync(frame);
    }
    if (frame.length < 4) continue;
    const encoding = frame[0];
    let p = 1, said;
    if (id === "PIC") { said = text(frame, 1, 4); p = 4; }          // 2.2: a three-letter format
    else { const end = skipString(frame, 1, 0); said = text(frame, 1, end - 1); p = end; }
    const kind = frame[p];
    const pic = art(frame.subarray(skipString(frame, p + 1, encoding)), said);
    if (pic && kind === 3) return pic;
    first ??= pic;
  }
  return first;
}

/** The cover from a FLAC file's metadata blocks (PICTURE, type 6): read is (offset, length) ->
 *  Uint8Array, at is where "fLaC" starts. */
async function flacArtwork(read, size, at) {
  let first = null;
  for (let p = at + 4; p + 4 <= size;) {
    const h = await read(p, 4), last = h[0] & 0x80, type = h[0] & 0x7f, len = (h[1] << 16) | (h[2] << 8) | h[3];
    if (type === 6 && len <= MAX_ART) {
      const b = await read(p + 4, len);
      const mimeLen = u32(b, 4), descLen = u32(b, 8 + mimeLen), dataAt = 8 + mimeLen + 4 + descLen + 16;
      const pic = art(b.subarray(dataAt + 4, dataAt + 4 + u32(b, dataAt)), text(b, 8, 8 + mimeLen));
      if (pic && u32(b, 0) === 3) return pic;
      first ??= pic;
    }
    if (last || type === 127) break;
    p += 4 + len;
  }
  return first;
}

/** A whole ID3v2 tag that starts at `at` (header, body and footer), or null. */
async function id3Tag(read, size, at) {
  const h = await read(at, 10);
  if (h.length < 10 || text(h, 0, 3) !== "ID3") return null;
  const len = 10 + syncsafe(h, 6) + (h[5] & 0x10 ? 10 : 0);
  return len <= MAX_ART && at + len <= size ? read(at, len) : null;
}

/** The cover art of a recording that isn't an MP4: {type, data} or null. read is (offset, length)
 *  -> Uint8Array; only the tags are read (for a Dropbox file, a few small ranges). */
export async function audioArtwork(read, size) {
  if (size < 12) return null;
  const head = await read(0, 12);
  if (text(head, 0, 3) === "ID3") {
    const tag = await id3Tag(read, size, 0);
    const pic = tag && id3Artwork(tag);
    if (pic) return pic;
    const after = 10 + syncsafe(head, 6) + (head[5] & 0x10 ? 10 : 0);   // a FLAC file may start with one
    const next = after + 4 <= size ? await read(after, 4) : null;
    return next && text(next, 0, 4) === "fLaC" ? flacArtwork(read, size, after) : null;
  }
  if (text(head, 0, 4) === "fLaC") return flacArtwork(read, size, 0);
  if (text(head, 0, 4) === "RIFF" && text(head, 8, 12) === "WAVE") {
    for (let p = 12; p + 8 <= size;) {   // chunks: the ID3 one usually comes after the audio
      const c = await read(p, 8), id = text(c, 0, 4), len = (c[4] | (c[5] << 8) | (c[6] << 16) | (c[7] << 24)) >>> 0;
      if (id === "id3 " || id === "ID3 ") {
        const tag = await id3Tag(read, size, p + 8);
        return tag && id3Artwork(tag);
      }
      p += 8 + len + (len & 1);
    }
  }
  return null;
}

/** The cover art in an MP4's moov box (iTunes-style: udta/meta/ilst/covr/data), or null. */
export function mp4Artwork(moov) {
  const find = (start, end, type) => { for (const b of boxes(moov, start, end)) if (b.type === type) return b; return null; };
  const udta = find(0, moov.length, "udta"), meta = udta && find(udta.start, udta.end, "meta");
  if (!meta) return null;
  // a full box (version and flags first) in MP4 files, a plain one in some QuickTime files
  const kids = text(moov, meta.start + 4, meta.start + 8) === "hdlr" ? meta.start : meta.start + 4;
  const ilst = find(kids, meta.end, "ilst"), covr = ilst && find(ilst.start, ilst.end, "covr");
  if (!covr) return null;
  for (const d of boxes(moov, covr.start, covr.end)) {
    if (d.type !== "data" || d.end - d.start <= 8) continue;
    const kind = u32(moov, d.start);   // 13 JPEG, 14 PNG, 27 BMP
    const pic = art(moov.subarray(d.start + 8, d.end), kind === 13 ? "image/jpeg" : kind === 14 ? "image/png" : kind === 27 ? "image/bmp" : "");
    if (pic) return pic;
  }
  return null;
}

/** Joins small reads into larger ones (for files read over the network), keeping what it read. */
export function pagedReader(read, size, page = 256 * 1024) {
  const pages = new Map();
  const get = (n) => {
    if (!pages.has(n)) pages.set(n, read(n * page, Math.min(page, size - n * page)));
    return pages.get(n);
  };
  return async (offset, length) => {
    length = Math.max(0, Math.min(length, size - offset));
    if (length > page) return read(offset, length);   // a big read (a whole picture) goes as it is
    const out = new Uint8Array(length);
    for (let o = 0; o < length;) {
      const n = Math.floor((offset + o) / page), at = (offset + o) % page, chunk = await get(n);
      const take = Math.min(length - o, chunk.length - at);
      if (take <= 0) break;
      out.set(chunk.subarray(at, at + take), o);
      o += take;
    }
    return out;
  };
}
