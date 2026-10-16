// Transcript logic ported from vertical_video_maker's vvm.py, so the app shows exactly the
// subtitles the pipeline renders: Soniox tokens -> words -> sentences -> merged groups.
// Pure functions (no DOM): they run in the browser and in the Node tests.

export const ALNUM = /[\p{L}\p{N}]/u;
const OPENERS = new Set(["(", "[", "{", '"', "“", "‘", "¿", "¡", "'"]);
export const SENTENCE_END = /[.?!]+["'”’)\]]*$/u;
const ALWAYS_ABBREV = new Set(["mr.", "mrs.", "ms.", "dr.", "prof.", "st.", "vs.", "e.g.", "i.e.", "cf.",
  "approx.", "fig.", "eq."]);
const DOTTED = /^(?:(?:[a-z]{1,2}\.){2,}|[a-z]\.)$/;
export const PUNCT_BREAK = /[,;:.?!…—–-]["'”’)\]]*$/u;
export const CONJ_BY_LANGUAGE = {   // words a long sentence may be split before
  en: new Set(["and", "but", "or", "so", "because", "which", "that", "when", "if", "where", "while",
    "then", "although", "though", "since", "unless", "until", "whereas"]),
  vi: new Set(["và", "nhưng", "hoặc", "hay", "vì", "nên", "thì", "mà", "khi", "nếu", "để", "rằng", "tuy"]),
};
export const MERGE_MAX_WORDS = 2;      // sentences this short are joined to a neighbour...
export const MERGE_MAX_GAP_MS = 1000;  // ...when the pause between them is shorter than this

/** Lower-case word with accents kept, for conjunction lists. */
export const wordKey = (text) => text.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** Comparison form: lower case, letters and digits only, accents removed. */
export const norm = (text) => text.toLowerCase().replaceAll("đ", "d").normalize("NFKD")
  .replace(/\p{M}/gu, "").replace(/[^\p{L}\p{N}]+/gu, "");

/**
 * A token starting with whitespace begins a new word; other tokens continue the word. An unspaced
 * em dash ("that—well,") also separates words. Word times come from letter/digit fragments, so
 * punctuation (which Soniox gives 60 ms of its own) can't stretch a word.
 */
export function tokensToWords(tokens) {
  const groups = [];
  let newWord = true;
  for (const t of tokens) {
    for (const part of t.text.split(/(\s+|—)/u)) {
      if (!part) continue;
      if (/^\s+$/u.test(part)) {
        newWord = true;
      } else if (part === "—") {
        groups.push({ text: part, frags: [t] });
        newWord = true;
      } else if (newWord || groups.length === 0) {
        groups.push({ text: part, frags: [t] });
        newWord = false;
      } else {
        const g = groups[groups.length - 1];
        g.text += part;
        if (g.frags[g.frags.length - 1] !== t) g.frags.push(t);
      }
    }
  }
  return groups.map(({ text, frags }) => {
    let timed = frags.filter((f) => ALNUM.test(f.text));
    if (timed.length === 0) timed = frags;
    let start = Infinity, end = -Infinity, conf = Infinity;
    for (const f of timed) { start = Math.min(start, f.start_ms); end = Math.max(end, f.end_ms); }
    for (const f of frags) conf = Math.min(conf, Number(f.confidence ?? 1));
    return { text, start, end, conf };
  });
}

/** Punctuation-only "words" (dashes, stray quotes) ride along with a neighbour. */
export function attachPunctuation(words) {
  const out = [];
  let prefix = [];
  for (let w of words) {
    if (ALNUM.test(w.text)) {
      if (prefix.length) {
        w = { ...w, text: [...prefix, w.text].join(" ") };
        prefix = [];
      }
      out.push(w);
    } else if (out.length && !OPENERS.has(w.text[0])) {
      out[out.length - 1] = { ...out[out.length - 1], text: `${out[out.length - 1].text} ${w.text}` };
    } else {
      prefix.push(w.text);
    }
  }
  if (prefix.length && out.length) {
    out[out.length - 1] = { ...out[out.length - 1], text: `${out[out.length - 1].text} ${prefix.join(" ")}` };
  }
  return out;
}

/** Words from a Soniox transcript (raw or exported by export-json), NFC-normalised. */
export function wordsFromTranscript(data) {
  const tokens = data.tokens.map((t) => ({ ...t, text: String(t.text).normalize("NFC") }));
  const words = attachPunctuation(tokensToWords(tokens));
  for (let i = 1; i < words.length; i++) {
    if (words[i].start < words[i - 1].start) {
      words[i] = { ...words[i], start: words[i - 1].start, end: Math.max(words[i].end, words[i - 1].start) };
    }
  }
  return words;
}

export function isSentenceEnd(word, next) {
  if (!next) return true;
  if (!SENTENCE_END.test(word.text)) return false;
  const core = word.text.replace(/["'”’)\]]+$/u, "").toLowerCase();
  if (ALWAYS_ABBREV.has(core)) return false;
  if (DOTTED.test(core)) return /^\p{Lu}/u.test(next.text);   // U.S., Ph.D., single initials
  return true;
}

export function splitSentences(words) {
  const sentences = [];
  let cur = [];
  words.forEach((w, i) => {
    cur.push(w);
    if (isSentenceEnd(w, words[i + 1])) {
      sentences.push(cur);
      cur = [];
    }
  });
  if (cur.length) sentences.push(cur);
  return sentences;
}

/** Join one- or two-word sentences ("Okay.") to a neighbour so they don't flash by. */
export function mergeShort(sentences) {
  const groups = sentences.map((s) => [...s]);
  let merges = 0, i = 0;
  while (i < groups.length) {
    const g = groups[i];
    if (g.length <= MERGE_MAX_WORDS && groups.length > 1) {
      if (i + 1 < groups.length && groups[i + 1][0].start - g[g.length - 1].end < MERGE_MAX_GAP_MS) {
        groups[i + 1] = [...g, ...groups[i + 1]];
        groups.splice(i, 1);
        merges++;
        continue;
      }
      const prev = groups[i - 1];
      if (i > 0 && g[0].start - prev[prev.length - 1].end < MERGE_MAX_GAP_MS) {
        groups[i - 1] = [...prev, ...g];
        groups.splice(i, 1);
        merges++;
        continue;
      }
    }
    i++;
  }
  return { groups, merges };
}
