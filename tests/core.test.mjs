// Port-fidelity tests: the JS core must reproduce the vertical_video_maker pipeline exactly.
// Fixtures (transcripts, widths, events) are made by dev/make_fixtures.py and live OUTSIDE the
// repository; set FIXTURES=/path/to/app_test_fixtures/ to point elsewhere. Run: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { CONJ_BY_LANGUAGE, attachPunctuation, isSentenceEnd, tokensToWords, wordsFromTranscript } from "../core/transcript.js";
import { activeEvent, buildEvents, buildPieces, spokenCount } from "../core/timeline.js";
import { readMp4Info } from "../core/mp4.js";
import { applyFixes, exportTranscript, setFix, transcriptText } from "../core/corrections.js";

const FIX = process.env.FIXTURES || new URL("../../app_test_fixtures/", import.meta.url).pathname;
const stems = existsSync(FIX + "index.json") ? JSON.parse(readFileSync(FIX + "index.json", "utf8")) : [];
const fixture = (stem) => JSON.parse(readFileSync(FIX + stem + ".json", "utf8"));
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
// words.tsv is tab-separated and unquoted (words can contain quote marks): split by hand.
const tsvWords = (path) => readFileSync(path, "utf8").split("\n").slice(1).filter(Boolean)
  .map((line) => { const f = line.split("\t"); return [f.slice(3).join("\t"), Number(f[0]), Number(f[1])]; });
const triples = (words) => words.map((w) => [w.text, w.start, w.end]);

test("fixtures are present", { skip: stems.length === 0 && "no fixtures (run dev/make_fixtures.py)" }, () => {
  assert.equal(stems.length, 23);
});

test("raw Soniox JSON -> words equals the pipeline's words.tsv (uncorrected lectures)", () => {
  for (const stem of stems) {
    const fx = fixture(stem);
    if (fx.corrected) continue;
    assert.deepEqual(triples(wordsFromTranscript(json(fx.raw_json))), tsvWords(fx.words_tsv), stem);
  }
});

test("exported app JSON -> words equals words.tsv (all lectures, corrections included)", () => {
  for (const stem of stems) {
    const fx = fixture(stem);
    assert.deepEqual(triples(wordsFromTranscript(json(fx.app_json))), tsvWords(fx.words_tsv), stem);
  }
});

test("pieces, lines, context and every time match the pipeline's events exactly", () => {
  for (const stem of stems) {
    const fx = fixture(stem);
    const m = {
      space: fx.space,
      word: (t) => {
        const w = fx.widths[t];
        if (w === undefined) throw new Error(`${stem}: the pipeline never measured ${JSON.stringify(t)}`);
        return w;
      },
    };
    const words = fx.words.map(([text, start, end]) => ({ text, start, end }));
    const pieces = buildPieces(words, m, { fitW: fx.fit_w, conj: CONJ_BY_LANGUAGE.en, ctxScale: fx.ctx_scale });
    for (const [version, leadMs] of [["exact", 0], ["lead_3s", 3000]]) {
      const events = buildEvents(pieces, { leadMs, durationMs: fx.duration_ms, shiftMs: fx.shift_ms });
      assert.equal(events.length, fx.events[version].length, `${stem} ${version}: event count`);
      events.forEach((e, i) => assert.deepEqual(e, fx.events[version][i], `${stem} ${version}: event ${i}`));
    }
  }
});

test("lookup of the showing piece and its yellow words matches a plain scan", () => {
  let seed = 12345;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  for (const stem of stems) {
    const fx = fixture(stem);
    for (const version of ["exact", "lead_3s"]) {
      const events = fx.events[version];
      for (let n = 0; n < 1000; n++) {
        const t = Math.floor(rand() * fx.duration_ms);
        const want = events.findIndex((e) => e.start_cs * 10 <= t && t < e.end_cs * 10);
        assert.equal(activeEvent(events, t), want, `${stem} ${version} t=${t}`);
        if (want >= 0) {
          assert.equal(spokenCount(events[want], t), events[want].word_cs.filter((c) => c * 10 <= t).length);
        }
      }
    }
  }
});

