// Word fixes made in the app. A fix is {start_ms, old, new}: the word's start time and its original
// text identify it, so fixes survive re-tokenisation. Exports use the formats the pipeline reads.
import { splitSentences } from "./transcript.js";

/** Apply fixes to the transcript's words; every word keeps its original text in `orig`. */
export function applyFixes(words, fixes = []) {
  const byKey = new Map(fixes.map((f) => [`${f.start_ms}|${f.old}`, f.new]));
  const out = [];
  for (const w of words) {
    const orig = w.orig ?? w.text;
    const key = `${w.start}|${orig}`;
    if (!byKey.has(key)) { out.push({ ...w, orig }); continue; }
    const text = byKey.get(key).trim();
    if (text) out.push({ ...w, orig, text });   // an empty fix deletes the word
  }
  return out;
}

/** Add or replace the fix for one word (identified by start time and original text). */
export function setFix(fixes = [], word, text) {
  const rest = fixes.filter((f) => !(f.start_ms === word.start && f.old === (word.orig ?? word.text)));
  return text.trim() === (word.orig ?? word.text) ? rest
    : [...rest, { start_ms: word.start, old: word.orig ?? word.text, new: text.trim() }];
}

/** Soniox-format JSON with one token per word (as vvm.py export-json writes it). */
export function exportTranscript(original, words, fixes, videoName) {
  const tokens = words.map((w, i) => ({
    text: (i ? " " : "") + w.text, start_ms: w.start, end_ms: w.end,
    confidence: Math.round((w.conf ?? 1) * 1e4) / 1e4,
  }));
  return {
    id: original.id, text: tokens.map((t) => t.text).join(""), tokens, video: videoName,
    exported_by: "lecture-karaoke",
    ...("pipeline_audio_offset_ms" in original ? { pipeline_audio_offset_ms: original.pipeline_audio_offset_ms } : {}),
    corrections: [...(original.corrections || []), ...fixes],
  };
}

/** One sentence per line: the pipeline's transcript.txt correction format. */
export const transcriptText = (words) =>
  splitSentences(words).map((s) => s.map((w) => w.text).join(" ")).join("\n") + "\n";
