// Lectures one after another: those of a library folder, or a list picked by tag, and what the end
// mode button says to do when one ends. Pure functions: they run in the browser and in the Node tests.
import { groupByFolder } from "./library.js";

/** The end mode button's states, in the order taps go through them: stop after the lecture; the next
 *  one, up to the last; a random one, until each has played once. */
export const END_MODES = ["stay", "next", "shuffle"];
export const nextEndMode = (mode) => END_MODES[(END_MODES.indexOf(mode) + 1) % END_MODES.length];

/** The item after (dir 1) or before (dir -1) `current` in the list, matched by path; null at either end. */
export function neighbor(list, current, dir) {
  const i = list.findIndex((it) => it.path === current?.path);
  return i < 0 ? null : list[i + dir] ?? null;
}

/** A random item of the list other than `now` and not in `played` (paths): a transcribed one while any
 *  is left; null once every other one has played. */
export function randomOther(list, now, played = new Set(), random = Math.random) {
  const fresh = list.filter((i) => i.path !== now?.path && !played.has(i.path));
  const ready = fresh.filter((i) => i.status === "ready"), from = ready.length ? ready : fresh;
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
