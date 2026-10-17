// Word fixes shared through GitHub. Each change made on a device is a delta, kept until GitHub has
// it: {start_ms, old, new} sets the fix of the word that started at start_ms with text old (new
// "" removes the word), and new null takes the fix away (undo). Deltas are applied to whatever
// list GitHub has at the time, so fixes made on two devices don't overwrite each other.

/** The fix list after applying deltas in order; sorted by time. */
export function applyDeltas(fixes, deltas) {
  let out = (fixes || []).slice();
  for (const d of deltas || []) {
    out = out.filter((f) => !(f.start_ms === d.start_ms && f.old === d.old));
    if (d.new !== null) out.push({ start_ms: d.start_ms, old: d.old, new: d.new });
  }
  return out.sort((a, b) => a.start_ms - b.start_ms || (a.old < b.old ? -1 : a.old > b.old ? 1 : 0));
}

/** The delta for a word edited to `text` (taking the fix away when text is the original). */
export function deltaFor(word, text) {
  const old = word.orig ?? word.text, t = text.trim();
  return { start_ms: word.start, old, new: t === old ? null : t };
}

export const sameFixes = (a, b) => JSON.stringify(applyDeltas(a, [])) === JSON.stringify(applyDeltas(b, []));
