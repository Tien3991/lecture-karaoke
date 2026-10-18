// The audio copy used by "Transcribe only" (core/audio.js): an MP4's AAC frames in an ADTS stream.
// Checked by decoding with ffmpeg: the ADTS stream must give exactly the samples ffmpeg decodes
// from the MP4 itself, once skip_ms is dropped. Uses Lecture 12 from the parent folder (set
// LECTURE12 to point elsewhere) and ffmpeg (FFMPEG, FFPROBE); skipped when they are missing.
// Clips are made in a temporary folder, never in the repository.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readMp4Info } from "../core/mp4.js";
import { CANT_COPY, extractAdts } from "../core/audio.js";

const FFMPEG = process.env.FFMPEG || "/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg";
const FFPROBE = process.env.FFPROBE || "/opt/homebrew/opt/ffmpeg-full/bin/ffprobe";
const LECTURE12 = process.env.LECTURE12
  || fileURLToPath(new URL("../../Stanford CS224N NLP w DL Spring 2024 Lecture 12 - Efficient Trai.mp4", import.meta.url));
const missing = !existsSync(FFMPEG) || !existsSync(FFPROBE) ? "no ffmpeg (set FFMPEG and FFPROBE)"
  : !existsSync(LECTURE12) ? "Lecture 12 isn't there (set LECTURE12)" : false;

async function copyAudio(file) {
  const fh = await open(file);
  try {
    const { size } = await fh.stat();
    const read = async (offset, length) => {
      const b = Buffer.alloc(length);
      const { bytesRead } = await fh.read(b, 0, length, offset);
      return new Uint8Array(b.buffer, b.byteOffset, bytesRead);
    };
    const info = await readMp4Info(read, size);
    return { info, ...(await extractAdts(read, info)) };
  } finally {
    await fh.close();
  }
}
const probeAudio = (file) => JSON.parse(execFileSync(FFPROBE, ["-v", "error", "-select_streams", "a:0", "-show_entries",
  "stream=nb_frames,duration_ts,sample_rate,time_base,channels", "-of", "json", file])).streams[0];

/** Decodes two files' first audio streams with ffmpeg (16-bit, every channel) and compares them
 *  sample by sample as they stream, dropping skipA samples from the start of a's. */
async function comparePcm(a, b, skipA, channels) {
  const frameBytes = 2 * channels;
  const decode = (file) => spawn(FFMPEG, ["-v", "error", "-i", file, "-map", "0:a:0", "-f", "s16le", "-acodec", "pcm_s16le", "-"],
    { stdio: ["ignore", "pipe", "inherit"] }).stdout[Symbol.asyncIterator]();
  const sides = [{ it: decode(a), buf: Buffer.alloc(0), total: 0, skip: skipA * frameBytes, done: false },
    { it: decode(b), buf: Buffer.alloc(0), total: 0, skip: 0, done: false }];
  let compared = 0, diffs = 0, maxDiff = 0;
  for (;;) {
    for (const s of sides) {
      while (!s.done && s.buf.length < 1 << 20) {
        const r = await s.it.next();
        if (r.done) { s.done = true; break; }
        let c = r.value;
        s.total += c.length;
        if (s.skip) { const k = Math.min(s.skip, c.length); c = c.subarray(k); s.skip -= k; }
        s.buf = s.buf.length ? Buffer.concat([s.buf, c]) : c;
      }
    }
    const n = Math.min(sides[0].buf.length, sides[1].buf.length) & ~(frameBytes - 1);
    if (!n) break;
    const x = sides[0].buf, y = sides[1].buf;
    for (let i = 0; i < n; i += 2) {
      const d = Math.abs(x.readInt16LE(i) - y.readInt16LE(i));
      if (d) { diffs++; if (d > maxDiff) maxDiff = d; }
    }
    compared += n;
    sides[0].buf = x.subarray(n);
    sides[1].buf = y.subarray(n);
  }
  return { samplesA: sides[0].total / frameBytes, samplesB: sides[1].total / frameBytes, compared: compared / frameBytes,
    values: compared / 2, diffs, maxDiff };
}

test("ADTS copy of Lecture 12: same frames, samples and duration as its audio track, and the same PCM",
  { skip: missing }, async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "lk-adts-"));
    try {
      const { blob, skipMs, frames, info } = await copyAudio(LECTURE12);
      const aac = path.join(tmp, "lecture12.aac");
      writeFileSync(aac, Buffer.from(await blob.arrayBuffer()));
      const track = probeAudio(LECTURE12), rate = Number(track.sample_rate);
      assert.equal(frames, Number(track.nb_frames), "one ADTS frame per AAC frame of the track");
      assert.equal(skipMs, Math.round(info.audioSkipSec * 1000));
      const skip = Math.round(info.audioSkipSec * rate);
      const r = await comparePcm(aac, LECTURE12, skip, track.channels);
      assert.equal(r.samplesA, frames * 1024, "1024 samples per frame");
      assert.equal(r.samplesA, Number(track.duration_ts), "the ADTS stream lasts exactly as long as the track's samples");
      assert.equal(r.samplesA / rate, Number(track.duration_ts) / rate);
      assert.ok(r.compared >= r.samplesB - 4096 && r.compared > 0.99 * r.samplesA, `compared ${r.compared} of ${r.samplesB} samples`);
      assert.ok(r.maxDiff <= 2 && r.diffs <= Math.max(32, r.values * 1e-5), `PCM differs: ${r.diffs} values, at most ${r.maxDiff}`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

test("ADTS copy: an edit list's media time becomes skip_ms; audio that isn't AAC is refused", { skip: missing }, async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "lk-adts-"));
  try {
    // ffmpeg's own AAC encoder puts its 1024 samples of priming in the edit list (media time 1024)
    const clip = path.join(tmp, "primed.mp4"), aac = path.join(tmp, "primed.aac");
    execFileSync(FFMPEG, ["-v", "error", "-ss", "600", "-i", LECTURE12, "-t", "6", "-map", "0:a:0", "-c:a", "aac", "-b:a", "96k", clip]);
    const { blob, skipMs, info } = await copyAudio(clip);
    writeFileSync(aac, Buffer.from(await blob.arrayBuffer()));
    const track = probeAudio(clip), skip = Math.round(info.audioSkipSec * Number(track.sample_rate));
    assert.equal(skip, 1024);
    assert.equal(skipMs, 23, "1024 samples at 44.1 kHz");
    const r = await comparePcm(aac, clip, skip, track.channels);
    assert.equal(r.compared, r.samplesB, "every sample of the MP4's decode is in the ADTS stream after skip_ms");
    assert.ok(r.maxDiff <= 2 && r.diffs <= Math.max(32, r.values * 1e-5), `PCM differs: ${r.diffs} values, at most ${r.maxDiff}`);
    for (const codec of ["ac3", "libmp3lame"]) {
      const other = path.join(tmp, `${codec}.mp4`);
      execFileSync(FFMPEG, ["-v", "error", "-i", clip, "-c:a", codec, other]);
      await assert.rejects(copyAudio(other), { message: CANT_COPY }, codec);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
