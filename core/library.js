// The Dropbox library: the videos and audio recordings in the app's Dropbox folder, each with its
// entry in the transcripts repository's index.json, if any. Entries are matched by Dropbox's content hash
// (entry.dropbox.hash), then by name and size (entries made before Dropbox, or from a local file).
// Also the shape of index entries, shared with vertical_video_maker:
//   {key, name, folder, size, fingerprint, duration_ms, audio_start_ms, width, height,
//    dropbox: {path, hash} | null, staged: "/.staging/<fingerprint>.aac" | null, skip_ms,
//    transcript: "transcripts/<key>.json" | null, status: "ready" | "pending" | "failed",
//    error | null, id | null, words | null, updated}
// Pure functions: they run in the browser and in the Node tests.
import { norm } from "./transcript.js";
import { AUDIO_FILE, MEDIA_FILE } from "./media.js";

export const VIDEO_FILE = /\.(mp4|m4v|mov)$/i;   // (2.0.x scripts import it; files are told apart in core/media.js)
export const STAGING = "/.staging/";   // audio waiting to be transcribed (the job deletes it)

/** The course folder of a Dropbox path: "/CS224N/Lecture 12.mp4" -> "CS224N", "/a.mp4" -> "". */
export const folderOf = (path) => path.split("/").slice(1, -1).join("/");

// A folder whose name ends in ___ and a two-letter language code gives everything under it, subfolders
// too, that language ("Giải tích 1___vn", or ___vi, is Vietnamese); the nearest marked folder wins.
// The transcription job reads folder names the same way (vvm.py folder_language).
const LANGUAGE_ALIASES = { vn: "vi" };   // Vietnam's country code, as people write it

/** The language code a file's folders give it (a Dropbox path), or null: none (English). */
export function folderLanguage(path) {
  const folders = path.split("/").slice(0, -1);
  for (let i = folders.length - 1; i >= 0; i--) {
    const m = /___([A-Za-z]{2})$/.exec(folders[i]);
    if (m) return LANGUAGE_ALIASES[m[1].toLowerCase()] ?? m[1].toLowerCase();
  }
  return null;
}

/** A folder as shown, without its language marks: "Giải tích 1___vn/Chương 1" -> "Giải tích 1/Chương 1". */
export const shownFolder = (folder) => folder.replace(/___[A-Za-z]{2}(?=\/|$)/g, "");

/** ready, pending (being transcribed) or failed; null without an entry. An entry with a
 *  transcript is ready whatever its status says (entries made before statuses have none). */
export function entryStatus(entry) {
  if (!entry) return null;
  if (entry.transcript) return "ready";
  return entry.status === "failed" ? "failed" : "pending";
}

const byName = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

/** The listed videos and recordings (not the staging folder) with their index entries:
 *  [{name, path, folder, size, hash, entry, status, audio}], status as entryStatus; audio: an audio
 *  file, or an MP4 its entry knows to have no picture. */
export function mergeLibrary(files, videos) {
  const byHash = new Map(), bySize = new Map();
  for (const v of videos || []) {
    if (v.dropbox?.hash) { if (!byHash.has(v.dropbox.hash)) byHash.set(v.dropbox.hash, v); }
    else if (!bySize.has(`${v.name}\n${v.size}`)) bySize.set(`${v.name}\n${v.size}`, v);
  }
  return files
    .filter((f) => (f[".tag"] ?? "file") === "file" && MEDIA_FILE.test(f.name) && !f.path_lower.startsWith(STAGING))
    .map((f) => {
      const entry = byHash.get(f.content_hash) || bySize.get(`${f.name}\n${f.size}`) || null;
      return { name: f.name, path: f.path_display, folder: folderOf(f.path_display), size: f.size, hash: f.content_hash,
        entry, status: entryStatus(entry), audio: AUDIO_FILE.test(f.name) || entry?.width === 0 };
    })
    .sort((a, b) => byName(a.folder, b.folder) || byName(a.name, b.name));
}

/** Items by folder, the pinned folders (pinnedFolders) first, then the top level: [{folder, items, pinned}]. */
export function groupByFolder(items, pinned = new Set()) {
  const groups = new Map();
  for (const it of items) {
    if (!groups.has(it.folder)) groups.set(it.folder, []);
    groups.get(it.folder).push(it);
  }
  return [...groups].map(([folder, list]) => ({ folder, items: list, pinned: pinned.has(folder.toLowerCase()) }))
    .sort((a, b) => (b.pinned - a.pinned) || (a.folder === "" ? -1 : b.folder === "" ? 1 : byName(a.folder, b.folder)));
}

/** The lecture after `current` in its folder, in the library's order (by name, numbers in order),
 *  passing over those skip() says to; null after the last. items: mergeLibrary's list. */
export function nextInFolder(items, current, skip = () => false) {
  const i = items.findIndex((it) => it.path === current.path);
  if (i < 0) return null;
  for (const it of items.slice(i + 1)) {
    if (it.folder !== current.folder) return null;
    if (!skip(it)) return it;
  }
  return null;
}

/** A random lecture from now's folder other than now, passing over those skip() says to: one with a
 *  transcript when there are any, and among those one not in `played` (paths) while there are any;
 *  null when the folder has no other. */
