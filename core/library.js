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

/** Items by folder, the top level first: [{folder, items}]. */
export function groupByFolder(items) {
  const groups = new Map();
  for (const it of items) {
    if (!groups.has(it.folder)) groups.set(it.folder, []);
    groups.get(it.folder).push(it);
  }
  return [...groups].map(([folder, list]) => ({ folder, items: list }))
    .sort((a, b) => (a.folder === "" ? -1 : b.folder === "" ? 1 : byName(a.folder, b.folder)));
}

/** Items whose name or folder has every word of the query (case and accents ignored). */
export function searchLibrary(items, query) {
  const words = query.split(/\s+/).map(norm).filter(Boolean);
  if (!words.length) return items;
  return items.filter((it) => { const hay = norm(`${it.folder} ${it.name}`); return words.every((w) => hay.includes(w)); });
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
