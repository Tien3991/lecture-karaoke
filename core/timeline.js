// Subtitle timing ported from vertical_video_maker's build_events, plus fast lookup for playback.
import { mergeShort, splitSentences } from "./transcript.js";
import { contextFill, makePiece, splitGroup } from "./layout.js";

export const HOLD_MS = 1500;   // a piece stays this long after its last word unless the next one starts

/** Milliseconds (>= 0) to centiseconds, rounding half up, exactly as the pipeline does. */
const cs = (ms) => Math.floor((ms + 5) / 10);

/** Words -> pieces with lines and context, independent of timing offsets. */
export function buildPieces(words, m, opts) {
  const { groups } = mergeShort(splitSentences(words));
  const pieces = [];
  groups.forEach((g, gi) => {
    const parts = splitGroup(g, m, opts);
    parts.forEach((p, k) => pieces.push(makePiece(p, m, opts, gi, k, parts.length)));
  });
  let pos = 0;
  const flat = pieces.flatMap((p) => p.words);
  for (const p of pieces) {
    p.first = pos;
    pos += p.words.length;
    p.before = contextFill(flat, p.first, pos, "before", m, opts.ctxScale, opts);
    p.after = contextFill(flat, p.first, pos, "after", m, opts.ctxScale, opts);
  }
  return pieces;
}

/**
 * Pieces -> events. shiftMs moves Soniox's audio-relative times onto the video's clock (start
 * offset + sync fine-tune); leadMs makes everything happen earlier (clamped per word at 0).
 */
export function buildEvents(pieces, { leadMs = 0, durationMs, shiftMs = 0 }) {
  const events = [];
  const starts = pieces.map((p) => p.words[0].start + shiftMs);
  pieces.forEach((p, i) => {
    let end = Math.min(p.words[p.words.length - 1].end + shiftMs + HOLD_MS, durationMs);
    if (i + 1 < pieces.length) end = Math.min(end, starts[i + 1]);
    const shifted = p.words.map((w) => Math.max(0, w.start + shiftMs - leadMs));
    end -= leadMs;
    if (end <= 0) return;
    const wordCs = shifted.map(cs);
    for (let j = 1; j < wordCs.length; j++) wordCs[j] = Math.max(wordCs[j], wordCs[j - 1]);
    const lastEnd = cs(Math.max(0, p.words[p.words.length - 1].end + shiftMs - leadMs));
    events.push({
      piece: i, start_cs: wordCs[0], end_cs: Math.max(cs(end), wordCs[0] + 1), word_cs: wordCs,
      last_word_end_cs: Math.max(lastEnd, wordCs[wordCs.length - 1] + 1),
      words: p.words.map((w) => w.text),
      lines: p.lines.map((line) => line.map((k) => p.words[k].text).join(" ")),
      line_index: p.lines.flatMap((line, li) => line.map(() => li)),
      n_lines: p.lines.length, parts: p.parts, scale: p.scale,
      prev_lines: p.before.map((l) => l.text), next_lines: p.after.map((l) => l.text),
    });
  });
  return events;
}

/** Index of the event showing at time t (ms), or -1 during a pause. Events are sorted by start. */
export function activeEvent(events, tMs) {
  let lo = 0, hi = events.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid].start_cs * 10 <= tMs) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found >= 0 && tMs < events[found].end_cs * 10 ? found : -1;
}

/** How many words of an event are yellow at time t (ms). */
export function spokenCount(event, tMs) {
  let lo = 0, hi = event.word_cs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (event.word_cs[mid] * 10 <= tMs) lo = mid + 1; else hi = mid;
  }
  return lo;
}
