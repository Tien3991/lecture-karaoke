// Audio recordings (core/media.js): telling files apart, and reading cover art from ID3v2 tags
// (versions 2.2 to 2.4, unsynchronisation, extended headers, front cover first), FLAC PICTURE
// blocks, WAV "id3 " chunks and MP4 covr boxes. Tags are built here byte by byte for the corner
// cases; files made by ffmpeg (FFMPEG, else Homebrew's) check real ones, in a temporary folder.
// Also the paged reader used for Dropbox files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readMp4Info } from "../core/mp4.js";
import { AUDIO_FILE, MEDIA_FILE, audioArtwork, hashFingerprint, id3Artwork, mediaKind, mp4Artwork, pagedReader } from "../core/media.js";

const latin = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const cat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const be32 = (n) => Uint8Array.of(n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
const le32 = (n) => Uint8Array.of(n & 255, (n >>> 8) & 255, (n >>> 16) & 255, n >>> 24);
const syncsafe = (n) => Uint8Array.of((n >> 21) & 127, (n >> 14) & 127, (n >> 7) & 127, n & 127);
/** ID3 unsynchronisation: a zero after every 0xFF (decoders drop the zero after a 0xFF). */
const unsync = (b) => cat(...[...b].map((x) => (x === 0xff ? Uint8Array.of(0xff, 0) : Uint8Array.of(x))));
const reader = (buf) => async (offset, length) => buf.subarray(offset, Math.min(buf.length, offset + Math.max(0, length)));
// Stand-ins for pictures: the signatures, with 0xFF bytes that unsynchronisation has to restore.
const JPEG = cat(Uint8Array.of(0xff, 0xd8, 0xff, 0xe0), latin("JFIF"), Uint8Array.from({ length: 60 }, (_, i) => (i * 37) & 255),
  Uint8Array.of(0xff, 0x00, 0xff, 0xe5, 0xff, 0xd9));
const PNG = cat(Uint8Array.of(0x89), latin("PNG\r\n\x1a\n"), Uint8Array.from({ length: 60 }, (_, i) => (i * 11 + 255) & 255));
const same = (pic, image, type) => {
  assert.ok(pic, "a picture is found");
  assert.equal(pic.type, type);
  assert.deepEqual([...pic.data], [...image]);
};

/** APIC (2.3, 2.4): encoding, MIME type, picture type, description, data. */
const apic = (type, mime, image, desc = latin("\0")) => cat(Uint8Array.of(desc[0] === 0xff ? 1 : 0), latin(`${mime}\0`), Uint8Array.of(type), desc, image);
const utf16 = (s) => cat(Uint8Array.of(0xff, 0xfe), ...[...s].map((c) => Uint8Array.of(c.charCodeAt(0), 0)), Uint8Array.of(0, 0));
function id3v23(frames, { unsynced = false, extended = false } = {}) {
  let body = cat(...(extended ? [be32(6), Uint8Array.of(0, 0), be32(0)] : []),
    ...frames.map(([id, data, flags = 0]) => cat(latin(id), be32(data.length), Uint8Array.of(0, flags), data)), new Uint8Array(32));
  if (unsynced) body = unsync(body);
  return cat(latin("ID3"), Uint8Array.of(3, 0, (unsynced ? 0x80 : 0) | (extended ? 0x40 : 0)), syncsafe(body.length), body);
}
/** 2.4: syncsafe sizes; each frame here unsynchronised, with a data length indicator. */
function id3v24(frames) {
  const body = cat(...frames.map(([id, data]) => {
    const stored = cat(syncsafe(data.length), unsync(data));
    return cat(latin(id), syncsafe(stored.length), Uint8Array.of(0, 0x03), stored);
  }), new Uint8Array(16));
  return cat(latin("ID3"), Uint8Array.of(4, 0, 0), syncsafe(body.length), body);
}
function id3v22(frames) {
  const body = cat(...frames.map(([id, data]) => cat(latin(id), Uint8Array.of(data.length >> 16, (data.length >> 8) & 255, data.length & 255), data)));
  return cat(latin("ID3"), Uint8Array.of(2, 0, 0), syncsafe(body.length), body);
}

test("files: videos and audio told apart by extension, else by their first bytes or MIME type", () => {
  assert.deepEqual(["a.mp4", "b.MOV", "c.m4v", "d.m4a", "e.M4B"].map((n) => mediaKind(n)), ["mp4", "mp4", "mp4", "mp4", "mp4"]);
  assert.deepEqual(["a.mp3", "b.AAC", "c.wav", "d.flac", "e.ogg", "f.oga", "g.opus"].map((n) => mediaKind(n)), Array(7).fill("audio"));
  assert.equal(mediaKind("slides.pdf"), null);
  assert.equal(mediaKind("voice", "", cat(be32(24), latin("ftypM4A "), be32(0))), "mp4", "an MP4 starts with an ftyp box");
  assert.equal(mediaKind("voice", "audio/mpeg", latin("ID3\x04\0\0\0\0\0\0\0\0")), "audio");
  assert.equal(mediaKind("clip", "video/quicktime"), "mp4");
  assert.equal(mediaKind("notes.json", "application/json"), null);
  assert.ok(MEDIA_FILE.test("x.mp3") && MEDIA_FILE.test("x.mp4") && !MEDIA_FILE.test("x.aac.txt"));
  assert.ok(AUDIO_FILE.test("x.m4a") && !AUDIO_FILE.test("x.mp4"));
  assert.equal(hashFingerprint("ab".repeat(32)), `fa1-${"ab".repeat(32)}`);
});

test("cover art: ID3v2.3 with unsynchronisation, an extended header and a UTF-16 description; the front cover first", () => {
  const tag = id3v23([
    ["TIT2", cat(Uint8Array.of(0), latin("A talk"))],
    ["APIC", apic(3, "image/jpeg", latin("not really"), latin("\0")), 0x80],   // compressed: skipped
    ["APIC", apic(0, "image/png", PNG)],
    ["APIC", apic(3, "image/jpeg", JPEG, utf16("Cover"))],
  ], { unsynced: true, extended: true });
  same(id3Artwork(tag), JPEG, "image/jpeg");
  same(id3Artwork(id3v23([["APIC", apic(0, "image/png", PNG)]])), PNG, "image/png");   // no front cover: the first one
  assert.equal(id3Artwork(id3v23([["TIT2", cat(Uint8Array.of(0), latin("No art"))]])), null);
  assert.equal(id3Artwork(latin("not a tag at all")), null);
});

test("cover art: ID3v2.4 frames unsynchronised with a data length indicator, and ID3v2.2 PIC", () => {
  same(id3Artwork(id3v24([["TIT2", cat(Uint8Array.of(3), latin("Talk"))], ["APIC", apic(3, "image/png", PNG)]])), PNG, "image/png");
  // 2.2: a three-letter format instead of a MIME type
  const pic = cat(Uint8Array.of(0), latin("JPG"), Uint8Array.of(3), latin("\0"), JPEG);
  same(id3Artwork(id3v22([["TT2", cat(Uint8Array.of(0), latin("Old"))], ["PIC", pic]])), JPEG, "image/jpeg");
});

test("cover art: FLAC PICTURE blocks (after an ID3 tag too), a WAV id3 chunk, and nothing in other files", async () => {
  const block = (type, data, last = false) => cat(Uint8Array.of((last ? 0x80 : 0) | type, data.length >> 16, (data.length >> 8) & 255, data.length & 255), data);
  const picture = (type, mime, image) => cat(be32(type), be32(mime.length), latin(mime), be32(4), latin("desc"), be32(64), be32(64), be32(24), be32(0),
    be32(image.length), image);
  const flac = cat(latin("fLaC"), block(0, new Uint8Array(34)), block(4, new Uint8Array(40)), block(6, picture(0, "image/png", PNG)),
    block(6, picture(3, "image/jpeg", JPEG), true), new Uint8Array(500));
  same(await audioArtwork(reader(flac), flac.length), JPEG, "image/jpeg");
  const tagged = cat(id3v23([["TIT2", cat(Uint8Array.of(0), latin("x"))]]), flac);
  same(await audioArtwork(reader(tagged), tagged.length), JPEG, "image/jpeg");

  const tag = id3v23([["APIC", apic(3, "image/png", PNG)]]);
  const chunk = (id, data) => cat(latin(id), le32(data.length), data, data.length & 1 ? Uint8Array.of(0) : new Uint8Array(0));
  const wav = cat(latin("RIFF"), le32(0), latin("WAVE"), chunk("fmt ", new Uint8Array(16)), chunk("data", new Uint8Array(1001)), chunk("id3 ", tag));
  same(await audioArtwork(reader(wav), wav.length), PNG, "image/png");

  const mp3 = cat(id3v23([["APIC", apic(3, "image/jpeg", JPEG)]]), Uint8Array.of(0xff, 0xfb, 0x90, 0x64), new Uint8Array(400));
  same(await audioArtwork(reader(mp3), mp3.length), JPEG, "image/jpeg");
  const plain = cat(Uint8Array.of(0xff, 0xfb, 0x90, 0x64), new Uint8Array(400));
  assert.equal(await audioArtwork(reader(plain), plain.length), null);
  assert.equal(await audioArtwork(reader(latin("OggS")), 4), null);
});

test("cover art: MP4 covr, in a full meta box (MP4) or a plain one (QuickTime)", () => {
  const box = (type, ...kids) => { const body = cat(...kids); return cat(be32(8 + body.length), latin(type), body); };
  const ilst = box("ilst", box("©nam", box("data", be32(1), be32(0), latin("Talk"))), box("covr", box("data", be32(14), be32(0), PNG)));
  const full = box("moov", box("mvhd", new Uint8Array(100)), box("udta", box("meta", be32(0), box("hdlr", new Uint8Array(25)), ilst)));
  same(mp4Artwork(full.subarray(8)), PNG, "image/png");
  const plain = box("moov", box("udta", box("meta", box("hdlr", new Uint8Array(25)), ilst)));
  same(mp4Artwork(plain.subarray(8)), PNG, "image/png");
  assert.equal(mp4Artwork(box("moov", box("mvhd", new Uint8Array(100))).subarray(8)), null);
});

test("paged reader: small reads joined into pages, the same bytes as direct reads", async () => {
  const buf = Uint8Array.from({ length: 10000 }, (_, i) => (i * 7) & 255);
  let calls = 0;
  const read = pagedReader(async (o, n) => { calls++; return buf.slice(o, o + n); }, buf.length, 1024);
  for (const [o, n] of [[0, 10], [5, 3000], [1020, 8], [9990, 50], [2048, 1024], [3000, 4000]]) {
    assert.deepEqual([...(await read(o, n))], [...buf.subarray(o, Math.min(buf.length, o + n))], `${o}+${n}`);
  }
  const before = calls;
  await read(1, 1000);
  assert.equal(calls, before, "kept pages aren't read again");
});

const FFMPEG = [process.env.FFMPEG, "/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg", "/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"]
  .find((f) => f && existsSync(f));
test("cover art from files made by ffmpeg: MP3 (ID3v2.3 and 2.4), M4A and FLAC with a picture, and without", { skip: !FFMPEG && "no ffmpeg (set FFMPEG)" }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "lk-media-test-"));
  try {
    const run = (...args) => execFileSync(FFMPEG, ["-v", "error", "-y", ...args], { cwd: dir });
    run("-f", "lavfi", "-i", "color=c=red:s=96x96", "-frames:v", "1", "cover.jpg");
    run("-f", "lavfi", "-i", "color=c=blue:s=80x80", "-frames:v", "1", "cover.png");
    run("-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-ac", "1", "tone.wav");
    const withPic = (image, out, ...codec) => run("-i", "tone.wav", "-i", image, "-map", "0", "-map", "1", ...codec, "-c:v", "copy",
      "-disposition:v", "attached_pic", "-metadata:s:v", "comment=Cover (front)", out);
    withPic("cover.jpg", "v23.mp3", "-c:a", "libmp3lame", "-id3v2_version", "3");
    withPic("cover.png", "v24.mp3", "-c:a", "libmp3lame", "-id3v2_version", "4");
    withPic("cover.jpg", "art.m4a", "-c:a", "aac");
    withPic("cover.png", "art.flac", "-c:a", "flac");
    run("-i", "tone.wav", "-c:a", "libmp3lame", "plain.mp3");
    run("-i", "tone.wav", "-c:a", "aac", "plain.m4a");
    const jpg = readFileSync(path.join(dir, "cover.jpg")), png = readFileSync(path.join(dir, "cover.png"));
    const artOf = async (name) => {
      const buf = new Uint8Array(readFileSync(path.join(dir, name)));
      if (mediaKind(name) === "audio") return { pic: await audioArtwork(reader(buf), buf.length) };
      const info = await readMp4Info(reader(buf), buf.length);
      return { pic: mp4Artwork(info.moov), video: info.tracks.some((t) => t.handler === "vide") };
    };
    same((await artOf("v23.mp3")).pic, jpg, "image/jpeg");
    same((await artOf("v24.mp3")).pic, png, "image/png");
    const m4a = await artOf("art.m4a");
    same(m4a.pic, jpg, "image/jpeg");
    assert.equal(m4a.video, false, "the picture isn't a video track: it plays as a recording");
    same((await artOf("art.flac")).pic, png, "image/png");
    assert.equal((await artOf("plain.mp3")).pic, null);
    assert.equal((await artOf("plain.m4a")).pic, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
