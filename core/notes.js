// Notes on a lecture, shared through GitHub like word fixes (core/sync.js): notes/<key>.json holds
// {video, notes: [{id, at_ms, text, created, updated, deleted?}]}, at_ms being the place in the
// video. Each change made on a device is the note's new state, kept until GitHub has it and applied
// to whatever GitHub has then: of two changes to one note the later one wins, and a deleted note
// stays as a marker, so an older copy sent by a device that hasn't heard of the deletion can't
// bring it back.
// Pure functions: they run in the browser and in the Node tests.

/** A new note's id: unique enough across devices (time and randomness). */
export const newNoteId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** The notes after applying changes in order: per id, the one updated last wins. Oldest first. */
export function applyNoteChanges(notes, changes) {
  const byId = new Map((notes || []).map((n) => [n.id, n]));
  for (const c of changes || []) {
    const cur = byId.get(c.id);
    if (!cur || (c.updated || "") >= (cur.updated || "")) byId.set(c.id, c);
  }
  return [...byId.values()].sort(byCreated);
}

/** When a change to a note last changed at `prev` happened: now, or just after prev when this
 *  device's clock is behind it, so the change still wins over the note it was made to. */
export function noteStamp(prev, now = new Date().toISOString()) {
  return !prev || now > prev ? now : new Date(Date.parse(prev) + 1).toISOString();
}

/** The notes to show: not deleted, the newest first. */
export const shownNotes = (notes) => (notes || []).filter((n) => !n.deleted).sort((a, b) => byCreated(b, a));

const byCreated = (a, b) => (a.created < b.created ? -1 : a.created > b.created ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