test("MP4 reader: the audio start offset equals the pipeline's (ffprobe) for every video", async () => {
  for (const stem of stems) {
    const fx = fixture(stem);
    const fh = await open(fx.video);
    try {
      const { size } = await fh.stat();
      const read = async (offset, length) => {
        const b = Buffer.alloc(length);
        await fh.read(b, 0, length, offset);
        return new Uint8Array(b.buffer, b.byteOffset, length);
      };
      const info = await readMp4Info(read, size);
      assert.equal(Math.round(info.audioStartSec * 1000), Math.round(fx.audio_start * 1000), `${stem}: audio start`);
      assert.equal(Math.round(info.audioStartSec * 1000), fx.shift_ms, `${stem}: offset used by the pipeline`);
      assert.deepEqual([info.width, info.height], [fx.width, fx.height], `${stem}: size`);
    } finally {
      await fh.close();
    }
  }
});

test("porting pitfalls: Unicode letters, anchored abbreviations, em dash, timing from letters", () => {
  const tok = (text, s, e) => ({ text, start_ms: s, end_ms: e, confidence: 0.9 });
  const words = attachPunctuation(tokensToWords([
    tok("Tiếng", 0, 100), tok(" Việt", 100, 200), tok(",", 200, 260), tok(" đ", 300, 340), tok("ẹp", 340, 400),
    tok(" that", 500, 600), tok("—", 600, 600), tok("w", 600, 650), tok("ell", 650, 700), tok(" U", 800, 820),
    tok(".", 820, 880), tok("S", 880, 900), tok(".", 900, 960), tok(" economy", 1000, 1200), tok(".", 1200, 1260),
  ]));
  assert.deepEqual(words.map((w) => w.text), ["Tiếng", "Việt,", "đẹp", "that —", "well", "U.S.", "economy."]);
  assert.equal(words[1].end, 200, "punctuation must not stretch a word");
  assert.equal(isSentenceEnd(words[5], words[6]), false, "U.S. followed by a lower-case word");
  assert.equal(isSentenceEnd({ text: "Plus." }, { text: "and" }), true, "DOTTED must be anchored");
});

test("word fixes: change, delete, re-edit, undo; the exported JSON reopens with the fixes", () => {
  const tok = (text, s, e) => ({ text, start_ms: s, end_ms: e, confidence: 0.9 });
  const original = { id: "t1", pipeline_audio_offset_ms: 33, corrections: [{ start_ms: 0, old: "Helo", new: "Hello" }],
    tokens: [tok("Hello", 0, 200), tok(" wrold", 200, 400), tok(".", 400, 450), tok(" Um", 600, 700), tok(" okay", 700, 900), tok(".", 900, 950)] };
  const base = wordsFromTranscript(original);
  let fixes = setFix([], base[1], "world.");
  fixes = setFix(fixes, base[2], "");                       // an empty fix removes the word
  let words = applyFixes(base, fixes);
  assert.deepEqual(words.map((w) => w.text), ["Hello", "world.", "okay."]);
  assert.equal(words[1].orig, "wrold.", "a fixed word remembers its original text");
  fixes = setFix(fixes, words[1], "World.");                // editing again replaces the fix
  assert.equal(fixes.length, 2);
  assert.equal(setFix(fixes, words[1], "wrold.").length, 1, "typing the original text back undoes the fix");
  words = applyFixes(base, fixes);
  const exported = JSON.parse(JSON.stringify(exportTranscript(original, words, fixes, "v.mp4")));
  assert.deepEqual(triples(wordsFromTranscript(exported)), triples(words), "export -> reopen keeps every fix and time");
  assert.equal(exported.id, "t1");
  assert.equal(exported.video, "v.mp4");
  assert.equal(exported.pipeline_audio_offset_ms, 33);
  assert.equal(exported.corrections.length, 3, "earlier corrections plus the app's fixes");
  assert.equal(transcriptText(words), "Hello World.\nokay.\n");
});