export function randomInFolder(items, now, played = new Set(), skip = () => false, random = Math.random) {
  const others = items.filter((i) => i.folder === now.folder && i.path !== now.path && !skip(i));
  const ready = others.filter((i) => i.status === "ready"), pool = ready.length ? ready : others;
  const fresh = pool.filter((i) => !played.has(i.path));
  return randomPick(fresh.length ? fresh : pool, random);
}

/** A random item to play: a transcribed one when the folder has any. */
export function randomPick(items, random = Math.random) {
  const ready = items.filter((i) => i.status === "ready"), from = ready.length ? ready : items;
  return from.length ? from[Math.floor(random() * from.length)] : null;
}

// Files played on any device (the others are marked New): played.json in the repository, the same
// shape as hidden.json, {version: 1, files: {<Dropbox content hash>: {name, path, played}}}.
export const PLAYED_FILE = "played.json";
export const playedHashes = (data) => new Set(Object.keys(data?.files || {}));

/** played.json with these items played too, or undefined when they all were. */
export function withPlayed(data, items, now = isoNow()) {
  const files = { ...(data?.files || {}) };
  let changed = false;
  for (const it of items) {
    if (it.hash && !files[it.hash]) { files[it.hash] = { name: it.name, path: it.path, played: now }; changed = true; }
  }
  return changed ? { ...(data || {}), version: 1, files } : undefined;
}

// Folders pinned to the top of the library: pinned.json in the repository,
// {version: 1, folders: {<folder, in lower case>: {folder, pinned}}}.
export const PINNED_FILE = "pinned.json";
export const pinnedFolders = (data) => new Set(Object.keys(data?.folders || {}));

/** pinned.json with this folder pinned (pin) or not, or undefined when it already is so. */
export function withPinned(data, folder, pin, now = isoNow()) {
  const folders = { ...(data?.folders || {}) }, key = folder.toLowerCase();
  if (pin === !!folders[key]) return undefined;
  if (pin) folders[key] = { folder, pinned: now };
  else delete folders[key];
  return { ...(data || {}), version: 1, folders };
}

// Files hidden from the list (they stay in Dropbox): hidden.json in the repository, shared by the
// devices: {version: 1, files: {<Dropbox content hash>: {name, path, hidden}}}. Known by content, a
// file moved or renamed in Dropbox stays hidden. The transcription job doesn't read it.
export const HIDDEN_FILE = "hidden.json";

/** The content hashes hidden.json hides. */
export const hiddenHashes = (data) => new Set(Object.keys(data?.files || {}));

/** hidden.json with these items hidden (hide) or shown again, or undefined when nothing changes. */
export function withHidden(data, items, hide, now = isoNow()) {
  const files = { ...(data?.files || {}) };
  let changed = false;
  for (const it of items) {
    if (hide && !files[it.hash]) { files[it.hash] = { name: it.name, path: it.path, hidden: now }; changed = true; }
    else if (!hide && files[it.hash]) { delete files[it.hash]; changed = true; }
  }
  return changed ? { ...(data || {}), version: 1, files } : undefined;
}

/** Items whose name or folder (as shown) has every word of the query (case and accents ignored). */
export function searchLibrary(items, query) {
  const words = query.split(/\s+/).map(norm).filter(Boolean);
  if (!words.length) return items;
  return items.filter((it) => { const hay = norm(`${shownFolder(it.folder)} ${it.name}`); return words.every((w) => hay.includes(w)); });
}

/** The index key for a video: its entry's key if it has one, else the file's stem, made unique
 *  with part of the fingerprint when another video has it (as vertical_video_maker does). */
export function keyFor(name, fingerprint, videos) {
  const mine = (videos || []).find((v) => v.fingerprint === fingerprint);
  if (mine) return mine.key;
  const stem = name.replace(/\.[^.]+$/, "");
  return (videos || []).some((v) => v.key === stem) ? `${stem} (${fingerprint.slice(4, 12)})` : stem;
}

/** Now, as vertical_video_maker writes it: 2026-10-18T07:23:00+00:00. */
export const isoNow = () => new Date().toISOString().replace(/\.\d+Z$/, "+00:00");

/** An index entry with every field, in the shared order. */
export function indexEntry(e) {
  return {
    key: e.key, name: e.name, folder: e.folder ?? "", size: e.size, fingerprint: e.fingerprint,
    duration_ms: e.duration_ms ?? null, audio_start_ms: e.audio_start_ms ?? null, width: e.width ?? null, height: e.height ?? null,
    dropbox: e.dropbox ?? null, staged: e.staged ?? null, skip_ms: e.skip_ms ?? 0,
    transcript: e.transcript ?? null, status: e.status ?? (e.transcript ? "ready" : "pending"), error: e.error ?? null,
    id: e.id ?? null, words: e.words ?? null, updated: e.updated ?? isoNow(),
  };
}

/** An existing entry with some fields changed: every shared field, in order, and any others it has
 *  (fields added later by vertical_video_maker are kept). */
export const changedEntry = (entry, changes) => ({ ...indexEntry({ ...entry, ...changes }), ...entry, ...changes });

/** The index with this entry in place of any for the same video (by fingerprint), sorted by name. */
export function withEntry(index, entry) {
  const videos = (index?.videos || []).filter((v) => v.fingerprint !== entry.fingerprint);
  videos.push(entry);
  videos.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { version: 1, ...index, videos };
}
