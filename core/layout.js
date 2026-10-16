// Subtitle layout ported from vertical_video_maker's vvm.py: split each sentence into the fewest
// pieces that fit MAX_LINES lines, break pieces into balanced lines, and fill the gray context lines.
// Widths come from a measurer {word(text), space}; any unit works as long as fitW uses the same one.
import { PUNCT_BREAK, SENTENCE_END, wordKey } from "./transcript.js";

export const MAX_LINES = 4;
export const MIN_PIECE_WORDS = 3;
export const CONTEXT_MAX_LINES = 3;

/** Cost of breaking before words[i]: punctuation < conjunction <= long pause < no pause. */
export function boundaryCost(words, i, conj) {
  if (i === 0) return 0;
  const prev = words[i - 1], nxt = words[i];
  const costs = [2.5 - Math.min(Math.max(nxt.start - prev.end, 0), 1500) / 1000];
  if (PUNCT_BREAK.test(prev.text)) costs.push(0);
  if (conj.has(wordKey(nxt.text))) costs.push(1);
  return Math.min(...costs);
}

/** Fewest pieces that each fit in maxLines lines; then the most natural breaks and even sizes. */
export function splitGroup(words, m, { fitW, conj, maxLines = MAX_LINES, minPieceWords = MIN_PIECE_WORDS }) {
  const n = words.length;
  const widths = words.map((w) => m.word(w.text));
  const pre = [0];
  for (const w of widths) pre.push(pre[pre.length - 1] + w);
  const maxJ = [];                       // words[i:j] fits for every j <= maxJ[i]
  for (let i = 0; i < n; i++) {
    let lines = 0, cur = null, j = i;
    while (j < n) {
      const w = widths[j];
      if (cur === null) { cur = w; lines = 1; }
      else if (cur + m.space + w <= fitW) cur += m.space + w;
      else { lines += 1; cur = w; }
      if (lines > maxLines) break;
      j++;
    }
    maxJ.push(j);
  }
  const cap = maxLines * fitW;
  const best = new Array(n + 1).fill(null);
  best[0] = [0, 0, -1];
  for (let j = 1; j <= n; j++) {
    for (let i = 0; i < j; i++) {
      if (best[i] === null || maxJ[i] < j) continue;
      const k = j - i;
      const fill = (pre[j] - pre[i] + m.space * (k - 1)) / cap;
      const cost = best[i][1] + boundaryCost(words, i, conj) + 2.0 * (1 - fill) ** 2
        + (k < minPieceWords && minPieceWords <= n ? 3.0 : 0.0);
      const b = best[j];
      if (b === null || best[i][0] + 1 < b[0] || (best[i][0] + 1 === b[0] && cost < b[1])) {
        best[j] = [best[i][0] + 1, cost, i];
      }
    }
  }
  const pieces = [];
  for (let j = n; j > 0;) {
    const i = best[j][2];
    pieces.push(words.slice(i, j));
    j = i;
  }
  return pieces.reverse();
}

/** Balanced lines (fewest lines, similar lengths), preferring breaks after punctuation. */
export function breakLines(texts, widths, space, maxW, conj) {
  const n = widths.length;
  let k = 0, cur = null;
  for (const w of widths) {
    if (cur === null) { cur = w; k = 1; }
    else if (cur + space + w <= maxW) cur += space + w;
    else { k += 1; cur = w; }
  }
  const pre = [0];
  for (const w of widths) pre.push(pre[pre.length - 1] + w);
  const dp = Array.from({ length: k + 1 }, () => new Array(n + 1).fill(Infinity));
  const back = Array.from({ length: k + 1 }, () => new Array(n + 1).fill(-1));
  dp[0][0] = 0;
  for (let line = 1; line <= k; line++) {
    for (let j = 1; j <= n; j++) {
      for (let i = j - 1; i >= 0; i--) {
        const w = pre[j] - pre[i] + space * (j - i - 1);
        if (w > maxW && j - i > 1) break;
        if (dp[line - 1][i] === Infinity) continue;
        let c = dp[line - 1][i] + Math.max(0, (maxW - w) / maxW) ** 2;
        if (j < n && PUNCT_BREAK.test(texts[j - 1])) c -= 0.05;
        if (j < n && conj.has(wordKey(texts[j]))) c -= 0.02;
        if (c < dp[line][j]) { dp[line][j] = c; back[line][j] = i; }
      }
    }
  }
  if (dp[k][n] === Infinity) return [range(0, n)];
  const lines = [];
  for (let line = k, j = n; line > 0; line--) {
    const i = back[line][j];
    lines.push(range(i, j));
    j = i;
  }
  return lines.reverse();
}

const range = (a, b) => Array.from({ length: b - a }, (_, i) => a + i);

/** A piece: its words broken into lines; scale < 1 only when one word is wider than a line. */
export function makePiece(words, m, { fitW, conj }, group, part, parts) {
  const widths = words.map((w) => m.word(w.text));
  const scale = Math.min(1.0, fitW / Math.max(...widths));
  const lines = breakLines(words.map((w) => w.text), widths.map((w) => w * scale), m.space * scale, fitW, conj);
  return { words, lines, group, part, parts, scale };
}

/**
 * As much neighbouring text as fits in CONTEXT_MAX_LINES lines at the context size: before =
 * the words just before `start` (what was just said), after = the words from `end` on (what is
 * coming). "…" marks a mid-sentence cut. Returns lines as {text, idx: [word indices]}.
 */
export function contextFill(words, start, end, which, m, scale, { fitW, conj }) {
  const fits = (texts) => {
    let lines = 0, cur = null;
    for (const t of texts) {
      const x = m.word(t) * scale;
      if (cur === null) { cur = x; lines = 1; }
      else if (cur + m.space * scale + x <= fitW) cur += m.space * scale + x;
      else { lines += 1; cur = x; }
    }
    return lines <= CONTEXT_MAX_LINES;
  };
  const shown = (a, b) => {
    const texts = words.slice(a, b).map((w) => w.text);
    if (which === "before" && a > 0 && !SENTENCE_END.test(words[a - 1].text)) texts[0] = "…" + texts[0];
    if (which === "after" && !SENTENCE_END.test(words[b - 1].text)) {
      texts[texts.length - 1] = texts[texts.length - 1].replace(/[,;:—–\- ]+$/u, "") + "…";
    }
    return texts;
  };
  let best = null, from = 0;
  if (which === "before") {
    for (let a = start - 1; a > Math.max(-1, start - 120); a--) {
      const t = shown(a, start);
      if (!fits(t)) break;
      best = t; from = a;
    }
  } else {
    for (let b = end + 1; b <= Math.min(words.length, end + 120); b++) {
      const t = shown(end, b);
      if (!fits(t)) break;
      best = t; from = end;
    }
  }
  if (!best) return [];
  const lines = breakLines(best, best.map((t) => m.word(t) * scale), m.space * scale, fitW, conj);
  return lines.map((line) => ({
    text: line.map((k) => best[k]).join(" "),
    texts: line.map((k) => best[k]),           // per word, as shown ("…" included)
    idx: line.map((k) => from + k),            // word indices, for tap-to-jump
  }));
}
