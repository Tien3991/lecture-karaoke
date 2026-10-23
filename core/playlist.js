// Lectures one after another: those of a library folder, or a list picked by tag, and what the end
// mode button says to do when one ends. Pure functions: they run in the browser and in the Node tests.
import { groupByFolder } from "./library.js";

/** The end mode button's states, in the order taps go through them: stay; the next lecture once, then
 *  stay; the next one every time; a random one once; a random one every time. */
export const END_MODES = ["stay", "next1", "next", "shuffle1", "shuffle"];
export const nextEndMode = (mode) => END_MODES[(END_MODES.indexOf(mode) + 1) % END_MODES.length];
/** The mode after it has played a lecture: a once-only mode is spent. */
export const spentEndMode = (mode) => (mode === "next1" || mode === "shuffle1" ? "stay" : mode);

/** The item after (dir 1) or before (dir -1) `current` in the list, matched by path; null at either end. */
export function neighbor(list, current, dir) {
  const i = list.findIndex((it) => it.path === current?.path);
  return i < 0 ? null : list[i + dir] ?? null;
}

/** A random item of the list other than `now`: a transcribed one when there are any, and among those
 *  one not in `played` (paths) while any is left; null when the list has no other. */
export function randomOther(list, now, played = new Set(), random = Math.random) {
  const others = list.filter((i) => i.path !== now?.path);
  const ready = others.filter((i) => i.status === "ready"), pool = ready.length ? ready : others;
  const fresh = pool.filter((i) => !played.has(i.path)), from = fresh.length ? fresh : pool;
  return from.length ? from[Math.floor(random() * from.length)] : null;
}

/** The lectures of the folders tagged with any of `tags` (a Set, in lower case), in the library's
 *  order (pinned folders first, then by name; by name within a folder), without those leave() says
 *  to leave out; status "new" keeps only the new ones (isNew), "played" only the others. */
export function tagList(items, tagsByFolder, tags, { pinned = new Set(), status = "all", isNew = () => false, leave = () => false } = {}) {
  const tagged = (folder) => (tagsByFolder.get(folder.toLowerCase()) || []).some((t) => tags.has(t.toLowerCase()));
  return groupByFolder(items.filter((it) => tagged(it.folder)), pinned).flatMap((g) => g.items)
    .filter((it) => !leave(it) && (status === "new" ? isNew(it) : status === "played" ? !isNew(it) : true));
}
