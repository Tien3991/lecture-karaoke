// Lecture Karaoke: plays a lecture video or audio recording, from this device or from Dropbox, with
// live karaoke subtitles from its Soniox transcript. The subtitle rules are the vertical_video_maker
// pipeline's (ported in core/). A recording shows its cover art, or bars that move with the sound.
// Lectures without a transcript get one from the transcription job in GitHub Actions, which reads
// them (or just a video's audio) from Dropbox.
import { CONJ_BY_LANGUAGE, wordsFromTranscript } from "./core/transcript.js";
import { activeEvent, buildEvents, buildPieces, spokenCount } from "./core/timeline.js";
import { blobReader, readMp4Info, videoFingerprint } from "./core/mp4.js";
import { AUDIO_FILE, MEDIA_FILE, audioArtwork, hashFingerprint, mediaKind, mp4Artwork, pagedReader } from "./core/media.js";
import { Visualizer } from "./core/visualizer.js";
import { applyFixes, exportTranscript, transcriptText } from "./core/corrections.js";
import { GitHub } from "./core/github.js";
import { Dropbox, LINK_MS, contentHash } from "./core/dropbox.js";
import { extractAdts } from "./core/audio.js";
import { HIDDEN_FILE, PINNED_FILE, PLAYED_FILE, STAGING, TAGS_FILE, UNIMPORTANT_FILE, allTags, changedEntry, cleanTags, entryStatus,
  folderLanguage, folderOf, folderTags, groupByFolder, hiddenHashes, indexEntry, isoNow, keyFor, mergeLibrary, pinnedFolders, playedHashes,
  randomPick, searchLibrary, shownFolder, unimportantHashes, withEntry, withHidden, withPinned, withPlayed, withTags,
  withUnimportant } from "./core/library.js";
import { neighbor, nextEndMode, randomOther, tagList } from "./core/playlist.js";
import { applyDeltas, deltaFor, sameFixes } from "./core/sync.js";
import { applyNoteChanges, newNoteId, noteStamp, shownNotes } from "./core/notes.js";
import * as store from "./core/store.js";
import { zipFiles } from "./core/zip.js";

const VERSION = "3.8.0";
// Proportions of the burned vertical video (identical in every pipeline calibration), in em of
// the main subtitle text: line limit, frame width, and the height the three blocks need.
const FIT_EM = 892.4 / 67.797, FRAME_EM = 1080 / 67.797, PANEL_EM = 14.4, CTX_SCALE = 74 / 93;
const FONT = '700 100px "LK Sans"';
const RATE_MIN = 0.2, RATE_MAX = 4;
const RATE_PRESETS = [0.2, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 3.5, 4];
const OFFSET_MAX_MS = 15000;
// How much of the screen the video may take: of the height in portrait, of the width in landscape.
const SPLIT_RANGE = { portrait: [0.15, 0.85], landscape: [0.25, 0.8] };
const isFirefox = /Firefox\//.test(navigator.userAgent);
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isMobile = isIOS || /Android/i.test(navigator.userAgent);
const dev = ["localhost", "127.0.0.1"].includes(location.hostname);
/** Development only: ?api=/mock-github and ?dropbox=/mock-dropbox point the app at dev/serve.mjs's
 *  stand-ins for GitHub and Dropbox. */
const devParam = (name) => (dev ? new URLSearchParams(location.search).get(name) : null);
const devUrl = (name) => { const u = devParam(name); return u ? new URL(u, location.href).href.replace(/\/$/, "") : undefined; };
const devApi = () => devUrl("api");
// A video waiting for its transcript checks the index every 20 s; a Dropbox link (4 hours) is
// renewed 15 minutes before it ends. Development: ?poll= and ?linkAge= in seconds.
const POLL_MS = (Number(devParam("poll")) || 20) * 1000;
const LINK_RENEW_MS = (Number(devParam("linkAge")) * 1000) || LINK_MS - 15 * 60 * 1000;

// The page and this script must be the same release. A service-worker update could briefly pair
// them across releases (the page fresh, the script cached): reload once to get a matching pair.
const pageVersion = document.querySelector('meta[name="app-version"]')?.content;
try {
  if (pageVersion && pageVersion !== VERSION && !sessionStorage.getItem("lecture-karaoke.reloaded")) {
    sessionStorage.setItem("lecture-karaoke.reloaded", "1");
    location.reload();
  } else if (pageVersion === VERSION) sessionStorage.removeItem("lecture-karaoke.reloaded");
} catch { /* storage unavailable: carry on */ }

const $ = (id) => document.getElementById(id);
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const video = $("video"), videoBox = video.parentElement, panel = $("panel"), player = $("player"), bar = document.querySelector(".bar");
const S = {
  videoFile: null, jsonFile: null, picked: null, wanted: null, videoUrl: null, videoName: "", transcript: null,
  id: null, rec: {}, repoKey: null, baseWords: [], words: [], pieces: [], events: [], durationMs: 0, audioOffsetMs: 0,
  leadMs: 0, syncMs: 0, language: "en", editing: false, shown: -2, spoken: -1, lastSecond: -1,
  playing: false,    // the viewer's play/pause, kept while a Dropbox link is renewed (swapping) and while
                     // iPhone pauses the video for the background (the sound goes on: playHidden)
  swapping: false, handing: false, startAt: 0,
};

// ---------------------------------------------------------------- viewer preferences
// Kept on this device for every lecture: speed (and each Dropbox folder's own, folderRates, by the
// folder in lower case), the timing offset and whether it is on, the video/subtitle split for each
// orientation, the highlight (its color, the soft setting and whether it is on), the last Play by tag
// choice (tagPick) and sleep timer (sleepMin), how dark the touch lock makes the screen (lockDim), and
// after how many plays to the end (hideAfter, 0: never) in how many days (hideWithin, 0: at any time) a
// lecture leaves the list. (Position, sync, language and fixes are kept per transcript in IndexedDB.)
// The key carries the app prefix: all Pages projects share one origin.
const PREFS_KEY = "lecture-karaoke.prefs";
// Highlight presets, readable on black; yellow is the burned videos' color.
const HI_COLORS = [["Yellow", "#ffe000"], ["Orange", "#fb923c"], ["Green", "#4ade80"], ["Blue", "#38bdf8"], ["Pink", "#f472b6"],
  ["Violet", "#a78bfa"]];
// The soft highlight keeps this % of the color, the rest the white of the words to come.
const HI_SOFT_RANGE = [20, 90], HI_SOFT_DEFAULT = 40;
const prefs = { rate: 1, folderRates: {}, offsetMs: 3000, offsetOn: false, split: { portrait: null, landscape: null }, bar: null,
  uploadFolder: "Uploads", hi: { color: HI_COLORS[0][1], soft: false, strength: HI_SOFT_DEFAULT }, lockDim: 0, hideAfter: 0, hideWithin: 7, speedPair: [1, 2] };
try {
  const saved = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
  Object.assign(prefs, saved, { split: { ...prefs.split, ...saved.split } });
  const oldRate = Number(localStorage.getItem("lecture-karaoke.rate"));   // 1.0.1 kept only the speed
  if (oldRate && !("rate" in saved)) prefs.rate = oldRate;
} catch { /* storage unavailable: defaults */ }
prefs.rate = clamp(Number(prefs.rate) || 1, RATE_MIN, RATE_MAX);
prefs.folderRates = Object.fromEntries(Object.entries(Object(prefs.folderRates))
  .filter(([, r]) => Number.isFinite(r) && r >= RATE_MIN && r <= RATE_MAX));
delete prefs.autoNext;   // 2.9.0's "play the next one by itself"
delete prefs.endMode;       // until 2.15.0 the end mode was kept; now leaving the player sets it back
delete prefs.lockButtons;   // 2.12.0 to 2.14.0's choice of lock screen buttons
delete prefs.seamless;      // 2.13.0 to 2.15.0's second stream
prefs.lockDim = clamp(Number(prefs.lockDim) || 0, 0, 1);
{
  const pair = Array.isArray(prefs.speedPair) ? prefs.speedPair.map(Number) : [];
  prefs.speedPair = [0, 1].map((i) => (Number.isFinite(pair[i]) ? Math.round(clamp(pair[i], RATE_MIN, RATE_MAX) * 100) / 100 : [1, 2][i]));
}
prefs.hideAfter = clamp(Math.round(Number(prefs.hideAfter) || 0), 0, 99);
prefs.hideWithin = Number.isFinite(Number(prefs.hideWithin)) ? clamp(Math.round(Number(prefs.hideWithin)), 0, 365) : 7;
prefs.offsetMs = Number.isFinite(Number(prefs.offsetMs)) ? clamp(Number(prefs.offsetMs), -OFFSET_MAX_MS, OFFSET_MAX_MS) : 3000;
prefs.offsetOn = prefs.offsetOn === true;
for (const o of ["portrait", "landscape"]) if (!Number.isFinite(prefs.split[o])) prefs.split[o] = null;
{
  // 2.2.0 kept only a strength, 100 meaning full color: below that, the soft highlight was on.
  const { color, soft, strength } = prefs.hi ?? {}, level = Math.round(Number(strength) / 5) * 5;
  prefs.hi = { color: /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : HI_COLORS[0][1],
    soft: typeof soft === "boolean" ? soft : level > 0 && level < 100,
    strength: level > 0 && level < 100 ? clamp(level, ...HI_SOFT_RANGE) : HI_SOFT_DEFAULT };
}
function savePrefs() {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* storage unavailable */ }
}

// ---------------------------------------------------------------- measuring text
let ctx2d = null, widthScale = 1;
const widths = new Map();
const measure = (t) => {
  let w = widths.get(t);
  if (w === undefined) { w = (ctx2d.measureText(t).width / 100) * widthScale; widths.set(t, w); }
  return w;
};
const measurer = () => ({ word: measure, space: measure(" ") });

async function prepareFont(sampleText) {
  await document.fonts.load(FONT, sampleText || "Aa");
  ctx2d = document.createElement("canvas").getContext("2d");
  ctx2d.font = FONT;
  // One check that the canvas measures like the page lays out (the pipeline's width_scale).
  const probe = document.createElement("span");
  probe.style.cssText = `position:absolute;left:-9999px;white-space:nowrap;font:${FONT}`;
  probe.textContent = "Natural language processing, quickly";
  document.body.append(probe);
  const dom = probe.getBoundingClientRect().width;
  probe.remove();
  const canvas = ctx2d.measureText(probe.textContent).width;
  widthScale = dom > 0 && canvas > 0 && Math.abs(dom / canvas - 1) > 0.002 ? dom / canvas : 1;
  widths.clear();
}

// ---------------------------------------------------------------- transcripts on GitHub
// The private repository shared with vertical_video_maker (layout in core/github.js). The token
// is pasted once per device and kept in this browser's storage for this site.
const GH_KEY = "lecture-karaoke.github";
let gh = null;
function ghConfig() {
  try { return JSON.parse(localStorage.getItem(GH_KEY) || "null"); } catch { return null; }
}
function connect(cfg) {
  gh = cfg?.repo && cfg?.token ? new GitHub({ repo: cfg.repo, token: cfg.token, api: devApi() }) : null;
  $("ghLine").textContent = gh ? `GitHub: ${gh.repo}` : "Connect GitHub";
  drawSyncNote();
  connectDropbox().then(() => { loadLibrary(); renderGet(); });
}
/** A repository file through this device's copy: offline it opens anyway, and an unchanged file
 *  isn't downloaded again. {text, etag} or null when the file doesn't exist; `kept`: only this
 *  device's copy (null without one), GitHub isn't asked. */
async function repoFile(path, kept = false) {
  const key = `gh:${gh.repo}:${path}`, cached = await store.getFile(key);
  if (kept) return cached ?? null;
  try {
    const got = await gh.readText(path, cached);
    if (got && got !== cached) await store.putFile(key, got);
    return got;
  } catch (err) {
    if (err.kind === "offline" && cached) return cached;
    throw err;
  }
}
async function repoIndex(kept = false) {
  const f = await repoFile("index.json", kept);
  return f ? JSON.parse(f.text) : { version: 1, videos: [] };
}

// ---------------------------------------------------------------- Dropbox
// The app's own Dropbox folder (core/dropbox.js), reached with the refresh token in the
// repository's config/dropbox.json: a device connected to GitHub needs nothing more. The folder's
// listing is kept on the device with Dropbox's cursor: the library shows it as it was listed last
// time, and Dropbox is asked again (only what changed) on Check now, or after the app changed the
// folder itself. Opening the app asks Dropbox nothing: the config is this device's copy too
// (GitHub's is read meanwhile, in case it changed).
let dbx = null, dbxReady = Promise.resolve(null);
function connectDropbox() {
  const mine = gh, base = devUrl("dropbox");
  dbx = null;
  const use = (f) => {
    const cfg = f && JSON.parse(f.text);
    if (gh !== mine || !cfg?.app_key || !cfg?.refresh_token) return dbx;
    if (dbx?.appKey !== cfg.app_key || dbx.refreshToken !== cfg.refresh_token) {
      dbx = new Dropbox({ appKey: cfg.app_key, refreshToken: cfg.refresh_token, ...(base ? { api: base, content: `${base}/content` } : {}) });
    }
    return dbx;
  };
  if (!gh) return (dbxReady = Promise.resolve(null));
  const asked = repoFile("config/dropbox.json").then(use).catch(() => dbx);
  dbxReady = repoFile("config/dropbox.json", true).then((kept) => (kept ? use(kept) : asked)).catch(() => null);
  return dbxReady;
}
const listed = (e) => ({ name: e.name, path_lower: e.path_lower, path_display: e.path_display, size: e.size, content_hash: e.content_hash });
/** The app folder's files, {files, offline}: as listed last time (kept here), or brought up to date
 *  by Dropbox when `fresh` or when none are kept. Offline, the copy kept here. */
async function dropboxFiles(fresh = false) {
  const key = `dropbox:${dbx.appKey}:files`, kept = await store.getFile(key);
  if (!fresh && kept?.files) return { files: Object.values(kept.files), offline: false };
  let files = kept?.files ? { ...kept.files } : null, cursor = kept?.cursor;
  try {
    if (files && cursor) {
      try {
        const changed = await dbx.changes(cursor);
        for (const e of changed.entries) {
          if (e[".tag"] === "file") files[e.path_lower] = listed(e);
          else if (e[".tag"] === "deleted") {
            for (const p of Object.keys(files)) if (p === e.path_lower || p.startsWith(`${e.path_lower}/`)) delete files[p];
          }
        }
        cursor = changed.cursor;
      } catch (err) {
        if (err.kind === "offline") throw err;
        files = null;   // the cursor isn't accepted any more (reset, or another account): list afresh
      }
    }
    if (!files) {
      const all = await dbx.list();
      files = Object.fromEntries(all.entries.filter((e) => e[".tag"] === "file").map((e) => [e.path_lower, listed(e)]));
      cursor = all.cursor;
    }
    await store.putFile(key, { files, cursor });
    return { files: Object.values(files), offline: false };
  } catch (err) {
    if (err.kind === "offline" && kept?.files) return { files: Object.values(kept.files), offline: true };
    throw err;
  }
}

// ---------------------------------------------------------------- the Dropbox library (start screen)
// The videos in Dropbox by folder, each with what the repository knows of it: ready, being
// transcribed, not transcribed yet, or failed (core/library.js matches them). A tap streams it;
// in select mode a tap chooses it, to hide the chosen files from the list or delete them from
// Dropbox. Hidden files (hidden.json in the repository, by content hash) have their own view.
// Files never played on any device are marked New (played.json), and pinned folders (pinned.json)
// come first; each folder has a button that plays a random lecture from it. Folders can have tags
// (tags.json) and lectures can be marked not important (unimportant.json): Play by tag lists the
// lectures of the folders with the tags chosen, leaving out the ones not important.

/** A set kept in a repository file that every device shares (hidden.json, played.json, pinned.json,
 *  unimportant.json; tags.json gives a Map of each folder's tags): read with each listing, changed
 *  here at once and then on GitHub. at: when the last change reached GitHub (Infinity while any is
 *  on its way, counted in writing); a listing begun before that keeps the set as it is here. known:
 *  read from GitHub at least once. */
class SharedSet {
  constructor(file, keysOf) { Object.assign(this, { file, keysOf, set: new Set(), at: 0, writing: 0, known: false }); }
  has(key) { return this.set.has(key); }
  /** The keys the file has now, or null when it can't be read now (the set stays as it is);
   *  `kept`: as this device's copy has them (null without one). */
  async fetch(kept = false) {
    try {
      const f = await repoFile(this.file, kept);
      if (kept && !f) return null;
      return this.keysOf(f ? JSON.parse(f.text) : null);
    } catch {
      return null;
    }
  }
  /** Takes what a listing begun at `started` read, unless a change made here since would be lost. */
  take(got, started) {
    if (!got) return;
    this.known = true;
    if (started > this.at) this.set = got;
  }
  /** Adds keys to the set here (add false: removes them) before it returns, then changes the file on
   *  GitHub with change(its data). When that fails, the set goes back and the error is thrown. */
  write(keys, add, change, message) {
    const mark = (on) => { for (const k of keys) (on ? this.set.add(k) : this.set.delete(k)); };
    return this.send(() => mark(add), () => mark(!add), change, message);
  }
  /** Makes a change here (local()) before it returns, then on GitHub with change(the file's data);
   *  when that fails, undo() takes it back here and the error is thrown. */
  async send(local, undo, change, message) {
    local();
    this.writing++;
    this.at = Infinity;
    try {
      const data = await gh.update(this.file, change, message);
      if (this.writing === 1) Object.assign(this, { set: this.keysOf(data), known: true });   // as GitHub has it, other devices' changes too
    } catch (err) {
      undo();
      throw err;
    } finally {
      if (--this.writing === 0) this.at = Date.now();
    }
  }
}
const library = { items: [], loading: null, opening: false, note: "", watchUntil: 0, view: "all", hideMode: false,
  hidden: new SharedSet(HIDDEN_FILE, hiddenHashes), played: new SharedSet(PLAYED_FILE, playedHashes),
  pinned: new SharedSet(PINNED_FILE, pinnedFolders), unimportant: new SharedSet(UNIMPORTANT_FILE, unimportantHashes),
  tags: new SharedSet(TAGS_FILE, folderTags) };
library.tags.set = new Map();
const picking = { on: false, paths: new Set(), busy: "" };   // select mode: the chosen files' paths; busy: progress
const openFolders = new Set();
const BADGES = { ready: ["Ready", "ok"], pending: ["Transcribing", "busy"], failed: ["Failed", "bad"], null: ["Not transcribed", "none"] };
/** Brings the list up to date (one load at a time: a second call gets the running one). Its files
 *  are the ones Dropbox listed last time, kept on this device; Dropbox is asked again when `fresh`
 *  (Check now, a change the app made there) or when none are kept. The first time (an empty list)
 *  it is drawn at once from this device's copies, then again with the repository's files (index,
 *  played, tags…) as GitHub has them now. */
function loadLibrary(fresh = false) {
  $("library").hidden = !dbx;
  if (!dbx) return Promise.resolve();
  if (!library.loading) {
    library.loading = (async () => {
      const shared = [library.hidden, library.played, library.pinned, library.unimportant, library.tags];
      const show = (files, index, got, started) => {
        library.items = mergeLibrary(files, index.videos || []);
        shared.forEach((s, i) => s.take(got[i], started));
      };
      try {
        const kept = !library.items.length && !fresh && (await store.getFile(`dropbox:${dbx.appKey}:files`))?.files;
        if (kept) {
          const started = Date.now(), [index, ...got] = await Promise.all([repoIndex(true), ...shared.map((s) => s.fetch(true))]);
          show(Object.values(kept), index, got, started);
          drawLibrary();
        }
        const started = Date.now();
        const [{ files, offline }, index, ...got] = await Promise.all([dropboxFiles(fresh), repoIndex(), ...shared.map((s) => s.fetch())]);
        show(files, index, got, started);
        library.note = offline ? "Offline: the list as it was last time." : "";
        if (!offline) sharePlayed();
      } catch (err) {
        library.note = `Dropbox: ${err.message}`;
      }
    })().finally(() => {
      library.loading = null;
      drawLibrary();
    });
    drawLibrary();
  }
  return library.loading;
}
const mb = (bytes) => `${bytes >= 1e9 ? (bytes / 1e9).toFixed(1) : Math.max(1, Math.round(bytes / 1e6))} ${bytes >= 1e9 ? "GB" : "MB"}`;
/** A folder's name as the library shows it: without its language mark; the top level is the app's. */
const folderTitle = (folder) => shownFolder(folder) || folder || "Lecture Karaoke";
/** The files of the view on screen: the hidden ones, or all the others. */
const inView = () => library.items.filter((i) => library.hidden.has(i.hash) === (library.view === "hidden"));
/** Never played on any device (known once played.json has been read). */
const isNew = (it) => library.played.known && !library.played.has(it.hash) && !playedQueue.has(it.hash);
function drawLibrary() {
  if (library.view === "hidden" && !library.items.some((i) => library.hidden.has(i.hash))) library.view = "all";
  const shown = inView(), hiddenView = library.view === "hidden";
  const q = $("libSearch").value.trim(), items = searchLibrary(shown, q), groups = groupByFolder(items, library.pinned.set);
  for (const p of picking.paths) if (!shown.some((i) => i.path === p)) picking.paths.delete(p);
  const n = shown.length, busy = shown.filter((i) => i.status === "pending").length;
  const audio = shown.filter((i) => i.audio).length, videos = n - audio;
  const count = [videos && `${videos} video${videos === 1 ? "" : "s"}`, audio && `${audio} audio file${audio === 1 ? "" : "s"}`].filter(Boolean).join(" and ");
  $("libNote").textContent = library.note || (library.loading && !library.items.length ? "Loading…"
    : !library.items.length ? "Nothing yet. Put lecture videos or audio in Dropbox, in Apps/Lecture Karaoke (a folder per course)."
    : q && !items.length ? "Nothing matches."
    : hiddenView ? `${count} hidden from the list${busy ? `, ${busy} being transcribed` : ""}. They stay in Dropbox; select them to show them again.`
    : !n ? `All ${library.items.length} files are hidden from the list.`
    : `${count}${busy ? `, ${busy} being transcribed` : ""}.`) + (hiding() && n ? ` Tap the eye beside a file to ${hiddenView ? "show it again" : "hide it"}.` : "");
  const withTools = !picking.on && !hiddenView;
  $("libList").replaceChildren(...groups.map((g) => {
    const d = Object.assign(document.createElement("details"), { className: "lib-folder", open: !!q || groups.length === 1 || openFolders.has(g.folder) });
    d.dataset.folder = g.folder;
    d.addEventListener("toggle", () => { if (!$("libSearch").value.trim()) (d.open ? openFolders.add(g.folder) : openFolders.delete(g.folder)); });
    const summary = document.createElement("summary"), name = folderTitle(g.folder), tags = library.tags.set.get(g.folder.toLowerCase()) || [];
    summary.append(name, Object.assign(document.createElement("span"), { className: "lib-count", textContent: ` ${g.items.length}` }));
    if (tags.length) summary.append(el("span", { className: "lib-tags" }, ...tags.map((t) => el("span", { className: "tag", textContent: t }))));
    const ul = Object.assign(document.createElement("ul"), { className: "lib-items" });
    ul.append(...g.items.map((it) => {
      const [label, cls] = BADGES[it.status], b = Object.assign(document.createElement("button"), { type: "button", className: "lib-item" });
      const meta = [it.audio ? "Audio" : "", it.entry?.duration_ms ? clock(it.entry.duration_ms / 1000) : "", mb(it.size),
        it.status === "failed" ? it.entry.error : ""];
      const metaLine = Object.assign(document.createElement("span"), { className: "lib-meta" }), minor = library.unimportant.has(it.hash);
      if (isNew(it)) metaLine.append(Object.assign(document.createElement("span"), { className: "lib-new", textContent: "New" }), " · ");
      if (minor) metaLine.append("Not important · ");
      metaLine.append(meta.filter(Boolean).join(" · "));
      b.append(Object.assign(document.createElement("span"), { className: "lib-title", textContent: it.name.replace(/\.[^.]+$/, "") }),
        Object.assign(document.createElement("span"), { className: `badge ${cls}`, textContent: label }), metaLine);
      b.classList.toggle("minor", minor);
      if (picking.on) {
        b.classList.add("picking");
        b.setAttribute("aria-pressed", String(picking.paths.has(it.path)));
        b.prepend(Object.assign(document.createElement("span"), { className: "lib-tick" }));
      }
      b.addEventListener("click", () => (picking.on ? pick(it, b) : openFromDropbox(it)));
      const li = document.createElement("li");
      li.append(b);
      if (hiding()) li.append(hideButton(it, hiddenView));
      else if (withTools) li.append(importanceButton(it, !minor));
      return li;
    }));
    d.append(summary);
    if (withTools) {   // the folder's tags, when it is open
      const edit = el("button", { type: "button", className: "linkish", textContent: tags.length ? "Edit tags" : "Add tags" });
      edit.addEventListener("click", () => editTags(g.folder, name));
      d.append(el("p", { className: "lib-tag-line" }, edit));
    }
    d.append(ul);
    if (!withTools) return d;
    // Beside the folder's name, not in it (a button inside <summary> would open and close the folder):
    // a random lecture from the folder, the folder in order from where it is new, its transcripts in
    // one ZIP, and the pin.
    const group = Object.assign(document.createElement("div"), { className: "lib-group" });
    const tools = Object.assign(document.createElement("div"), { className: "lib-tools" });
    const tool = (label, svg, act) => {
      const b = Object.assign(document.createElement("button"), { type: "button", className: "lib-tool", ariaLabel: label, title: label, innerHTML: svg });
      b.addEventListener("click", act);
      return b;
    };
    const pin = tool(g.pinned ? `Unpin “${name}”` : `Pin “${name}” to the top`, PIN_SVG, () => setPinned(g.folder, !g.pinned, name));
    pin.setAttribute("aria-pressed", String(g.pinned));
    tools.append(tool(`Play a random lecture from “${name}”`, SHUFFLE_SVG, () => { const it = randomPick(g.items); if (it) playItem(it, undefined, { fromStart: true }); }));
    tools.append(tool(`Play “${name}” in order, from its first new lecture (or the one played last)`, LIST_SVG, () => playFolderOn(g.folder)));
    if (g.items.some((i) => i.status === "ready")) {
      tools.append(tool(`Download the transcripts of “${name}”`, DOWNLOAD_SVG, () => downloadFolder(g.folder, g.items)));
    }
    tools.append(pin);
    group.style.setProperty("--tools", tools.children.length);
    group.append(d, tools);
    return group;
  }));
  drawPick();
  if (player.hidden) drawThisLecture();
  else drawSteps();   // ⏮/⏭ and the bar's star and hide button, once the list knows the lecture
}
$("libSearch").addEventListener("input", drawLibrary);
const SHUFFLE_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7h3.2c2 0 3.1 1 4.1 2.6l2.6 4.8c1 1.6 2.1 2.6 4.1 2.6H20M3 17h3.2c1.3 0 2.2-.4 3-1.2M14.2 8.2c.8-.8 1.7-1.2 3-1.2H20M17.5 4.5 20 7l-2.5 2.5M17.5 14.5 20 17l-2.5 2.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const DOWNLOAD_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v10.5M7.5 10 12 14.5 16.5 10M5 19.5h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const LIST_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 6h12M3.5 11h8M3.5 16h6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M14.5 13v8l6.5-4z" fill="currentColor"/></svg>`;
const PIN_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><path class="pin-head" d="M9 3.5h6l-1 5.5 3.5 4h-11L10 9z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M12 13v7.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
const EYE_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12s3.6-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.6 6.5-9.5 6.5S2.5 12 2.5 12z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="2"/></svg>`;
const EYE_OFF_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12s3.4-6 9-6c1.9 0 3.5.7 4.8 1.6M21 12s-3.4 6-9 6c-1.9 0-3.5-.7-4.8-1.6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M9.9 14.1a3 3 0 0 1 4.2-4.2M4 20 20 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
/** Hide mode (the floating eye button of the start screen; not while selecting files). */
const hiding = () => library.hideMode && !picking.on;
/** Hide mode's button beside a file: off the list at once, or among the hidden ones back on it, with
 *  Undo for 3 s. */
function hideButton(it, back) {
  const name = it.name.replace(/\.[^.]+$/, ""), says = back ? `Show “${name}” in the list again` : `Hide “${name}” from the list`;
  const b = el("button", { type: "button", className: "lib-star lib-hide", innerHTML: back ? EYE_SVG : EYE_OFF_SVG, title: says });
  b.setAttribute("aria-label", says);
  b.addEventListener("click", () => setHidden([it], !back, { undoMs: 3000 }));
  return b;
}
const STAR_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.8l2.5 5.2 5.7.8-4.1 4 1 5.7-5.1-2.7-5.1 2.7 1-5.7-4.1-4 5.7-.8z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>`;

/** A lecture's star: lit while it is important (as lectures are at first); a tap switches it. */
function importanceButton(it, important) {
  const name = it.name.replace(/\.[^.]+$/, "");
  const b = el("button", { type: "button", className: "lib-star", innerHTML: STAR_SVG,
    title: important ? "Important (tap: not important, left out of Play by tag)" : "Not important: left out of Play by tag (tap: important)" });
  b.setAttribute("aria-label", `Important: ${name}`);
  b.setAttribute("aria-pressed", String(important));
  b.addEventListener("click", () => setImportant([it], !important));
  return b;
}
/** Marks lectures important (or not), on every device: unimportant.json. Play by tag leaves out the
 *  ones not important; they stay in their folder. The toast's Undo reverses it (quiet: no toast, as
 *  for the bar's star, which shows the change itself). */
async function setImportant(items, important, quiet = false) {
  const n = items.length, what = n === 1 ? `“${items[0].name.replace(/\.[^.]+$/, "")}”` : `${n} lectures`;
  const done = library.unimportant.write(items.map((it) => it.hash), !important, (cur) => withUnimportant(cur, items, !important),
    `Mark ${n === 1 ? items[0].name : `${n} files`} ${important ? "important" : "not important"}`);
  drawLibrary();
  drawThisLecture();
  try {
    await done;
    if (!quiet) toast(important ? `${what} is important again.` : `${what}: not important, left out of Play by tag.`, "Undo", () => setImportant(items, !important));
  } catch (err) {
    toast(`Couldn't change ${what}: ${err.message}`);
  }
  drawLibrary();
  drawThisLecture();
}

// ---------------------------------------------------------------- folder tags
// A folder's tags (tags.json, shared by the devices) group it with others for Play by tag. The open
// folder's Add tags / Edit tags opens the editor: the tags it has, a box for new ones (commas make
// several), and the tags other folders have, to add with a tap. Save writes them.
let tagEdit = null;   // {folder, name, tags}
function editTags(folder, name) {
  tagEdit = { folder, name, tags: [...(library.tags.set.get(folder.toLowerCase()) || [])] };
  $("tagTitle").textContent = `Tags of “${name}”`;
  $("tagInput").value = "";
  drawTagEdit();
  $("tagDialog").showModal();
}
function drawTagEdit() {
  const mine = new Set(tagEdit.tags.map((t) => t.toLowerCase())), others = allTags(library.tags.set).filter((t) => !mine.has(t.toLowerCase()));
  $("tagChips").replaceChildren(...(tagEdit.tags.length ? tagEdit.tags.map((t) => {
    const x = el("button", { type: "button", className: "tag-x", textContent: "×" });
    x.setAttribute("aria-label", `Remove the tag ${t}`);
    x.addEventListener("click", () => { tagEdit.tags = tagEdit.tags.filter((o) => o !== t); drawTagEdit(); });
    return el("li", { className: "tag" }, t, x);
  }) : [el("li", { className: "small", textContent: "No tags yet." })]));
  $("tagOthersLine").hidden = !others.length;
  $("tagOthers").replaceChildren(...others.map((t) => {
    const b = el("button", { type: "button", className: "chip", textContent: `+ ${t}` });
    b.addEventListener("click", () => addTags(t));
    return b;
  }));
}
/** Adds typed tags (commas between them), spelled as other folders' tags already are. */
function addTags(text) {
  const inUse = new Map(allTags(library.tags.set).map((t) => [t.toLowerCase(), t]));
  tagEdit.tags = cleanTags([...tagEdit.tags, ...cleanTags(text.split(",")).map((t) => inUse.get(t.toLowerCase()) ?? t)]);
  drawTagEdit();
}
$("tagAdd").addEventListener("click", () => { addTags($("tagInput").value); $("tagInput").value = ""; $("tagInput").focus(); });
$("tagInput").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("tagAdd").click(); } });
$("tagCancel").addEventListener("click", () => $("tagDialog").close());
$("tagSave").addEventListener("click", async () => {
  if ($("tagInput").value.trim()) addTags($("tagInput").value);   // typed, but Add not tapped
  const { folder, name } = tagEdit, tags = cleanTags(tagEdit.tags), key = folder.toLowerCase(), map = library.tags.set, before = map.get(key);
  $("tagDialog").close();
  const put = (t) => (t?.length ? map.set(key, t) : map.delete(key));
  const done = library.tags.send(() => put(tags), () => put(before), (cur) => withTags(cur, folder, tags),
    `Tag ${folder || "the top level"}: ${tags.join(", ") || "no tags"}`);
  drawLibrary();
  try {
    await done;
    toast(tags.length ? `“${name}”: ${tags.join(", ")}.` : `“${name}” has no tags now.`);
  } catch (err) {
    toast(`Couldn't save the tags of “${name}”: ${err.message}`);
  }
  drawLibrary();
});

// ---------------------------------------------------------------- play by tag
// The start screen's Play by tag: choose tags, and All, New or Played; the list has the lectures of
// the folders with any of the tags, by folder (as in the library) and by name, without the ones not
// important or hidden. Play in order plays them one after another, Shuffle in random order until each
// has played once; a lecture in the list starts the order there. The choice is kept on this device.
function tagChoice() {
  const p = prefs.tagPick ?? {}, inUse = new Set(allTags(library.tags.set).map((t) => t.toLowerCase()));
  return { tags: new Set((Array.isArray(p.tags) ? p.tags : []).filter((t) => inUse.has(t))), status: ["new", "played"].includes(p.status) ? p.status : "all" };
}
function setTagChoice(change) {
  const { tags, status } = { ...tagChoice(), ...change };
  prefs.tagPick = { tags: [...tags], status };
  savePrefs();
  drawTagPlay();
}
/** The list for the tags chosen, and how many lectures not important it leaves out. */
function tagChoiceList() {
  const { tags, status } = tagChoice(), opts = { pinned: library.pinned.set, status, isNew };
  const list = tagList(library.items, library.tags.set, tags, { ...opts, leave: (i) => library.hidden.has(i.hash) || library.unimportant.has(i.hash) });
  const minor = tagList(library.items, library.tags.set, tags, { ...opts, leave: (i) => library.hidden.has(i.hash) }).length - list.length;
  return { list, minor };
}
function drawTagPlay() {
  const all = allTags(library.tags.set), { tags, status } = tagChoice(), { list, minor } = tagChoiceList();
  $("tpTags").replaceChildren(...all.map((t) => {
    const b = el("button", { type: "button", className: "chip", textContent: t }), on = tags.has(t.toLowerCase());
    b.setAttribute("aria-pressed", String(on));
    b.addEventListener("click", () => { const next = new Set(tags); on ? next.delete(t.toLowerCase()) : next.add(t.toLowerCase()); setTagChoice({ tags: next }); });
    return b;
  }));
  $("tpNoTags").hidden = all.length > 0;
  for (const r of $("tagPlayDialog").querySelectorAll("input[name=tpStatus]")) r.checked = r.value === status;
  const folders = new Set(list.map((i) => i.folder)).size;
  $("tpSays").textContent = !all.length ? "" : !tags.size ? "Choose one or more tags." : !list.length ? "No lectures." :
    `${list.length} lecture${list.length === 1 ? "" : "s"} in ${folders} folder${folders === 1 ? "" : "s"}` +
    (minor ? `; ${minor} not important left out.` : ".");
  let folder = null;
  $("tpList").replaceChildren(...list.flatMap((it) => {
    const rows = [];
    if (it.folder !== folder) rows.push(el("li", { className: "tp-folder", textContent: folderTitle((folder = it.folder)) }));
    const meta = [isNew(it) ? "New" : "", it.entry?.duration_ms ? clock(it.entry.duration_ms / 1000) : "", it.status === "ready" ? "" : BADGES[it.status][0]];
    const b = el("button", { type: "button", className: "tp-item" }, el("span", { className: "lib-title", textContent: it.name.replace(/\.[^.]+$/, "") }),
      el("span", { className: "lib-meta", textContent: meta.filter(Boolean).join(" · ") }));
    b.addEventListener("click", () => playList(list, it, false));
    rows.push(el("li", {}, b));
    return rows;
  }));
  $("tpPlay").disabled = $("tpShuffle").disabled = !list.length;
}
$("tagPlayBtn").addEventListener("click", () => { drawTagPlay(); $("tagPlayDialog").showModal(); });
for (const r of $("tagPlayDialog").querySelectorAll("input[name=tpStatus]")) r.addEventListener("change", () => setTagChoice({ status: r.value }));
$("tpClose").addEventListener("click", () => $("tagPlayDialog").close());
$("tpPlay").addEventListener("click", () => playList(tagChoiceList().list, null, false));
$("tpShuffle").addEventListener("click", () => playList(tagChoiceList().list, null, true));
/** Plays a list by tag: in order from `first` (else its first lecture), or shuffled. */
function playList(list, first, shuffle) {
  if (!list.length) return;
  $("tagPlayDialog").close();
  const label = [...tagChoice().tags].map((t) => allTags(library.tags.set).find((x) => x.toLowerCase() === t) ?? t).join(", ");
  const start = first ?? (shuffle ? randomOther(list, null) : list[0]);
  setEndMode(shuffle ? "shuffle" : "next");
  playItem(start, { list, label, played: new Set() }, { fromStart: !first });   // a lecture tapped in the list resumes
}

/** Pins a folder to the top of the list (pin false: back in its place), on every device: pinned.json. */
async function setPinned(folder, pin, name) {
  const done = library.pinned.write([folder.toLowerCase()], pin, (cur) => withPinned(cur, folder, pin),
    `${pin ? "Pin" : "Unpin"} ${folder || "the top level"} in the app's list`);
  drawLibrary();
  try {
    await done;
    toast(pin ? `Pinned “${name}” to the top.` : `Unpinned “${name}”.`);
  } catch (err) {
    toast(`Couldn't ${pin ? "pin" : "unpin"} “${name}”: ${err.message}`);
  }
  drawLibrary();
}

// ---------------------------------------------------------------- a folder's transcripts
// A library folder's download button makes one ZIP of the transcripts of the lectures listed under
// it (while searching, those found), with the word fixes on GitHub and this device's: for each, a
// .txt (one sentence per line) and a .json (with word timings), as Settings → Transcript gives them,
// and all the text in one file. Getting the transcripts takes a moment (4 at a time); then Save hands
// the file over: on a phone the share sheet, which needs a fresh tap.
let folderJob = null;   // {file, cancelled}
async function downloadFolder(folder, items) {
  const ready = items.filter((i) => i.status === "ready" && i.entry?.transcript), name = folderTitle(folder);
  const job = folderJob = { file: null, cancelled: false };
  $("folderTitle").textContent = `Transcripts of “${name}”`;
  $("folderSays").textContent = `${ready.length} of the ${items.length} lecture${items.length === 1 ? "" : "s"} listed ` +
    `${items.length === 1 ? "has" : "have"} a transcript. The ZIP has each as plain text (.txt, a sentence per line) and as JSON ` +
    "(.json, with word timings), with your word fixes, and all the text in one file.";
  Object.assign($("folderProgress"), { max: ready.length || 1, value: 0 });
  $("folderStatus").textContent = "Getting the transcripts…";
  $("folderSave").disabled = true;
  $("folderDialog").showModal();
  const recs = new Map((await store.list()).filter((r) => r.repoKey).map((r) => [r.repoKey, r]));
  const got = new Array(ready.length), failed = [];
  let next = 0, done = 0;
  const worker = async () => {
    while (next < ready.length && !job.cancelled) {
      const i = next++;
      try {
        got[i] = await lectureTranscript(ready[i], recs.get(ready[i].entry.key));
      } catch (err) {
        failed.push(`${ready[i].name}: ${err.message}`);
      }
      done++;
      if (folderJob !== job) continue;   // cancelled, or another folder's now
      $("folderProgress").value = done;
      $("folderStatus").textContent = `Getting the transcripts: ${done} of ${ready.length}…`;
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  if (job.cancelled) return;
  const parts = got.filter(Boolean);
  const zip = await zipFiles([{ name: "All transcripts.txt", data: parts.map((p) => `# ${p.base}\n\n${p.text}`).join("\n") },
    ...parts.flatMap((p) => [{ name: `${p.base}.txt`, data: p.text }, { name: `${p.base}.json`, data: p.json }])]);
  if (job.cancelled) return;
  job.file = new File([zip], `${name.replaceAll("/", " - ")} - transcripts.zip`, { type: "application/zip" });
  $("folderStatus").textContent = (parts.length ? `Ready: ${parts.length} transcript${parts.length === 1 ? "" : "s"}, ` +
    `${zip.length < 1e6 ? `${Math.ceil(zip.length / 1e3)} KB` : mb(zip.length)}.` : "Nothing to save.") +
    (failed.length ? ` ${failed.length} couldn't be read (${failed[0]}${failed.length > 1 ? ", …" : ""}).` : "");
  $("folderSave").disabled = !parts.length;
}
/** One lecture's transcript as the files of the ZIP, with GitHub's fixes and this device's (rec). */
async function lectureTranscript(it, rec) {
  const text = await transcriptFile(`gh:${gh.repo}:${it.entry.transcript}`);
  if (!text) throw new Error("it isn't on this device, and GitHub can't be reached");
  const data = JSON.parse(text);
  let fixes = [];
  try {
    fixes = JSON.parse((await repoFile(`fixes/${it.entry.key}.json`))?.text ?? "null")?.fixes ?? [];
  } catch { /* offline: this device's only */ }
  if (rec) fixes = applyDeltas(fixes, rec.synced ? rec.pending : rec.fixes);   // before its first sync, all of them
  const words = applyFixes(wordsFromTranscript(data), fixes);
  return { base: it.name.replace(/\.[^.]+$/, ""), text: transcriptText(words), json: JSON.stringify(exportTranscript(data, words, fixes, it.name)) };
}
$("folderSave").addEventListener("click", async () => {
  const file = folderJob?.file;
  if (!file) return;
  if (isMobile && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: file.name });
      $("folderDialog").close();
      return;
    } catch (err) {
      if (err.name === "AbortError") return;
    }
  }
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(file), download: file.name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  $("folderDialog").close();
});
$("folderCancel").addEventListener("click", () => $("folderDialog").close());
$("folderDialog").addEventListener("close", () => {
  if (folderJob) folderJob.cancelled = true;
  folderJob = null;
});

// ---------------------------------------------------------------- played files
// A file counts as played once it starts playing; the library marks the others New. played.json in
// the repository has the files played on any device (by content hash). A file played here waits in
// this device's queue until GitHub has it (offline, it goes later). The first time, the lectures
// this device played before are queued too: its records with a position, found in the library by
// their Dropbox file or by their video.
const PLAYED_QUEUE = "played:queue";   // {seeded, items: [{hash, name, path}]} on the device
const playedQueue = new Map();
let playedSeeded = false, sendingPlayed = null;
const playedReady = store.getFile(PLAYED_QUEUE).then((q) => {
  for (const it of q?.items || []) playedQueue.set(it.hash, it);
  playedSeeded = !!q?.seeded;
});
const keepPlayedQueue = () => store.putFile(PLAYED_QUEUE, { seeded: playedSeeded, items: [...playedQueue.values()] });
/** The library file playing now: streamed from Dropbox, or a copy of one (the same video). */
function playingFile() {
  const d = S.picked?.dropbox, fp = S.picked?.fingerprint;
  if (d?.hash) return { hash: d.hash, name: S.videoName, path: d.path };
  const it = fp && library.items.find((i) => i.entry?.fingerprint === fp);
  return it ? { hash: it.hash, name: it.name, path: it.path } : null;
}
async function queuePlayed(items) {
  await playedReady;
  const fresh = items.filter((it) => it?.hash && !playedQueue.has(it.hash) && !library.played.has(it.hash));
  if (!fresh.length) return;
  for (const it of fresh) playedQueue.set(it.hash, it);
  await keepPlayedQueue();
  sharePlayed();
}
/** Sends the queue to played.json, one send at a time; what fails stays queued for the next listing. */
async function sharePlayed() {
  await playedReady;
  if (!playedSeeded && library.items.length && library.played.known) await seedPlayed();
  if (!gh || sendingPlayed || !playedQueue.size) return;
  const items = [...playedQueue.values()];
  sendingPlayed = library.played.write(items.map((it) => it.hash), true, (cur) => withPlayed(cur, items),
    items.length === 1 ? `Played ${items[0].name}` : `Played ${items.length} files`);
  try {
    await sendingPlayed;
    for (const it of items) playedQueue.delete(it.hash);
    await keepPlayedQueue();
  } catch { /* stays queued */ } finally {
    sendingPlayed = null;
  }
  if (playedQueue.size && items.every((it) => !playedQueue.has(it.hash))) sharePlayed();   // played meanwhile
}
/** Queues, once per device, the lectures it played before: its records with a position. */
async function seedPlayed() {
  playedSeeded = true;
  const byHash = new Map(library.items.map((i) => [i.hash, i]));
  const byVideo = new Map(library.items.filter((i) => i.entry?.fingerprint).map((i) => [i.entry.fingerprint, i]));
  for (const r of await store.list()) {
    const it = r.position > 0 && (byHash.get(r.dropbox?.hash) || byVideo.get(r.video?.fingerprint));
    if (it && !library.played.has(it.hash)) playedQueue.set(it.hash, { hash: it.hash, name: it.name, path: it.path });
  }
  await keepPlayedQueue();
  if (player.hidden) drawLibrary();
}

// ---------------------------------------------------------------- deleting files from Dropbox
// Select, tap the files, Delete, and confirm. Dropbox keeps deleted files for at least 30 days
// (restored from dropbox.com); their transcripts stay in the repository, so a file put back is
// matched again. A deleted file also leaves the recent list.
function pick(it, b) {
  if (picking.busy) return;
  if (!picking.paths.delete(it.path)) picking.paths.add(it.path);
  b.setAttribute("aria-pressed", String(picking.paths.has(it.path)));
  drawPick();
}
function drawPick() {
  const n = picking.paths.size, hiddenView = library.view === "hidden";
  const hidden = library.items.filter((i) => library.hidden.has(i.hash)).length;
  $("libSelect").textContent = picking.on ? "Cancel" : "Select";
  $("libSelect").hidden = !inView().length && !picking.on;
  $("libSelect").disabled = !!picking.busy;
  $("libHidden").hidden = picking.on || (!hidden && !hiddenView);
  $("libHidden").textContent = hiddenView ? "All files" : `Hidden (${hidden})`;
  $("libPick").hidden = !picking.on;
  $("libPicked").textContent = picking.busy || (n ? `${n} selected` : `Tap the files to ${hiddenView ? "unhide" : "hide"} or delete.`);
  $("libHide").textContent = hiddenView ? "Unhide" : "Hide";
  $("libHide").disabled = $("libDelete").disabled = !n || !!picking.busy;
  $("hideFab").hidden = picking.on || !library.items.length;
  $("hideFab").setAttribute("aria-pressed", String(library.hideMode));
}
$("hideFab").addEventListener("click", () => {
  library.hideMode = !library.hideMode;
  drawLibrary();
});
$("libSettings").addEventListener("click", openSettings);
$("libSelect").addEventListener("click", () => {
  picking.on = !picking.on;
  library.hideMode = false;
  picking.paths.clear();
  drawLibrary();
});
$("libHidden").addEventListener("click", () => {
  library.view = library.view === "hidden" ? "all" : "hidden";
  drawLibrary();
});
$("libHide").addEventListener("click", () => {
  const items = library.items.filter((i) => picking.paths.has(i.path));
  if (items.length) setHidden(items, library.view !== "hidden");
});
/** Takes these files off the list (hide) or puts them back, on every device: hidden.json in the
 *  repository. They stay in Dropbox. The toast's Undo (for undoMs) reverses it, offered at once: the
 *  list shows the change before GitHub has it. A file put back has its plays to the end counted
 *  afresh (countFinished). */
async function setHidden(items, hide, { undoMs = 5000, says = "" } = {}) {
  const n = items.length, what = n === 1 ? `“${items[0].name}”` : `${n} files`;
  const done = library.hidden.write(items.map((it) => it.hash), hide, (cur) => withHidden(cur, items, hide),
    `${hide ? "Hide" : "Unhide"} ${n === 1 ? items[0].name : `${n} files`} in the app's list`);
  if (!hide) forgetFinished(items);
  picking.on = false;
  picking.paths.clear();
  drawLibrary();
  toast(says || (hide ? `Hid ${what} from the list.` : `${what} ${n === 1 ? "is" : "are"} back in the list.`), "Undo",
    () => setHidden(items, !hide, { undoMs }), undoMs);
  try {
    await done;
  } catch (err) {
    toast(`Couldn't ${hide ? "hide" : "unhide"} ${what}: ${err.message}`);
  } finally {
    drawLibrary();
  }
}
let chosen = [];
$("libDelete").addEventListener("click", () => {
  chosen = library.items.filter((i) => picking.paths.has(i.path));
  const n = chosen.length, busy = chosen.filter((i) => i.status === "pending"), li = (props) => Object.assign(document.createElement("li"), props);
  if (!n) return;
  $("delTitle").textContent = n === 1 ? "Delete this file from Dropbox?" : `Delete these ${n} files from Dropbox?`;
  $("delList").replaceChildren(...chosen.slice(0, 8).map((i) => li({ textContent: i.path.slice(1) })),
    ...(n > 8 ? [li({ className: "more", textContent: `and ${n - 8} more` })] : []));
  $("delBusy").hidden = !busy.length;
  $("delBusy").textContent = busy.length === 1 ? `“${busy[0].name}” is still being transcribed: without the file, that may fail.`
    : `${busy.length} of them are still being transcribed: without their files, that may fail.`;
  $("delDialog").returnValue = "";
  $("delDialog").showModal();
});
$("delDialog").addEventListener("close", () => { if ($("delDialog").returnValue === "delete") deleteChosen(chosen); });
async function deleteChosen(items) {
  const failed = [];
  for (const [n, it] of items.entries()) {
    picking.busy = `Deleting ${n + 1} of ${items.length}…`;
    drawPick();
    try {
      await dbx.remove(it.path);
      library.items = library.items.filter((i) => i.path !== it.path);
      picking.paths.delete(it.path);
      await forgetRecent(it.path);
    } catch (err) {
      failed.push(err.message);
    }
  }
  picking.busy = "";
  picking.on = failed.length > 0;   // the ones that failed stay chosen, to try again
  toast(failed.length ? `Couldn't delete ${failed.length} of ${items.length}: ${failed[0]}`
    : items.length === 1 ? `Deleted “${items[0].name}” from Dropbox.` : `Deleted ${items.length} files from Dropbox.`);
  drawLibrary();
  drawRecent();
  await library.loading;   // a listing begun before the deletions would bring them back: list again after it
  loadLibrary(true);
}
async function forgetRecent(path) {
  for (const r of await store.list()) {
    if (r.hidden || r.dropbox?.path?.toLowerCase() !== path.toLowerCase()) continue;
    const { id, ...rest } = r;
    await store.save(id, { ...rest, hidden: true });
  }
}
$("libCheck").addEventListener("click", async () => {
  $("libCheck").disabled = true;
  try {
    await library.loading;   // a load already running would keep the list as it was
    await loadLibrary(true);   // the list as Dropbox has it now
    await gh.dispatch("");
    library.watchUntil = Date.now() + 20 * 60000;
    toast("The transcription job is looking for new files; it takes a few minutes.");
  } catch (err) {
    toast(err.message);
  } finally {
    $("libCheck").disabled = false;
  }
});
// While anything is being transcribed (or just after Check now), the list's statuses refresh every
// minute from the repository (Dropbox isn't asked again).
setInterval(() => {
  if (dbx && player.hidden && (Date.now() < library.watchUntil || library.items.some((i) => i.status === "pending"))) loadLibrary();
}, 60000);

/** What the player needs from a Dropbox file. A video that its index entry names (this very file)
 *  needs nothing read. Otherwise the MP4 index (moov) is read with byte ranges, and a recording's
 *  cover art (from the moov, or from the tags at the start of other audio files); kept on the
 *  device. Other audio files are known by their content hash, their length by their entry or once
 *  they play. {info, fingerprint, audio, art} */
async function dropboxMediaInfo(it) {
  const e = it.entry, mp4 = mediaKind(it.name) === "mp4";
  if (mp4 && !AUDIO_FILE.test(it.name) && e?.fingerprint && e.dropbox?.hash === it.hash && e.width > 0
    && [e.duration_ms, e.audio_start_ms, e.width, e.height].every(Number.isFinite)) {
    return { info: { durationSec: e.duration_ms / 1000, audioStartSec: e.audio_start_ms / 1000, width: e.width, height: e.height },
      fingerprint: e.fingerprint, audio: false, art: null };
  }
  const key = `dropbox:info:${it.hash}`;
  let got = await store.getFile(key);
  if (!got) {
    const read = pagedReader((offset, length) => dbx.download(it.path, offset, Math.min(offset + length, it.size) - 1), it.size);
    if (mp4) {
      const m = await readMp4Info(read, it.size), audio = !m.tracks.some((t) => t.handler === "vide");
      got = { info: { durationSec: m.durationSec, audioStartSec: m.audioStartSec, width: m.width, height: m.height },
        fingerprint: await videoFingerprint(m, it.size), audio, art: audio ? mp4Artwork(m.moov) : null };
      await store.putFile(key, got);
    } else {
      const art = await audioArtwork(read, it.size).catch(() => undefined);   // not read now: bars, and next time it tries again
      got = { info: { durationSec: 0, audioStartSec: 0, width: 0, height: 0 }, fingerprint: hashFingerprint(it.hash), audio: true, art: art ?? null };
      if (art !== undefined) await store.putFile(key, got);
    }
  }
  return got.info.durationSec || !(e?.duration_ms > 0) ? got : { ...got, info: { ...got.info, durationSec: e.duration_ms / 1000 } };
}

/** Streams a library video, which plays at once: with its transcript when it has one, else while it
 *  waits. It plays among `within` (a scope: a list by tag, or the folder it is stepped through), else
 *  among its folder's lectures. It goes on where it was left, unless `fromStart`: only a lecture
 *  picked from a list resumes, not one that follows another (the end mode, ⏮/⏭) or a random one.
 *  `coming` (showComing) is a lecture put in place of the open one: it plays once open only if
 *  coming.play says so (Stop leaves it paused; a tap on play meanwhile changes that). */
async function openFromDropbox(it, within, { fromStart = false, coming: next = null } = {}) {
  allowMedia();   // a tap in the list, on shuffle, on a recent lecture or Play by tag
  if (!dbx || library.opening) return;
  library.opening = true;
  setProblems([]);
  $("libNote").textContent = `Opening ${it.name}…`;
  let opened = false;
  try {
    const linking = linkFor(it.path), ref = transcriptRef(it), got = ahead.get(it.path);
    const reading = ref && (got?.ref === ref ? got.text : transcriptFile(ref).catch(() => null));   // meanwhile, or fetched ahead
    ahead.delete(it.path);
    linking.catch(() => {});   // thrown below
    const { info, fingerprint, audio, art } = await dropboxMediaInfo(it);
    const { link, fetched } = await linking;
    const picked = { url: link, name: it.name, size: it.size, info, fingerprint, audio: !!audio, art: art ?? null,
      dropbox: { path: it.path, hash: it.hash } };
    // an entry found by name and size must be this very video
    const entry = it.entry && (!it.entry.fingerprint || it.entry.fingerprint === fingerprint) ? it.entry : null;
    if (entryStatus(entry) === "ready") {
      const text = (await reading) || await transcriptFile(ref);
      if (!text) throw new Error("its transcript isn't on this device, and GitHub can't be reached.");
      await openPair(JSON.parse(text), picked, { ref, key: entry.key, sure: true, fromStart, coming: next });
    } else {
      openWaiting(picked, next);
    }
    if (S.picked === picked) {
      opened = true;
      stream = { path: it.path, fetched, renewing: false, lastError: 0 };
      scope = within ?? { folder: it.folder, played: new Set() };
      drawSteps();
      trackVideo(picked, entry);
      aheadSoon(picked);
    }
  } catch (err) {
    setProblems([`Could not open ${it.name}: ${err.message}`]);
    if (!player.hidden) toast(`Could not open ${it.name}: ${err.message}`);   // the next one, in the player
  } finally {
    library.opening = false;
    if (next && coming === next) {
      coming = null;
      if (!opened && !player.hidden) unshowComing();   // still the lecture before
      drawPlayLook(!media().paused);
    }
    drawLibrary();
  }
}
/** Where a library lecture's transcript is, when it has one. */
const transcriptRef = (it) => (it.entry?.transcript && gh ? `gh:${gh.repo}:${it.entry.transcript}` : null);

// A Dropbox link lasts 4 hours: it is renewed before then, and at once when the video stops with an
// error (an expired link), keeping the position and whether it was playing. While the app is hidden
// the sound plays on from the old link, unless that stopped it.
let stream = null;   // {path, fetched, renewing, lastError}
async function renewStream() {
  const s = stream;
  if (!s || s.renewing || !dbx) return;
  s.renewing = true;
  const at = video.currentTime, playing = S.playing;   // read at once: an expired link also pauses the video
  const bgAt = bg.currentTime, bgStopped = bgOn && !!bg.error;
  try {
    const { link } = await dbx.temporaryLink(s.path);
    if (stream !== s) return;
    s.fetched = Date.now();
    links.set(s.path, { link, fetched: s.fetched });
    S.picked.url = S.videoUrl = link;
    if (bgStopped && bgOn) playHidden(bgAt);
    S.swapping = true;
    video.addEventListener("loadedmetadata", () => {
      video.currentTime = at;
      S.swapping = false;
      if (playing && !bgOn) video.play().catch(() => {});
    }, { once: true });
    video.src = link;
  } catch (err) {
    if (stream === s) toast(`The Dropbox link couldn't be renewed: ${err.message}`);
  } finally {
    s.renewing = false;
  }
}
setInterval(() => { if (stream && !player.hidden && Date.now() - stream.fetched > LINK_RENEW_MS) renewStream(); }, 10000);
video.addEventListener("error", () => {
  S.swapping = false;
  if (!stream || Date.now() - stream.lastError < 20000) return;   // an error right after renewing isn't the link
  stream.lastError = Date.now();
  renewStream();
});

// ---------------------------------------------------------------- opening files
const problems = $("problems");
function setProblems(list) {
  problems.replaceChildren(...list.map((t) => Object.assign(document.createElement("p"), { textContent: t })));
}
function setStep(which, text, done) {
  $(which === "video" ? "videoName" : "jsonName").textContent = text;
  $(which === "video" ? "pickVideo" : "pickJson").closest(".pick").classList.toggle("done", !!done);
}
function updateStart() {
  $("startBtn").disabled = !(S.videoFile && S.jsonFile);
}
// The inputs are emptied after each pick, so picking the same file again still counts.
for (const id of ["pickVideo", "pickJson"]) $(id).addEventListener("click", allowMedia);   // the lecture plays once open
$("pickVideo").addEventListener("change", (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) pickedVideo(f); });
$("pickJson").addEventListener("change", (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) pickedJson(f); });

// Drag and drop onto the welcome screen (a dropped .json is used instead of looking one up).
addEventListener("dragover", (e) => { e.preventDefault(); document.body.classList.add("dragging"); });
addEventListener("dragleave", (e) => { if (!e.relatedTarget) document.body.classList.remove("dragging"); });
addEventListener("drop", (e) => {
  e.preventDefault();
  document.body.classList.remove("dragging");
  if (!player.hidden) return;
  const files = [...e.dataTransfer.files];
  const json = files.find((f) => /\.json$/i.test(f.name) || f.type === "application/json");
  const vid = files.find((f) => f !== json && mediaKind(f.name, f.type));
  if (vid) pickedVideo(vid, { lookup: !json });
  if (json) pickedJson(json);
});

const noun = (picked) => (picked?.audio ? "recording" : "video");

/** What the app needs from a picked file: its details (an MP4's index, 1-3 MB of it), its
 *  fingerprint and, for a recording, its cover art. Other audio files are read whole once, for
 *  their Dropbox content hash (kept by name, size and date), calling onProgress(done, total). */
async function probeMedia(file, onProgress) {
  const kind = mediaKind(file.name, file.type, new Uint8Array(await file.slice(0, 12).arrayBuffer()));
  if (!kind) throw new Error("the app plays MP4 videos and audio files (MP3, M4A, AAC, WAV, FLAC, Ogg, Opus).");
  if (kind === "mp4") {
    const info = await readMp4Info(blobReader(file), file.size), audio = !info.tracks.some((t) => t.handler === "vide");
    return { file, info, fingerprint: await videoFingerprint(info, file.size), audio, art: audio ? mp4Artwork(info.moov) : null };
  }
  const key = `hashOf:${file.name}:${file.size}:${file.lastModified}`, kept = await store.getFile(key);
  const hash = kept?.hash ?? (await contentHash(blobReader(file), file.size, { onProgress }));
  if (!kept) await store.putFile(key, { hash });
  const picked = { file, info: { durationSec: 0, audioStartSec: 0, width: 0, height: 0 }, fingerprint: hashFingerprint(hash), audio: true,
    art: await audioArtwork(blobReader(file), file.size).catch(() => null) };
  mediaDuration(file).then((sec) => learnDuration(picked, sec));   // the player may know it first
  return picked;
}
/** A recording's length in seconds as the browser reads it (0 when it can't tell). */
function mediaDuration(file) {
  return new Promise((resolve) => {
    const a = document.createElement("audio"), url = URL.createObjectURL(file);
    let timer = 0;
    const done = () => {
      if (!timer) return;
      clearTimeout(timer);
      timer = 0;
      const sec = a.duration;
      a.removeAttribute("src");
      a.load();
      URL.revokeObjectURL(url);
      resolve(Number.isFinite(sec) ? sec : 0);
    };
    timer = setTimeout(done, 15000);
    a.preload = "metadata";
    a.addEventListener("loadedmetadata", done, { once: true });
    a.addEventListener("error", done, { once: true });
    a.src = url;
  });
}
/** A recording's length, once the browser has read it (its index entry may not have had it). */
function learnDuration(picked, sec) {
  if (!picked) return;
  if (!picked.info.durationSec && Number.isFinite(sec) && sec > 0) picked.info.durationSec = sec;
  if (S.picked?.info !== picked.info || S.durationMs || !picked.info.durationSec) return;
  S.durationMs = Math.round(picked.info.durationSec * 1000);
  if (S.rec.video) { S.rec.durationSec = picked.info.durationSec; save(); }
  if (S.pieces.length) rebuildEvents();
}

async function pickedVideo(file, { lookup = true } = {}) {
  const wanted = S.wanted;
  Object.assign(S, { videoFile: file, jsonFile: null, picked: null, wanted: null });
  W = null;
  stopPolling();
  renderGet();
  setStep("video", file.name, true);
  setStep("json", lookup ? "Looking for its transcript…" : "Choose its .json file", false);
  setProblems([]);
  updateStart();
  try {
    const probing = (S.picked = { file, pending: true });
    const picked = await probeMedia(file, (done, total) => { if (lookup && S.picked === probing) setStep("json", `Reading it… ${pct(done, total)}`, false); });
    if (S.picked !== probing) return;   // another file was picked meanwhile
    S.picked = picked;
    if (!lookup) return;
    setStep("json", "Looking for its transcript…", false);
    if (wanted?.video?.fingerprint && wanted.video.fingerprint !== S.picked.fingerprint) {
      toast(`That isn't “${wanted.title}”; looking for this ${noun(picked)}'s transcript.`);
    }
    const found = await findTranscript(picked);
    if (found?.ref) {
      setStep("json", found.label, true);
      const text = await transcriptFile(found.ref);
      if (!text) throw new Error("Its transcript isn't on this device, and GitHub can't be reached.");
      await openPair(JSON.parse(text), picked, found);
      if (S.picked === picked && !player.hidden && (await dbxReady)) trackVideo(picked, found.entry);   // offers Upload to Dropbox
      return;
    }
    await dbxReady;
    if (S.picked !== picked) return;
    if (!dbx) {   // transcripts can be made only through Dropbox
      setStep("json", gh ? "Not on GitHub yet: choose its .json file" : "Choose its .json file", false);
      return;
    }
    const status = entryStatus(found?.entry);
    setStep("json", status === "pending" ? "Being transcribed: see below" : status === "failed" ? "Its transcription failed: see below"
      : "No transcript yet: see below, or choose its .json file", false);
    trackVideo(picked, found?.entry, { welcome: true });
  } catch (err) {
    if (S.videoFile !== file) return;   // about a file picked before
    setStep("json", "Choose its .json file", false);
    setProblems([err.kind ? err.message : `Could not open this file: ${err.message}`]);
  }
}
function pickedJson(file) {
  S.jsonFile = file;
  setStep("json", file.name, true);
  setProblems([]);
  updateStart();
}

/** Where this video's transcript is: on GitHub (by fingerprint; by file name only after asking),
 *  or a lecture opened on this device before (this also works offline). {ref, key, label, entry};
 *  just {entry} while the repository's entry waits for its transcript (pending or failed). */
async function findTranscript({ file, fingerprint, audio }) {
  const mine = (await store.list()).find((r) => r.video?.fingerprint === fingerprint && r.transcriptRef);
  let entry = null;
  if (gh) {
    try {
      const videos = (await repoIndex()).videos || [];
      entry = videos.find((v) => v.fingerprint === fingerprint) || null;
      const byName = !entry && !mine && videos.find((v) => v.name === file.name && v.transcript);
      if (byName && confirm(`GitHub has a transcript for a ${audio ? "recording" : "video"} named “${file.name}”, but made from a different file. Use it anyway?`)) entry = byName;
    } catch (err) {
      if (!mine) throw err;
    }
  }
  if (entry?.transcript) return { ref: `gh:${gh.repo}:${entry.transcript}`, key: entry.key, label: "Found on GitHub", entry };
  if (mine) return { ref: mine.transcriptRef, key: mine.repoKey ?? null, label: "Opened on this device before", entry };
  return entry ? { entry } : null;
}
async function transcriptFile(ref) {
  if (gh && ref.startsWith(`gh:${gh.repo}:`)) return (await repoFile(ref.slice(`gh:${gh.repo}:`.length)))?.text ?? null;
  return (await store.getFile(ref))?.text ?? null;
}

$("startBtn").addEventListener("click", async () => {
  allowMedia();
  $("startBtn").disabled = true;
  try {
    const text = await S.jsonFile.text();
    const picked = S.picked?.file === S.videoFile && !S.picked.pending ? S.picked : (S.picked = await probeMedia(S.videoFile));
    await openPair(JSON.parse(text), picked, { ref: null, key: null, text });
    if (S.picked === picked && !player.hidden && W?.picked !== picked && (await dbxReady)) trackVideo(picked, null);
  } catch (err) {
    setProblems([`Could not open these files: ${err.message}`]);
    $("startBtn").disabled = false;
  }
});

/** Checks that the video and transcript belong together. Returns problems to show. sure: the
 *  repository matched them by content, so a different file name doesn't matter. */
function pairingProblems(data, picked, name, size, rec, sure) {
  const { info, fingerprint } = picked, out = [];
  if (!Array.isArray(data.tokens) || !data.tokens.length || !("start_ms" in data.tokens[0])) {
    return ["The transcript isn't a Soniox transcript JSON (no tokens with times)."];
  }
  if (info.height > info.width) {
    return ["This is a vertical video, probably one already rendered with subtitles. Pick the original video instead."];
  }
  if (!sure && data.video && data.video !== name) out.push(`This transcript was made for “${data.video}”, not “${name}”.`);
  const lastMs = data.tokens[data.tokens.length - 1].end_ms;
  if (info.durationSec && lastMs > info.durationSec * 1000 + 3000) {
    out.push(`The transcript is longer than the ${noun(picked)}: they probably don't belong together.`);
  }
  const other = rec.video && (rec.video.fingerprint && fingerprint ? rec.video.fingerprint !== fingerprint
    : rec.video.name !== name || rec.video.size !== size);
  if (other) out.push(`Last time this transcript was opened with “${rec.video.name}”.`);
  return out;
}

/** Opens a video with its transcript. picked: {file, info, fingerprint}, or a URL with name and
 *  size (a Dropbox stream, or development); src: where the transcript came from (ref, repository
 *  key, or the picked text; sure: matched by content, see pairingProblems). */
async function openPair(data, picked, src) {
  const name = picked.file?.name ?? picked.name, size = picked.file?.size ?? picked.size;
  const rec = await store.load(data.id || name);
  const issues = pairingProblems(data, picked, name, size, rec, src.sure);
  if (issues.length && (issues[0].startsWith("This is a vertical") || issues[0].startsWith("The transcript isn't"))) {
    setProblems(issues);
    $("startBtn").disabled = false;
    return;
  }
  if (issues.length && !confirm(issues.join("\n\n") + "\n\nOpen them anyway?")) {
    $("startBtn").disabled = false;
    return;
  }
  showVideo(picked, src.fromStart ? 0 : rec.position);
  await useTranscript(data, picked, src, rec);
  if (S.picked === picked && (src.coming?.play ?? true)) resume();   // a lecture opened plays at once (Stop's next one waits)
}

/** Shows the player with this video (subtitles come from useTranscript), resuming at resumeAt s. */
function showVideo(picked, resumeAt = 0) {
  const name = picked.file?.name ?? picked.name;
  stream = null;
  if (S.videoUrl?.startsWith("blob:")) URL.revokeObjectURL(S.videoUrl);
  S.videoUrl = picked.file ? URL.createObjectURL(picked.file) : picked.url;
  Object.assign(S, { picked, videoName: name, swapping: false, playing: false, folder: lectureFolder(picked) });
  upNext = null;   // the lecture after this one is fetched near its end
  setNotesOpen(false);   // they belong to the lecture before
  scope = null;          // openFromDropbox sets it
  noteInput.value = "";
  noteInput.style.height = "";
  draftAt = null;
  corsFor(picked);
  video.src = S.videoUrl;
  loadView();   // rotated, flipped, cropped as kept for it (laid out once its size is known)
  applyView();
  loadBg();
  applyRate(folderRate(S.folder), false);
  $("welcome").hidden = true;
  player.hidden = false;
  document.title = `${name.replace(/\.[^.]+$/, "")} · Lecture Karaoke`;
  $("barTitle").textContent = $("barTitle").title = name;
  updateChips();
  drawView();
  layout();
  resize();
  setLook();
  const dur = picked.info?.durationSec, quiet = document.hidden;
  S.startAt = resumeAt > 5 && !(dur && resumeAt >= dur - 10) ? resumeAt : 0;   // also where bg starts it (playHidden)
  video.addEventListener("loadedmetadata", () => {
    if (resumeAt > 5 && resumeAt < video.duration - 10) {
      video.currentTime = resumeAt;
      if (!quiet) toast(`Resumed at ${clock(resumeAt)}`, "Start over", () => (video.currentTime = 0));
    }
  }, { once: true });
}

/** The language whose words long sentences are split before, for a lecture in Dropbox at path: the
 *  one its folder's name gives ("…___vn"), if the app knows that language's words; else English. */
function folderSplitLanguage(path) {
  const code = path ? folderLanguage(path) : null;
  return code && CONJ_BY_LANGUAGE[code] ? code : "en";
}

/** Subtitles for the video on screen from this transcript (rec: its record on this device; entry:
 *  its index entry, when known). Also used when a transcript arrives while the video plays:
 *  playback is left as it is. */
async function useTranscript(data, picked, { ref, key, text, entry }, rec) {
  const { info, fingerprint } = picked, name = picked.file?.name ?? picked.name, size = picked.file?.size ?? picked.size;
  const id = data.id || name;
  Object.assign(S, {
    transcript: data, id, rec, repoKey: key ?? rec.repoKey ?? null,
    durationMs: Math.round(info.durationSec * 1000),
    // Soniox counts from the first audio sample; Safari and Chromium keep the MP4's leading empty
    // edit (the audio starts that much into the timeline), Firefox drops it.
    audioOffsetMs: isFirefox ? 0 : Math.round(info.audioStartSec * 1000),
    leadMs: prefs.offsetOn ? prefs.offsetMs : 0, syncMs: rec.syncMs ?? 0,
    language: rec.language ?? folderSplitLanguage(picked.dropbox?.path ?? entry?.dropbox?.path ?? rec.dropbox?.path),
    shown: -2, lastSecond: -1,
  });
  Object.assign(rec, {
    video: { name, size, fingerprint }, title: name.replace(/\.[^.]+$/, ""), durationSec: info.durationSec,
    lastOpened: Date.now(), hidden: false, repoKey: S.repoKey, transcriptRef: ref || `local:${id}`, dropbox: picked.dropbox ?? null,
  });
  if (!ref) await store.putFile(`local:${id}`, { text: text ?? JSON.stringify(data) });
  S.baseWords = wordsFromTranscript(data);
  S.words = applyFixes(S.baseWords, rec.fixes);
  await prepareFont([...new Set(S.words.map((w) => w.text).join(""))].join(""));
  rebuildLayout();
  updateChips();
  renderGet();
  save();
  if (gh) linkToRepo();
}

/** Plays a video that has no transcript yet; the subtitle area says what is happening, and the
 *  subtitles come when the transcript does. (Stop's next lecture, `coming`, waits for play.) */
function openWaiting(picked, coming = null) {
  showVideo(picked);
  Object.assign(S, { transcript: null, id: null, rec: {}, repoKey: null, baseWords: [], words: [], pieces: [], events: [],
    durationMs: Math.round(picked.info.durationSec * 1000), audioOffsetMs: isFirefox ? 0 : Math.round(picked.info.audioStartSec * 1000),
    shown: -2, lastSecond: -1 });
  draw(-1);
  renderGet();
  if (coming?.play ?? true) resume();
}

/** Ties the open lecture to its place in the repository: syncs its fixes, or first puts a
 *  transcript picked on this device there, for the other devices. */
async function linkToRepo() {
  const id = S.id, rec = S.rec, picked = S.picked, { info, fingerprint } = picked, name = S.videoName, data = S.transcript;
  try {
    if (!S.repoKey) {
      const index = await repoIndex();
      let entry = (index.videos || []).find((v) => v.fingerprint === fingerprint);
      if (!entry?.transcript) {   // not there, or still waiting for the job: this transcript is it
        const key = entry?.key ?? keyFor(name, fingerprint, index.videos), path = `transcripts/${key}.json`;
        const text = JSON.stringify({ ...data, video: name, video_size: picked.file?.size ?? picked.size, video_fingerprint: fingerprint,
          duration_ms: Math.round(info.durationSec * 1000) });
        if (!(await gh.write(path, text, null, `Add ${name} from the app`))) throw new Error(`${path} already exists on GitHub`);
        const copy = picked.dropbox ?? (W?.picked === picked && W.online ? W.online : entry?.dropbox ?? null);
        entry = indexEntry({ ...videoFields(picked), key, folder: copy ? folderOf(copy.path) : "", dropbox: copy, staged: null, skip_ms: 0,
          transcript: path, status: "ready", error: null, id: data.id ?? null, words: S.baseWords.length, updated: isoNow() });
        await gh.update("index.json", (cur) => withEntry(cur, entry), `Index ${name}`);
        await store.putFile(`gh:${gh.repo}:${path}`, { text });
        toast("Transcript saved to GitHub for your other devices");
      }
      Object.assign(rec, { repoKey: entry.key, transcriptRef: `gh:${gh.repo}:${entry.transcript}` });
      if (S.id !== id) return store.save(id, structuredClone(rec));
      S.repoKey = entry.key;
      save();
    }
    if (S.id === id) await syncFixes();
    if (S.id === id) await syncNotes();
  } catch (err) {
    if (err.kind !== "offline") toast(`Not saved to GitHub: ${err.message}`);
  }
}

// ---------------------------------------------------------------- getting a transcript
// A video picked on this device is looked up in Dropbox: a file of the same size, confirmed by its
// content hash. With a transcript it plays, and if it isn't in Dropbox it can be put there for the
// other devices. In Dropbox without a transcript, the job can transcribe it there. In neither, it
// can be uploaded to Dropbox (way B), or just its audio sent to the staging folder (way C). Either
// way the index gets a pending entry and the job is started at once (its scheduled runs would find
// the entry too). The video plays meanwhile; the index is checked every 20 s, and the subtitles
// appear when the transcript does.
let W = null;          // the video looked after: {picked, entry, online, checking, error, note, resume, welcome}
let transfer = null;   // the upload running (one at a time): {w, label, done, total, abort}
const uploads = { get: store.getFile, put: store.putFile, delete: store.deleteFile };   // unfinished uploads, kept by fingerprint
const el = (tag, props, ...children) => { const e = Object.assign(document.createElement(tag), props); e.append(...children); return e; };
const pct = (done, total) => `${total ? Math.floor((done / total) * 100) : 0}%`;

/** Starts looking after a video just opened or picked: whether it is in Dropbox, its unfinished
 *  uploads, and its index entry while it is being transcribed. w.online: {path, hash}; false;
 *  null when that can't be told (offline); undefined until known. */
async function trackVideo(picked, entry, { welcome = false } = {}) {
  if (!gh || !dbx) return;
  const w = W = { picked, entry: entry ?? null, online: picked.dropbox ?? undefined, checking: "", error: "", note: "", resume: {}, welcome };
  await loadResume(w);
  if (W !== w) return;
  if (entryStatus(w.entry) === "pending") startPolling();
  if (w.online === undefined) await checkDropbox(w);
  if (W !== w) return;
  renderGet();
  if (!welcome && S.transcript && S.picked === picked && w.online === false && picked.file) {
    toast(`This ${noun(picked)} isn't in Dropbox: upload it to stream it on your other devices.`, "Upload", () => askUpload(w));
  }
}
async function loadResume(w) {
  for (const kind of ["video", "audio"]) w.resume[kind] = await store.getFile(`upload:${w.picked.fingerprint}:${kind}`);
}

/** Looks for the video in Dropbox: files of the same size (the same name first) must also have
 *  its content hash, computed from the file once and kept. */
async function checkDropbox(w) {
  const { picked } = w, size = picked.file?.size ?? picked.size, name = picked.file?.name ?? picked.name;
  w.checking = "Looking in Dropbox…";
  renderGet();
  try {
    const { files, offline } = await dropboxFiles(true);
    const same = files.filter((f) => f.size === size && MEDIA_FILE.test(f.name) && !f.path_lower.startsWith(STAGING))
      .sort((a, b) => (b.name === name) - (a.name === name));
    let found = (w.entry?.dropbox?.hash && same.find((f) => f.content_hash === w.entry.dropbox.hash)) || null;
    if (!found && same.length && picked.file) {
      const hash = await localHash(w);
      found = same.find((f) => f.content_hash === hash) || null;
    }
    w.online = found ? { path: found.path_display, hash: found.content_hash } : offline || (same.length && !picked.file) ? null : false;
  } catch (err) {
    w.online = null;
    if (err.kind !== "offline") w.error = err.message;
  }
  w.checking = "";
}
/** The file's Dropbox content hash: it reads the whole file, once (kept by fingerprint). A
 *  recording's fingerprint other than an MP4's is that hash. */
async function localHash(w) {
  if (w.picked.fingerprint.startsWith("fa1-")) return w.picked.fingerprint.slice(4);
  const file = w.picked.file, key = `hash:${w.picked.fingerprint}`, kept = await store.getFile(key);
  if (kept?.hash && kept.size === file.size) return kept.hash;
  const hash = await contentHash(blobReader(file), file.size, { onProgress: (done, total) => {
    w.checking = `Comparing with the copy in Dropbox… ${pct(done, total)}`;
    drawLive();
  } });
  await store.putFile(key, { hash, size: file.size });
  return hash;
}

/** The index fields that describe the video itself. */
function videoFields(picked) {
  const { info, fingerprint } = picked;
  return { name: picked.file?.name ?? picked.name, size: picked.file?.size ?? picked.size, fingerprint,
    duration_ms: Math.round(info.durationSec * 1000), audio_start_ms: Math.round(info.audioStartSec * 1000), width: info.width, height: info.height };
}

/** Runs an action for the video; from the start screen the video opens first, to watch meanwhile. */
function startAction(w, action) {
  if (player.hidden && S.picked === w.picked) {
    w.welcome = false;
    openWaiting(w.picked);
  }
  action(w).catch((err) => { w.error = err.message; renderGet(); });
}

/** Puts the video in the index as waiting for its transcript (unless it has one by now, or the Mac
 *  or the job is transcribing it already) and starts the job for it; if the job can't be started
 *  from here, its next scheduled run finds the entry. */
async function startJob(w, fields) {
  let entry = null;
  await gh.update("index.json", (cur) => {
    const videos = cur?.videos || [], had = videos.find((v) => v.fingerprint === fields.fingerprint);
    // one being transcribed names its worker ("mac" or "github"): a new entry would drop that claim,
    // and the video could be transcribed (and paid for) twice
    if (had?.transcript || (had?.worker && entryStatus(had) === "pending")) { entry = had; return undefined; }
    entry = indexEntry({ ...fields, key: keyFor(fields.name, fields.fingerprint, videos), transcript: null,
      status: "pending", error: null, id: null, words: null, updated: isoNow() });
    return withEntry(cur, entry);
  }, `Transcribe ${fields.name}`);
  Object.assign(w, { entry, note: "", error: "" });
  if (entry.transcript) return transcriptArrived(w);
  if (!entry.worker) {
    try {
      await gh.dispatch(entry.key);
    } catch (err) {
      w.note = `${err.message} Its next scheduled run will transcribe it.`;
    }
  }
  startPolling();
  renderGet();
  loadLibrary(true);   // it may be a file just put in Dropbox
}

/** In Dropbox without a transcript: the job transcribes it from there. */
const transcribeInDropbox = (w) => startJob(w, { ...videoFields(w.picked), folder: folderOf(w.online.path), dropbox: w.online, staged: null, skip_ms: 0 });

/** Way B: the video goes to Dropbox, in a course folder; the job transcribes it there, and the other
 *  devices can stream it. An interrupted upload continues where it stopped (same path). */
async function uploadVideo(w, folder) {
  const { picked } = w, file = picked.file;
  const path = w.resume.video?.path ?? `/${folder ? `${folder}/` : ""}${file.name}`;
  await transferFor(w, "Uploading to Dropbox", async (signal, progress) => {
    const { metadata, hash } = await dbx.upload({ size: file.size, read: blobReader(file) }, path,
      { key: `upload:${picked.fingerprint}:video`, saved: uploads, onProgress: progress, signal });
    await store.putFile(`hash:${picked.fingerprint}`, { hash, size: file.size });
    w.online = { path: metadata.path_display, hash };
    const status = entryStatus(w.entry);
    if (status === "ready" || status === "pending" || (S.picked === picked && S.transcript)) {
      await placeInIndex(w);   // it has (or is getting) its transcript: the index learns where the video is
      toast(`Uploaded to Dropbox: ${metadata.path_display}`);
    } else {
      await startJob(w, { ...videoFields(picked), folder: folderOf(metadata.path_display), dropbox: w.online, staged: null, skip_ms: 0 });
    }
  });
}
/** Notes in the video's index entry where it is in Dropbox (without an entry, linkToRepo adds one with it). */
async function placeInIndex(w) {
  const fp = w.picked.fingerprint, { path, hash } = w.online;
  await gh.update("index.json", (cur) => {
    const e = (cur?.videos || []).find((v) => v.fingerprint === fp);
    if (!e || (e.dropbox?.hash === hash && e.dropbox?.path === path)) return undefined;
    return withEntry(cur, (w.entry = changedEntry(e, { folder: folderOf(path), dropbox: { path, hash }, updated: isoNow() })));
  }, `${videoFields(w.picked).name} is in Dropbox`);
  loadLibrary(true);
}

/** Way C: only the audio goes to Dropbox, copied out of the video (about 1 MB a minute), into the
 *  staging folder that the job empties; the video stays on this device. */
async function transcribeOnly(w) {
  const { picked } = w, file = picked.file, staged = `${STAGING}${picked.fingerprint}.aac`;
  await transferFor(w, "Copying the audio", async (signal, progress) => {
    const { blob, skipMs } = await extractAdts(blobReader(file), picked.info,
      { signal, onProgress: (done, total) => progress(done, total, "Copying the audio") });
    await dbx.upload({ size: blob.size, read: blobReader(blob) }, staged, { key: `upload:${picked.fingerprint}:audio`, saved: uploads,
      mode: "overwrite", signal, onProgress: (done, total) => progress(done, total, "Sending the audio") });
    await startJob(w, { ...videoFields(picked), folder: "", dropbox: null, staged, skip_ms: skipMs });
  });
}

// While a transfer runs, the browser asks before the page is closed.
const leaving = (e) => { e.preventDefault(); e.returnValue = ""; };
async function transferFor(w, label, work) {
  if (transfer) throw new Error("Another upload is running; wait for it to finish.");
  const t = transfer = { w, label, done: 0, total: 0, abort: new AbortController() };
  addEventListener("beforeunload", leaving);
  w.error = "";
  renderGet();
  try {
    await work(t.abort.signal, (done, total, now = t.label) => { Object.assign(t, { done, total, label: now }); drawLive(); });
  } catch (err) {
    if (!t.abort.signal.aborted) throw err;   // stopped: the next try continues where it was
  } finally {
    transfer = null;
    removeEventListener("beforeunload", leaving);
    await loadResume(w);
    renderGet();
  }
}

// The index is read every 20 s while the video waits for its transcript.
let pollTimer = 0;
function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(() => { if (W) pollTranscript(W); }, POLL_MS);
}
function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = 0;
}
async function pollTranscript(w) {
  if (w.polling) return;
  w.polling = true;
  try {
    const entry = ((await repoIndex()).videos || []).find((v) => v.fingerprint === w.picked.fingerprint) || null;
    if (W !== w) return;
    const before = entryStatus(w.entry);
    w.entry = entry;
    const now = entryStatus(entry);
    if (now !== "pending") stopPolling();
    if (now === "ready") await transcriptArrived(w);
    else if (now !== before) renderGet();
  } catch { /* offline, or GitHub busy: next time */ } finally {
    w.polling = false;
  }
}
/** The job made the transcript: the subtitles appear while the video plays on (on the start
 *  screen, the box offers to play it). */
async function transcriptArrived(w) {
  const { entry, picked } = w, ref = `gh:${gh.repo}:${entry.transcript}`;
  if (!player.hidden && S.picked === picked && !S.transcript) {
    const text = await transcriptFile(ref);
    if (!text || W !== w || S.picked !== picked || S.transcript) return;
    const data = JSON.parse(text);
    await useTranscript(data, picked, { ref, key: entry.key, entry }, await store.load(data.id || videoFields(picked).name));
    toast("The subtitles are ready");
  }
  renderGet();
}
/** From the start screen, once the transcript is there. */
async function openReady(w) {
  allowMedia();   // its Play button
  const ref = `gh:${gh.repo}:${w.entry.transcript}`, text = await transcriptFile(ref);
  if (!text) return toast("Its transcript can't be downloaded right now.");
  await openPair(JSON.parse(text), w.picked, { ref, key: w.entry.key, sure: true, entry: w.entry });
}

// Way B asks for the course folder (the last one used is offered, and the folders in Dropbox).
let uploadFor = null;
function askUpload(w) {
  if (w.resume.video) return startAction(w, (x) => uploadVideo(x, null));   // continues to the same place
  const { name, size } = videoFields(w.picked);
  $("uploadWhat").textContent = `“${name}” (${mb(size)}) goes to your Dropbox, in Apps/Lecture Karaoke, in this folder:`;
  $("uploadFolder").value = prefs.uploadFolder;
  $("uploadFolders").replaceChildren(...[...new Set(library.items.map((i) => i.folder).filter(Boolean))]
    .map((f) => el("option", { value: f })));
  uploadFor = w;
  $("uploadDialog").returnValue = "";
  $("uploadDialog").showModal();
}
/** A folder name as typed, made a Dropbox path inside the app folder: null if it can't be one. */
function cleanFolder(text) {
  const parts = text.replaceAll("\\", "/").split("/").map((p) => p.trim()).filter(Boolean);
  return parts.some((p) => p.startsWith(".") || /[\u0000-\u001f]/.test(p)) ? null : parts.join("/");
}
$("uploadCancel").addEventListener("click", () => $("uploadDialog").close("cancel"));
$("uploadDialog").addEventListener("close", () => {
  const w = uploadFor;
  uploadFor = null;
  if ($("uploadDialog").returnValue !== "upload" || !w) return;
  const folder = cleanFolder($("uploadFolder").value);
  if (folder === null) return toast("That folder name can't be used (no names starting with a dot).");
  prefs.uploadFolder = folder;
  savePrefs();
  startAction(w, (x) => uploadVideo(x, folder));
});

function button(text, onClick, cls = "") {
  const b = el("button", { type: "button", textContent: text, className: cls });
  b.addEventListener("click", onClick);
  return b;
}
/** What the box for W says and offers; where: "welcome" (the start screen), "player" (over the
 *  empty subtitle area) or "settings". */
function getNodes(w, where) {
  const shown = !player.hidden && S.picked === w.picked && S.transcript;   // its subtitles are on screen, whatever the index says yet
  const out = [], status = shown ? "ready" : entryStatus(w.entry), file = w.picked.file, t = transfer?.w === w ? transfer : null;
  const said = (text, cls = "") => text && out.push(el("p", { textContent: text, className: cls }));
  const actions = (...buttons) => out.push(el("div", { className: "get-actions" }, ...buttons.filter(Boolean)));
  const resumed = (kind, label) => (w.resume[kind] ? `${label} · ${pct(w.resume[kind].offset, w.resume[kind].size)}` : null);
  if (t) {
    out.push(el("p", { className: "live-xfer" }), el("progress", { className: "live-bar" }));
    actions(button("Stop", () => t.abort.abort()));
    if (where !== "settings") said("Keep this page open until it's done. If it stops, it continues from where it was.", "small");
  }
  if (w.checking) out.push(el("p", { className: "live-checking" }));
  if (w.error) said(w.error, "get-error");
  if (status === "ready") {
    if (where === "welcome") { said("Its transcript is ready."); actions(button("Play", () => openReady(w), "primary")); }
    else if (w.online) { if (where === "settings") said(`In Dropbox: ${w.online.path}`, "small"); }
    else if (w.online === false && file && !t) {
      said(`This ${noun(w.picked)} isn't in Dropbox: upload it to stream it on your other devices.`, "small");
      actions(button(resumed("video", "Resume upload") ?? "Upload to Dropbox", () => askUpload(w)));
    }
  } else if (status === "pending" && !t) {
    said(w.entry.worker === "mac" ? "Being transcribed on the Mac."
      : w.entry.staged && !w.entry.dropbox ? "Its audio is being transcribed on GitHub." : "Being transcribed on GitHub.");
    said(where === "settings" ? "" : where === "welcome" ? "Play it meanwhile: the subtitles appear when it's done, usually a few minutes after the job starts."
      : "The subtitles appear here when it's done, usually a few minutes after the job starts.", "small");
    if (w.note) said(w.note, "small");
  } else if (!t) {
    if (status === "failed") said(`The transcription failed${w.entry.error ? `: ${w.entry.error}` : "."}`, "get-error");
    if (w.online) {
      said(w.picked.dropbox ? "It has no transcript yet." : `It's in Dropbox (${w.online.path}) but has no transcript yet.`);
      actions(button(status === "failed" ? "Try again" : "Transcribe", () => startAction(w, transcribeInDropbox), "primary"));
    } else if (w.online === false && file && w.picked.audio) {   // its audio is the whole file: no Transcribe only
      said("It has no transcript yet. Upload it to Dropbox: it is transcribed there, and your other devices can stream it.");
      actions(button(resumed("video", "Resume upload") ?? "Upload to Dropbox", () => askUpload(w), "primary"));
    } else if (w.online === false && file) {
      said("It has no transcript yet. Upload to Dropbox: it is transcribed there, and your other devices can stream it. " +
        "Transcribe only: just its audio is sent, about 1 MB a minute; the video stays on this device.");
      actions(button(resumed("video", "Resume upload") ?? "Upload to Dropbox", () => askUpload(w), "primary"),
        button(resumed("audio", "Transcribe only") ?? "Transcribe only", () => startAction(w, transcribeOnly)));
    } else if (w.online === null) {
      said(`Dropbox can't be reached right now, so this ${noun(w.picked)} can't be transcribed yet.`);
      actions(button("Try again", async () => { w.error = ""; await checkDropbox(w); renderGet(); }));
    }
  }
  if (where === "welcome" && status !== "ready") actions(button("Play without subtitles", () => { w.welcome = false; openWaiting(w.picked); }));
  return out;
}

/** Draws W's box wherever it shows: the start screen, the empty subtitle area, and settings. */
function renderGet() {
  const w = W, mine = !!w && S.picked === w.picked;
  const welcome = mine && w.welcome && player.hidden, waiting = !player.hidden && !S.transcript, set = mine && !player.hidden && !!S.transcript;
  $("getBox").hidden = !welcome;
  $("getBox").replaceChildren(...(welcome ? getNodes(w, "welcome") : []));
  $("waitBox").hidden = !waiting;
  $("waitBox").replaceChildren(...(!waiting ? [] : mine ? getNodes(w, "player")
    : [el("p", { textContent: `No transcript for this ${noun(S.picked)} yet.` })]));
  $("dbxSet").hidden = !set;
  $("dbxBox").replaceChildren(...(set ? getNodes(w, "settings") : []));
  drawLive();
}
/** The parts that change while work runs, updated in place (the buttons beside them stay put
 *  under a finger); and the line at the top when no box on screen shows the transfer. */
function drawLive() {
  const t = transfer, text = t ? `${t.label}… ${pct(t.done, t.total)}${t.total ? ` of ${mb(t.total)}` : ""}` : "";
  for (const p of document.querySelectorAll(".live-xfer")) p.textContent = text;
  for (const b of document.querySelectorAll(".live-bar")) Object.assign(b, { max: t?.total || 1, value: t?.done || 0 });
  for (const p of document.querySelectorAll(".live-checking")) p.textContent = W?.checking || "";
  const shown = [...document.querySelectorAll(".live-bar")].some((b) => b.getClientRects().length);
  $("transferLine").hidden = !t || shown;
  $("transferText").textContent = text;
}
$("transferStop").addEventListener("click", () => transfer?.abort.abort());

// ---------------------------------------------------------------- recent lectures
async function drawRecent() {
  const recs = (await store.list()).filter((r) => r.lastOpened && r.video && !r.hidden)
    .sort((a, b) => b.lastOpened - a.lastOpened).slice(0, 3);
  $("recent").hidden = !recs.length;
  $("recentList").replaceChildren(...recs.map((r) => {
    const li = document.createElement("li");
    const open = Object.assign(document.createElement("button"), { type: "button", className: "recent-open" });
    open.append(Object.assign(document.createElement("span"), { className: "recent-title", textContent: r.title || r.video.name }),
      Object.assign(document.createElement("span"), { className: "recent-meta",
        textContent: `${clock(r.position || 0)} of ${clock(r.durationSec)} · ${ago(r.lastOpened)}${r.dropbox ? " · Dropbox" : ""}` }));
    // A video streamed from Dropbox streams again. Safari can't reopen a file by itself: the tap
    // opens the picker (its Recents has the video).
    open.addEventListener("click", async () => {
      if (r.dropbox && (await dbxReady)) {
        if (!library.items.length) await loadLibrary();
        const it = library.items.find((i) => i.hash === r.dropbox.hash)
          || library.items.find((i) => i.path.toLowerCase() === r.dropbox.path.toLowerCase());
        if (it) return openFromDropbox(it);
      }
      S.wanted = r;
      setStep("video", `Pick “${r.video.name}”`, false);
      $("pickVideo").click();
    });
    const del = Object.assign(document.createElement("button"), { type: "button", className: "recent-del", textContent: "✕" });
    del.setAttribute("aria-label", `Remove ${r.title || r.video.name} from this list`);
    del.addEventListener("click", async () => {
      const { id, ...rest } = r;
      await store.save(id, { ...rest, hidden: true });
      drawRecent();
    });
    li.append(open, del);
    return li;
  }));
}
function ago(t) {
  const min = Math.round((Date.now() - t) / 60000), h = Math.round(min / 60), d = Math.round(h / 24);
  return min < 1 ? "just now" : min < 60 ? `${min} min ago` : h < 24 ? `${h} h ago` : d === 1 ? "yesterday"
    : d < 30 ? `${d} days ago` : new Date(t).toLocaleDateString();
}

// ---------------------------------------------------------------- subtitle layout and timing
function rebuildLayout() {
  widths.clear();
  const opts = { fitW: FIT_EM, conj: CONJ_BY_LANGUAGE[S.language] || new Set(), ctxScale: CTX_SCALE };
  S.pieces = buildPieces(S.words, measurer(), opts);
  rebuildEvents();
}
function rebuildEvents() {
  S.events = buildEvents(S.pieces, { leadMs: S.leadMs, durationMs: S.durationMs || Infinity, shiftMs: S.audioOffsetMs + S.syncMs });
  S.shown = -2;
  render();
}

/** The subtitle size: the burned video's proportions, as large as the panel allows. */
function resize() {
  const r = panel.getBoundingClientRect();
  if (!r.width || !r.height) return;
  panel.style.setProperty("--em", `${Math.min(r.width / FRAME_EM, r.height / PANEL_EM)}px`);
}
new ResizeObserver(resize).observe(panel);

// ---------------------------------------------------------------- screen split: video / subtitles
const landscapeMQ = matchMedia("(orientation: landscape)");
const orient = () => (landscapeMQ.matches ? "landscape" : "portrait");
/** The space the video and the subtitles share (the player without the control bar), in px. */
function area() {
  const cs = getComputedStyle(player);
  return {
    w: player.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
    h: player.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) - bar.offsetHeight,
  };
}
/** The video's share of that space: the viewer's choice, else the full width in portrait and
 *  60% (50% on short screens) in landscape. */
function videoShare(o = orient(), a = area()) {
  const [lo, hi] = SPLIT_RANGE[o];
  const auto = o === "landscape" ? (innerHeight <= 520 ? 0.5 : 0.6) : (a.w * 9) / 16 / a.h;
  return clamp(prefs.split[o] ?? auto, lo, hi);
}
function layout() {
  const a = area();
  if (player.hidden || a.w <= 0 || a.h <= 0) return;
  const o = orient();
  player.style.setProperty("--video-size", `${Math.round(videoShare(o, a) * (o === "landscape" ? a.w : a.h))}px`);
  player.style.setProperty("--bar-h", `${bar.offsetHeight}px`);   // the notes reach down to the bar
  if ($("settings").open) syncSplitControls();
}
new ResizeObserver(layout).observe(player);
new ResizeObserver(layout).observe(bar);      // the bar's height depends on its arrangement

function setSplit(share) {
  prefs.split[orient()] = share;
  layout();
}
const splitter = $("splitter");
splitter.addEventListener("pointerdown", (e) => {
  if (e.button > 0) return;
  e.preventDefault();
  const o = orient(), a = area(), across = o === "landscape", [lo, hi] = SPLIT_RANGE[o];
  const total = across ? a.w : a.h, from = across ? e.clientX : e.clientY, size = videoShare(o, a) * total;
  const stop = new AbortController();
  let moved = false;
  splitter.setPointerCapture(e.pointerId);
  splitter.classList.add("dragging");
  splitter.addEventListener("pointermove", (ev) => {
    const delta = (across ? ev.clientX : ev.clientY) - from;
    moved ||= Math.abs(delta) > 3;
    setSplit(clamp((size + delta) / total, lo, hi));
  }, { signal: stop.signal });
  const end = () => {
    stop.abort();
    splitter.classList.remove("dragging");
    savePrefs();
    if (!moved) return;
    // A mouse released over the video would also "click" it (play/pause): swallow that click.
    const swallow = (c) => { c.stopPropagation(); c.preventDefault(); };
    addEventListener("click", swallow, { capture: true, once: true });
    setTimeout(() => removeEventListener("click", swallow, { capture: true }), 0);
  };
  splitter.addEventListener("pointerup", end, { signal: stop.signal });
  splitter.addEventListener("pointercancel", end, { signal: stop.signal });
});
splitter.addEventListener("dblclick", () => { setSplit(null); savePrefs(); });

// ---------------------------------------------------------------- the picture: rotated, flipped, cropped
// Some videos were recorded on their side: ⋯ Settings → Video picture rotates the picture a quarter
// turn at a time and flips it (left to right, top to bottom), as seen. The bar's crop button (beside
// the hide button) draws a box over the whole picture: drag the box, its sides or its corners, or drag
// across the picture for a new one; a second tap on the button crops to it. Rotate and flip are there
// too, and Cancel leaves things as they were. Kept on this device for each video (by its fingerprint)
// from one session to the next. Settings can leave the crop out for now: the whole frame shows until
// the video is opened again. Only a rotated, flipped or cropped picture is laid out here; otherwise the
// video fills its box as before.
const VIEWS_KEY = "lecture-karaoke.views", FULL_FRAME = [0, 0, 1, 1], MIN_CROP = 0.08;
let view = { rot: 0, fh: false, fv: false, crop: null };   // crop: [x, y, w, h] of the picture as seen (rotated and flipped), 0..1
let wholeFrame = false;   // the crop left out for now
let cropping = null;   // while the box is drawn: {box: [x, y, w, h], before: the view as it was}
const plainView = (v) => !v.rot && !v.fh && !v.fv && !v.crop;
/** What the view is kept by: the video's fingerprint (the same video streamed or on the device). */
function viewKey(p = S.picked) {
  if (!p) return null;
  return p.fingerprint || (p.dropbox?.hash ? `dbx:${p.dropbox.hash}` : `file:${p.file?.name ?? p.name}:${p.file?.size ?? p.size}`);
}
function storedViews() {
  try { return JSON.parse(localStorage.getItem(VIEWS_KEY) || "{}") || {}; } catch { return {}; }
}
/** A crop that is possible (at least MIN_CROP each way, within the picture), or null for the whole frame. */
function cleanCrop(c) {
  if (!Array.isArray(c) || c.length !== 4 || !c.every(Number.isFinite)) return null;
  const w = clamp(c[2], MIN_CROP, 1), h = clamp(c[3], MIN_CROP, 1);
  return w > 0.995 && h > 0.995 ? null : [clamp(c[0], 0, 1 - w), clamp(c[1], 0, 1 - h), w, h];
}
/** The open video's view, as kept for it (a new video opens with its crop shown, not the box). */
function loadView() {
  const v = storedViews()[viewKey()] || {};
  view = { rot: [90, 180, 270].includes(v.rot) ? v.rot : 0, fh: !!v.fh, fv: !!v.fv, crop: cleanCrop(v.crop) };
  wholeFrame = false;
  endCropping();
}
function keepView() {
  const key = viewKey();
  if (!key) return;
  const all = storedViews();
  if (plainView(view)) delete all[key];
  else all[key] = { ...view, name: S.videoName, at: Date.now() };
  try { localStorage.setItem(VIEWS_KEY, JSON.stringify(all)); } catch { /* not kept */ }
}
/** Rotates the picture a quarter turn as seen (1: clockwise, -1: the other way) or flips it as seen
 *  ("h": left to right, "v": top to bottom). The crop (and the box being drawn) goes with it, so that
 *  it keeps the same part of the picture. Kept at once, unless the box is being drawn (the crop
 *  button keeps it, Cancel undoes it). */
function turnView(how) {
  const move = (r) => {
    if (!r) return r;
    const [x, y, w, h] = r;
    return how === 1 ? [1 - y - h, x, h, w] : how === -1 ? [y, 1 - x - w, h, w] : how === "h" ? [1 - x - w, y, w, h] : [x, 1 - y - h, w, h];
  };
  if (how === "h") view.fh = !view.fh;
  else if (how === "v") view.fv = !view.fv;
  else view.rot = (view.rot + (view.fh !== view.fv ? -how : how) * 90 + 360) % 360;   // after one flip, a turn goes the other way
  view.crop = move(view.crop);
  if (cropping) cropping.box = move(cropping.box);
  else keepView();
  applyView();
  drawView();
}
/** Lays the picture out in its box: rotated and flipped, and its crop as large as the box allows,
 *  in its middle. While the box is drawn, the whole picture shows, with the box over it. */
function applyView() {
  const bw = videoBox.clientWidth, bh = videoBox.clientHeight, vw = video.videoWidth, vh = video.videoHeight;
  const picture = !player.hidden && hasPicture() && vw > 0 && vh > 0 && bw > 0 && bh > 0;
  const crop = cropping || wholeFrame ? null : view.crop;
  const custom = picture && !!(cropping || view.rot || view.fh || view.fv || crop);
  videoBox.classList.toggle("turned", custom);
  $("cropLayer").hidden = !(custom && cropping);
  if (!custom) {
    for (const k of ["position", "left", "top", "width", "height", "objectFit", "transform", "clipPath", "webkitClipPath"]) video.style[k] = "";
    return;
  }
  const turned = view.rot % 180 !== 0, fw = turned ? vh : vw, fh = turned ? vw : vh;   // the picture as seen
  const [cx, cy, cw, ch] = crop || FULL_FRAME;
  const s = Math.min(bw / (cw * fw), bh / (ch * fh));
  const midX = bw / 2 + (0.5 - cx - cw / 2) * fw * s, midY = bh / 2 + (0.5 - cy - ch / 2) * fh * s;   // the picture's middle
  const pct = (v) => `${(v * 100).toFixed(3)}%`, [lx, ly, lw, lh] = crop ? unturned(crop) : FULL_FRAME;
  const clip = crop ? `inset(${pct(ly)} ${pct(1 - lx - lw)} ${pct(1 - ly - lh)} ${pct(lx)})` : "";   // only the crop shows
  Object.assign(video.style, {
    position: "absolute", left: `${midX - (vw * s) / 2}px`, top: `${midY - (vh * s) / 2}px`, width: `${vw * s}px`, height: `${vh * s}px`,
    objectFit: "fill", transform: `scale(${view.fh ? -1 : 1}, ${view.fv ? -1 : 1}) rotate(${view.rot}deg)`, clipPath: clip, webkitClipPath: clip,
  });
  if (cropping) {
    Object.assign($("cropLayer").style, { left: `${midX - (fw * s) / 2}px`, top: `${midY - (fh * s) / 2}px`, width: `${fw * s}px`, height: `${fh * s}px` });
    drawCropBox();
  }
}
/** A rectangle of the picture as seen, in the video's own terms (before it is rotated and flipped). */
function unturned([x, y, w, h]) {
  if (view.fh) x = 1 - x - w;
  if (view.fv) y = 1 - y - h;
  for (let k = 0; k < view.rot / 90; k++) [x, y, w, h] = [y, 1 - x - w, h, w];   // a quarter turn back
  return [x, y, w, h];
}
new ResizeObserver(() => applyView()).observe(videoBox);
video.addEventListener("loadedmetadata", () => { applyView(); drawView(); });
function drawCropBox() {
  const [x, y, w, h] = cropping.box;
  Object.assign($("cropBox").style, { left: `${x * 100}%`, top: `${y * 100}%`, width: `${w * 100}%`, height: `${h * 100}%` });
}
/** The bar's crop button: draw the box over the whole picture, or (the second tap) crop to it. */
function cropTap() {
  if (player.hidden || !hasPicture()) return;
  if (!cropping) {
    cropping = { box: [...(view.crop || FULL_FRAME)], before: structuredClone(view) };
    $("cropTools").hidden = false;
  } else {
    view.crop = cleanCrop(cropping.box);
    wholeFrame = false;
    endCropping();
    keepView();
  }
  applyView();
  drawView();
}
/** Cancel: the view as it was before the box was drawn. */
function cancelCropping() {
  if (!cropping) return;
  view = cropping.before;
  endCropping();
  applyView();
  drawView();
}
function endCropping() {
  cropping = null;
  $("cropTools").hidden = true;
}
const CROP_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 2.5v13a2 2 0 0 0 2 2h13M2.5 6.5h13a2 2 0 0 1 2 2v13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const APPLY_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 12.5l5 5 10-11" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
/** The crop button (lit while the picture is cropped; ✓ while the box is drawn) and ⋯ Settings → Video picture. */
function drawView() {
  const can = !player.hidden && !!S.picked && hasPicture(), b = $("cropBtn");
  b.disabled = !can;
  b.innerHTML = cropping ? APPLY_SVG : CROP_SVG;
  b.setAttribute("aria-pressed", String(!!cropping));
  b.setAttribute("aria-label", cropping ? "Crop to the box" : "Crop");
  b.title = cropping ? "Crop to the box" : !view.crop ? "Crop: draw a box on the picture" : "Cropped: tap to draw the box again";
  // the bar's crop to the box (Settings has it too): lit while cropped; a tap shows the whole frame, another crops again
  const pk = $("peekBtn"), peekable = can && !!view.crop && !cropping;
  pk.hidden = !peekable && !arranging;   // only for a cropped video (and while the bar is arranged)
  pk.disabled = !peekable && !arranging;
  pk.setAttribute("aria-pressed", String(!!view.crop && !wholeFrame));
  pk.title = !view.crop ? "Crop to the box: for a cropped video" : wholeFrame ? "The whole frame for now (tap: crop to the box again)" : "Cropped to the box (tap: the whole frame for now)";
  fitTitleLine();
  $("viewSet").hidden = !can;
  for (const id of ["flipH", "cropFlipH"]) $(id).setAttribute("aria-pressed", String(view.fh));
  for (const id of ["flipV", "cropFlipV"]) $(id).setAttribute("aria-pressed", String(view.fv));
  $("viewCrop").checked = !!view.crop && !wholeFrame;
  $("viewCrop").disabled = !view.crop;
  $("cropRemove").disabled = !view.crop;
  $("viewReset").disabled = plainView(view);
  const parts = [view.rot && `rotated ${view.rot}°`, view.fh && "flipped left to right", view.fv && "flipped top to bottom",
    view.crop && (wholeFrame ? "cropped (the whole frame for now)" : "cropped")].filter(Boolean);
  $("viewSays").textContent = `${parts.length ? `This video: ${parts.join(", ")}.` : "This video shows as it is."} Kept on this device for this video.`;
}
$("cropBtn").addEventListener("click", cropTap);
const PEEK_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="4.5" width="19" height="15" rx="2" fill="none" stroke="currentColor" stroke-width="1.7" stroke-dasharray="2.6 2.2"/><rect x="7.5" y="9" width="9" height="6" rx="1" fill="currentColor"/></svg>`;
$("peekBtn").innerHTML = PEEK_SVG;
$("peekBtn").addEventListener("click", () => {
  if (!view.crop || cropping) return;
  wholeFrame = !wholeFrame;   // for now: the crop is back when the video is opened again
  applyView();
  drawView();
});
$("cropWhole").addEventListener("click", () => { if (cropping) { cropping.box = [...FULL_FRAME]; drawCropBox(); } });
$("cropCancel").addEventListener("click", cancelCropping);
for (const [id, how] of [["turnLeft", -1], ["turnRight", 1], ["flipH", "h"], ["flipV", "v"],
  ["cropTurnLeft", -1], ["cropTurnRight", 1], ["cropFlipH", "h"], ["cropFlipV", "v"]]) $(id).addEventListener("click", () => turnView(how));
$("viewCrop").addEventListener("change", () => { wholeFrame = !$("viewCrop").checked; applyView(); drawView(); });
$("cropRemove").addEventListener("click", () => { view.crop = null; wholeFrame = false; keepView(); applyView(); drawView(); });
$("viewReset").addEventListener("click", () => {
  view = { rot: 0, fh: false, fv: false, crop: null };
  wholeFrame = false;
  endCropping();
  keepView();
  applyView();
  drawView();
});
// Drawing the box: drag it to move it, a side or a corner to resize it, or across the picture for a new one.
$("cropLayer").addEventListener("pointerdown", (e) => {
  if (!cropping || e.button > 0) return;
  e.preventDefault();
  const layer = $("cropLayer"), r = layer.getBoundingClientRect(), start = [...cropping.box];
  const at = (ev) => [clamp((ev.clientX - r.left) / r.width, 0, 1), clamp((ev.clientY - r.top) / r.height, 0, 1)];
  const [px, py] = at(e), part = e.target.dataset.h || (e.target === $("cropBox") ? "move" : "new");
  const stop = new AbortController();
  layer.setPointerCapture(e.pointerId);
  layer.addEventListener("pointermove", (ev) => {
    if (!cropping) return;
    const [qx, qy] = at(ev), dx = qx - px, dy = qy - py;
    let [x, y, w, h] = start;
    if (part === "move") {
      x = clamp(x + dx, 0, 1 - w);
      y = clamp(y + dy, 0, 1 - h);
    } else if (part === "new") {
      if (Math.abs(dx) < 0.02 && Math.abs(dy) < 0.02) return;   // not a tap
      w = Math.max(Math.abs(dx), MIN_CROP);
      h = Math.max(Math.abs(dy), MIN_CROP);
      x = clamp(dx < 0 ? px - w : px, 0, 1 - w);
      y = clamp(dy < 0 ? py - h : py, 0, 1 - h);
    } else {
      let left = x, top = y, right = x + w, bottom = y + h;
      if (part.includes("w")) left = clamp(x + dx, 0, right - MIN_CROP);
      if (part.includes("e")) right = clamp(x + w + dx, left + MIN_CROP, 1);
      if (part.includes("n")) top = clamp(y + dy, 0, bottom - MIN_CROP);
      if (part.includes("s")) bottom = clamp(y + h + dy, top + MIN_CROP, 1);
      [x, y, w, h] = [left, top, right - left, bottom - top];
    }
    cropping.box = [x, y, w, h];
    drawCropBox();
  }, { signal: stop.signal });
  for (const end of ["pointerup", "pointercancel"]) layer.addEventListener(end, () => stop.abort(), { signal: stop.signal });
});

// ---------------------------------------------------------------- drawing
function wordSpan(i, text) {
  const s = document.createElement("span");
  s.className = "w";
  s.dataset.i = i;
  s.textContent = text;
  return s;
}
function lineEl(items) {   // items: [index, text]
  const d = document.createElement("div");
  d.className = "line";
  items.forEach(([i, text], k) => { if (k) d.append(" "); d.append(wordSpan(i, text)); });
  return d;
}
function draw(e) {
  const cur = $("cur"), prev = $("prev"), next = $("next");
  if (e < 0) { cur.replaceChildren(); prev.replaceChildren(); next.replaceChildren(); return; }
  const p = S.pieces[S.events[e].piece];
  cur.style.fontSize = p.scale < 1 ? `calc(var(--em) * ${p.scale})` : "";
  cur.replaceChildren(...p.lines.map((line) => lineEl(line.map((k) => [p.first + k, S.words[p.first + k].text]))));
  prev.replaceChildren(...p.before.map((l) => lineEl(l.idx.map((i, k) => [i, l.texts[k]]))));
  next.replaceChildren(...p.after.map((l) => lineEl(l.idx.map((i, k) => [i, l.texts[k]]))));
}
function render() {
  if (S.swapping) return;   // a renewed Dropbox link loads from 0 until it is back at the position
  const t = video.currentTime * 1000;
  const e = S.events.length ? activeEvent(S.events, t) : -1;
  if (S.events.length && e !== S.shown) { draw(e); S.shown = e; S.spoken = -1; }
  if (e >= 0) {
    const n = spokenCount(S.events[e], t);
    if (n !== S.spoken) {
      $("cur").querySelectorAll(".w").forEach((s, k) => s.classList.toggle("on", k < n));
      S.spoken = n;
    }
  }
  const sec = Math.floor(video.currentTime);
  if (sec !== S.lastSecond) {
    S.lastSecond = sec;
    $("time").textContent = clock(video.currentTime);
    $("timeEnd").textContent = clock(video.duration);
    if (document.activeElement !== $("seek") && video.duration) $("seek").value = (video.currentTime / video.duration) * 1000;
  }
}
(function loop() { render(); requestAnimationFrame(loop); })();
for (const ev of ["seeked", "seeking", "ratechange", "pause", "play", "loadeddata"]) video.addEventListener(ev, render);
video.addEventListener("durationchange", () => { S.lastSecond = -1; render(); });   // show the length once known

function clock(s) {
  if (!isFinite(s)) return "0:00";
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

// ---------------------------------------------------------------- recordings: cover art, or bars
// A recording (audio only) shows its cover art where the video would be, else bars that move with
// the sound (core/visualizer.js); the lock screen gets its title and art. Away from iPhone and
// iPad the bars measure the sound: the element's audio goes through Web Audio, which starts with a
// tap or a key (browsers allow sound only after one) and stays for the page's life, so from then on
// streams load with CORS (Dropbox's links allow it), else they would play silent.
const canMeasure = !isIOS && typeof AudioContext === "function";
let audioCtx = null, audioGraph = null;   // audioGraph: {analyser} once the element's audio goes through Web Audio
const viz = new Visualizer($("viz"), video, {
  analyser: () => audioGraph?.analyser ?? null,
  speech: () => (S.words.length ? { words: S.words, shiftMs: S.audioOffsetMs + S.syncMs } : null),
  color: highlightColor(),
});
let look = { art: null, url: "", failed: false };

/** A stream that may go through Web Audio loads with CORS: recordings (where the bars can measure
 *  the sound), and every stream once the element's audio goes through it. Files on the device are
 *  the page's own. */
function corsFor(picked) {
  if (canMeasure && picked.url && (picked.audio || audioGraph)) video.crossOrigin = "anonymous";
  else if (!audioGraph) video.removeAttribute("crossorigin");
}

/** The video area: the video, or a recording's cover art (over a blurred copy), or the bars. */
function setLook() {
  const p = player.hidden ? null : S.picked;
  const audio = !!p && (!!p.audio || (video.readyState > 0 && !video.videoWidth));   // also an MP4 found to have no picture
  const art = (audio && p.art) || null;
  if (look.art !== art) {
    if (look.url) URL.revokeObjectURL(look.url);
    look = { art, url: art ? URL.createObjectURL(new Blob([art.data], { type: art.type })) : "", failed: false };
    for (const img of [$("coverArt"), $("coverBack")]) look.url ? (img.src = look.url) : img.removeAttribute("src");
  }
  const cover = !!look.url && !look.failed, bars = audio && !cover;
  player.classList.toggle("recording", audio);
  $("cover").hidden = !cover;
  $("viz").hidden = !bars;
  viz.show(bars);
  if ("mediaSession" in navigator && typeof MediaMetadata === "function") {
    try {
      navigator.mediaSession.metadata = p ? new MediaMetadata({ title: S.videoName.replace(/\.[^.]+$/, ""),
        artist: p.dropbox ? shownFolder(folderOf(p.dropbox.path)) : "", album: "Lecture Karaoke",
        artwork: cover ? [{ src: look.url, type: art.type }] : [] }) : null;
    } catch { /* not here */ }
  }
}
$("coverArt").addEventListener("error", () => { if (look.url && !look.failed) { look.failed = true; setLook(); } });   // can't show it: bars
video.addEventListener("loadedmetadata", () => { learnDuration(S.picked, video.duration); setLook(); });

/** Routes the element's audio through an analyser, once: on a tap or key (so the sound may start),
 *  while bars are shown for a source that may be measured. */
function measureSound() {
  const p = S.picked;
  if (!canMeasure || audioGraph || player.hidden || $("viz").hidden || !p || (p.url && video.crossOrigin !== "anonymous")) return;
  try {
    audioCtx ??= new AudioContext();
    const route = () => {
      if (audioGraph || audioCtx.state !== "running" || $("viz").hidden || S.picked !== p) return;
      const analyser = Object.assign(audioCtx.createAnalyser(), { fftSize: 2048, smoothingTimeConstant: 0.55, minDecibels: -85, maxDecibels: -20 });
      audioCtx.createMediaElementSource(video).connect(analyser).connect(audioCtx.destination);
      audioGraph = { analyser };
    };
    if (audioCtx.state === "running") route();
    else audioCtx.resume().then(route, () => {});
  } catch { /* the bars follow the transcript instead */ }
}
for (const ev of ["click", "keydown"]) addEventListener(ev, measureSound, true);
video.addEventListener("play", () => { if (audioGraph && audioCtx.state !== "running") audioCtx.resume().catch(() => {}); });

// ---------------------------------------------------------------- highlight color
// The color of the words already spoken: a preset or any color, in full or soft. The soft
// highlight is that color mixed with the white of the words still to come, as much as Settings
// says; the Soft button switches between the two. The bars of a recording follow it; the
// buttons keep the app's yellow.
/** The words' highlight as #rrggbb: the color, or when soft, strength % of it and the rest white. */
function highlightColor({ color, soft, strength } = prefs.hi) {
  const rgb = parseInt(color.slice(1), 16), keep = soft ? strength / 100 : 1;
  return "#" + [16, 8, 0].map((shift) => Math.round(255 - (255 - ((rgb >> shift) & 255)) * keep)
    .toString(16).padStart(2, "0")).join("");
}
const hiCustom = el("input", { type: "color" });
hiCustom.setAttribute("aria-label", "Another color");
$("hiColors").append(...HI_COLORS.map(([name, color]) => {
  const radio = el("input", { type: "radio", name: "hiColor", value: color });
  radio.setAttribute("aria-label", name);
  radio.addEventListener("change", () => setHighlight({ color }));
  const swatch = el("label", { className: "swatch", title: name }, radio, el("span"));
  swatch.style.setProperty("--c", color);
  return swatch;
}), el("label", { className: "swatch custom", title: "Another color" }, hiCustom, el("span")));
hiCustom.addEventListener("input", () => setHighlight({ color: hiCustom.value }));
[$("hiStrength").min, $("hiStrength").max] = HI_SOFT_RANGE;
$("hiStrength").addEventListener("input", () => setHighlight({ strength: Number($("hiStrength").value) }, false));
$("hiStrength").addEventListener("change", savePrefs);
const hiLooks = $("settings").querySelectorAll("input[name=hiLook]");
for (const radio of hiLooks) radio.addEventListener("change", () => setHighlight({ soft: radio.value === "soft" }));
$("hiBtn").addEventListener("click", () => setHighlight({ soft: !prefs.hi.soft }));

function setHighlight(changes, keep = true) {
  prefs.hi = { ...prefs.hi, ...changes };
  if (keep) savePrefs();
  applyHighlight();
}
function applyHighlight() {
  const c = highlightColor(), { color, soft, strength } = prefs.hi, preset = HI_COLORS.some(([, p]) => p === color);
  document.documentElement.style.setProperty("--said", c);
  document.documentElement.style.setProperty("--chosen", color);   // the end mode button, every time
  viz.color = c;
  viz.draw();
  for (const radio of $("hiColors").querySelectorAll("input[type=radio]")) {
    radio.checked = radio.value === color;
    radio.parentElement.classList.toggle("chosen", radio.checked);
  }
  hiCustom.parentElement.classList.toggle("chosen", !preset);
  hiCustom.parentElement.style.setProperty("--c", preset ? "" : color);
  if (document.activeElement !== hiCustom) hiCustom.value = color;
  if (document.activeElement !== $("hiStrength")) $("hiStrength").value = strength;
  $("hiOut").textContent = `${strength}%`;
  for (const radio of hiLooks) {   // each look shows its own sample
    const look = radio.value === "soft";
    radio.checked = look === soft;
    radio.closest(".hi-look").querySelector(".on").style.color = highlightColor({ color, soft: look, strength });
  }
  $("hiBtn").setAttribute("aria-pressed", String(soft));
}
applyHighlight();

// The MP4's own caption track would be drawn over the app by Safari: keep it off.
const captionsOff = () => { for (const t of video.textTracks) t.mode = "disabled"; };
video.addEventListener("loadedmetadata", captionsOff);
video.textTracks.addEventListener?.("addtrack", captionsOff);

// ---------------------------------------------------------------- controls
/** Play or pause; while the next lecture is put in place (showComing), whether it plays once open. */
function togglePlay() {
  if (coming) return comingPlays(!coming.play);
  media().paused ? resume() : pausePlayback();
}
function comingPlays(on) {
  allowMedia();   // a tap, mostly
  coming.play = on;
  drawPlayLook(on);
}
/** The play button: ❚❚ while playing (or about to: the next lecture put in place plays once open). */
function drawPlayLook(on) {
  if (coming) on = coming.play;
  $("playBtn").textContent = on ? "❚❚" : "▶︎";
  $("playBtn").ariaLabel = on ? "Pause" : "Play";
}
$("playBtn").addEventListener("click", togglePlay);
video.addEventListener("play", () => { S.playing = true; drawPlayLook(true); keepAwake(true); });
video.addEventListener("playing", () => queuePlayed([playingFile()]));
video.addEventListener("pause", () => {
  if (video.ended) S.playing = false;
  else if (S.playing && !S.swapping && !S.handing && !bgOn && !player.hidden) {
    // Not the viewer's pause (pausePlayback): iPhone's, as the app goes to the background, which may
    // be said just before or after. Hidden, the sound goes on from bg; still on screen, it stays paused.
    const handOver = () => (BG && document.hidden && hasPicture() ? playHidden() : (S.playing = false));
    if (document.hidden) handOver();
    else setTimeout(() => { if (video.paused && S.playing && !bgOn) handOver(); }, 1000);
  }
  drawPlayLook(false);
  keepAwake(false);
  save();
});
videoBox.addEventListener("click", () => { if (!cropping) togglePlay(); });   // also beside a turned or cropped picture
$("seek").addEventListener("input", () => { if (video.duration) video.currentTime = ($("seek").value / 1000) * video.duration; });
$("editBtn").addEventListener("click", () => setEditing(!S.editing));
$("moreBtn").addEventListener("click", openSettings);

const fsTarget = document.documentElement;
const canFullscreen = !!(fsTarget.requestFullscreen || fsTarget.webkitRequestFullscreen);
$("fsBtn").addEventListener("click", () => {
  if (document.fullscreenElement || document.webkitFullscreenElement) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  else (fsTarget.requestFullscreen || fsTarget.webkitRequestFullscreen).call(fsTarget);
});

function setEditing(on) {
  S.editing = on;
  panel.classList.toggle("editing", on);
  $("editBtn").setAttribute("aria-pressed", String(on));
  if (on) { pausePlayback(); toast("Tap a word to fix it"); }
}
const fmtRate = (r) => `${+r.toFixed(2)}×`;
const fmtOffset = (ms) => `${ms > 0 ? "+" : ms < 0 ? "−" : "±"}${+Math.abs(ms / 1000).toFixed(2)} s`;
function updateChips() {
  const r = video.playbackRate;
  $("speedBtn").textContent = fmtRate(r);
  const to = swapTarget();
  $("swapBtn").textContent = `⇄ ${fmtRate(to)}`;
  $("swapBtn").title = `Switch to ${fmtRate(to)} (the speed switch goes between ${prefs.speedPair.map(fmtRate).join(" and ")}; set them by tapping the speed)`;
  $("barSlower").disabled = r <= RATE_MIN + 1e-9;
  $("barFaster").disabled = r >= RATE_MAX - 1e-9;
  $("leadBtn").textContent = prefs.offsetOn ? fmtOffset(prefs.offsetMs) : "Exact";
  $("leadBtn").setAttribute("aria-pressed", String(prefs.offsetOn));
}

addEventListener("keydown", (e) => {
  if (player.hidden || e.target.closest?.("input, select, textarea, dialog")) return;
  const k = e.key.toLowerCase();
  if (arranging) {
    const how = { arrowleft: "left", arrowright: "right", arrowup: "up", arrowdown: "down" }[k];
    if (how) { moveSelected(how); e.preventDefault(); } else if (k === "escape" || k === "enter") setArranging(false);
    return;
  }
  if (cropping && k === "escape") { cancelCropping(); e.preventDefault(); return; }
  if (k === " ") { e.preventDefault(); togglePlay(); }
  else if (k === "arrowleft") skip(-5);
  else if (k === "arrowright") skip(5);
  else if (k === "arrowup" || k === "]") stepRate(1);
  else if (k === "arrowdown" || k === "[") stepRate(-1);
  else if (k === "-" || k === "_") nudgeRate(-1);
  else if (k === "+" || k === "=") nudgeRate(1);
  else if (k === "l") $("leadBtn").click();
  else if (k === "h") $("hiBtn").click();
  else if (k === "e") $("editBtn").click();
  else if (k === "n") $("notesBtn").click();
  else if (k === "c" && !$("peekBtn").hidden && !$("peekBtn").disabled) $("peekBtn").click();
  else if (k === "s") switchSpeed();
  else if (k === "f" && canFullscreen) $("fsBtn").click();
  else return;
  e.preventDefault();
});

// Tap a word: jump there (or fix it in edit mode).
panel.addEventListener("click", (e) => {
  const span = e.target.closest(".w");
  if (!span) return;
  const i = Number(span.dataset.i);
  if (S.editing) { openEditor(i); return; }
  const w = S.words[i];
  video.currentTime = Math.max(0, w.start + S.audioOffsetMs + S.syncMs - S.leadMs + 10) / 1000;
});

// ---------------------------------------------------------------- control bar
// Two rows of parts (data-el in index.html), arranged by the viewer and kept on this device:
// Settings → Arrange the buttons, then tap a part and move it. Settings itself can't be hidden,
// so the bar can always be arranged again.
const BAR_DEFAULT = { rows: [["title", "crop", "peek", "hide", "progress", "speedswap", "highlight", "timing", "notes", "fix", "lock", "important", "endmode", "sleep", "fullscreen",
  "settings"], ["back", "previous", "rewind", "play", "forward", "next", "speed"]], hidden: [] };
const BAR_LABELS = { progress: "Progress bar", highlight: "Soft highlight", lock: "Lock", back: "Back", rewind: "−5s", play: "Play",
  forward: "+5s", speed: "Speed", timing: "Timing", fix: "Fix", settings: "Settings", fullscreen: "Full screen", notes: "Notes",
  previous: "Previous lecture", next: "Next lecture", endmode: "End mode", sleep: "Sleep timer", important: "Important", title: "File name",
  hide: "Hide from the list", crop: "Crop", peek: "Crop to the box", speedswap: "Speed switch" };
/** The small parts that may follow the file name, or the progress bar, in its row and share its line. */
const LINE_MATES = { title: new Set(["crop", "peek", "hide"]), progress: new Set(["speedswap"]) };
// Kept here, not looked up: a part taken out of the bar is detached for a moment and couldn't be found.
const PARTS = new Map([...bar.querySelectorAll("[data-el]")].map((el) => [el.dataset.el, el]));
const barPart = (id) => PARTS.get(id);
const canShow = (id) => id !== "fullscreen" || canFullscreen;   // no element full screen on iPhone
/** The saved arrangement, made valid: every part exactly once. A part added in a later release goes
 *  where the default bar has it: first in its row, or after the part it follows there (else at the
 *  end of that row). */
function barConfig() {
  const c = prefs.bar?.rows ? prefs.bar : BAR_DEFAULT, seen = new Set();
  const take = (ids, ok = () => true) => (Array.isArray(ids) ? ids : [])
    .filter((id) => BAR_LABELS[id] && ok(id) && !seen.has(id) && seen.add(id));
  const rows = [take(c.rows[0]), take(c.rows[1])];
  const hidden = take(c.hidden, (id) => id !== "settings");
  BAR_DEFAULT.rows.forEach((def, r) => def.forEach((id, i) => {
    if (seen.has(id)) return;
    const after = i ? rows[r].indexOf(def[i - 1]) : -1;
    rows[r].splice(!i ? 0 : after < 0 ? rows[r].length : after + 1, 0, id);
    seen.add(id);
  }));
  return { rows, hidden };
}
let arranging = false, selected = null;
function renderBar() {
  const { rows, hidden } = barConfig();   // prefs.bar stays null until the viewer arranges the bar
  rows.forEach((ids, r) => $(`barRow${r + 1}`).replaceChildren(...ids.filter(canShow).map(barPart)));
  $("barParts").replaceChildren(...hidden.map(barPart), ...(canFullscreen ? [] : [barPart("fullscreen")]));
  for (const el of bar.querySelectorAll("[data-el]")) el.classList.toggle("selected", arranging && el.dataset.el === selected);
  if (arranging) {
    $("arrangeHint").textContent = selected ? `Move “${BAR_LABELS[selected]}”:` : "Tap a button in the bar, then move it.";
    for (const b of $("arrange").querySelectorAll("[data-move]")) b.disabled = !selected || (b.dataset.move === "hide" && selected === "settings");
    $("hiddenParts").replaceChildren(...hidden.map((id) => {
      const b = Object.assign(document.createElement("button"), { type: "button", className: "chip", textContent: BAR_LABELS[id] });
      b.addEventListener("click", () => showPart(id));
      return b;
    }));
    $("hiddenRow").hidden = !hidden.length;
  }
  fitTitleLine();
  layout();
}
/** The crop, crop-to-the-box and hide buttons right after the file name share its line, and the speed
 *  switch right after the progress bar shares that one's (on a phone, where it has a line of its own):
 *  they are drawn small (beside-title, beside-progress), and the name or the bar leaves room for the
 *  ones shown (--beside). */
function fitTitleLine() {
  for (const [id, mates] of Object.entries(LINE_MATES)) {
    const head = barPart(id), mark = `beside-${id}`;
    for (const el of bar.querySelectorAll(`.${mark}`)) el.classList.remove(mark);
    let n = 0;
    for (let el = head.nextElementSibling; el && mates.has(el.dataset.el); el = el.nextElementSibling) {
      el.classList.add(mark);
      if (!el.hidden) n++;
    }
    head.style.setProperty("--beside", String(n));
  }
}
function setArranging(on) {
  arranging = on;
  if (!on) selected = null;
  player.classList.toggle("arranging", on);
  $("arrange").hidden = !on;
  renderBar();
  drawView();   // the crop-to-the-box button shows while arranging, to be moved
}
function saveBar(cfg) {
  prefs.bar = cfg;
  savePrefs();
  renderBar();
}
// While arranging, a tap on a part selects it instead of using it.
bar.addEventListener("click", (e) => {
  const part = arranging && e.target.closest(".bar-row [data-el]");
  if (!part) return;
  e.preventDefault();
  e.stopPropagation();
  selected = part.dataset.el;
  renderBar();
}, true);
$("arrange").addEventListener("click", (e) => {
  const how = e.target.closest("[data-move]")?.dataset.move;
  if (how) moveSelected(how);
});
/** Moves the selected part left/right within its row, up/down to the other row, or hides it. */
function moveSelected(how) {
  if (!selected) return;
  const cfg = barConfig(), r = cfg.rows.findIndex((row) => row.includes(selected));
  if (r < 0) return;
  const row = cfg.rows[r], i = row.indexOf(selected);
  if (how === "left" || how === "right") {
    const step = how === "left" ? -1 : 1;
    let j = i + step;
    while (j >= 0 && j < row.length && !canShow(row[j])) j += step;   // skip parts this device doesn't show
    if (j < 0 || j >= row.length) return;
    [row[i], row[j]] = [row[j], row[i]];
  } else if (how === "up" || how === "down") {
    const to = how === "up" ? 0 : 1;
    if (to === r) return;
    row.splice(i, 1);
    cfg.rows[to].splice(Math.min(i, cfg.rows[to].length), 0, selected);
  } else if (how === "hide") {
    if (selected === "settings") return;
    row.splice(i, 1);
    cfg.hidden.push(selected);
    selected = null;
  }
  saveBar(cfg);
}
function showPart(id) {
  const cfg = barConfig();
  cfg.hidden = cfg.hidden.filter((x) => x !== id);
  cfg.rows[1].push(id);
  selected = id;
  saveBar(cfg);
}
$("arrangeReset").addEventListener("click", () => { selected = null; saveBar(structuredClone(BAR_DEFAULT)); });
$("arrangeDone").addEventListener("click", () => setArranging(false));
$("backBtn").addEventListener("click", goHome);
$("rewindBtn").addEventListener("click", () => skip(-5));
$("forwardBtn").addEventListener("click", () => skip(5));

// ---------------------------------------------------------------- touch lock
// The lock button covers the player: no touch or click reaches anything under it (the keyboard
// still works). A touch shows the slider; the lock has to be slid all the way to the right and
// let go there. A stray touch, or a slide that wanders off the track, leaves it locked.
// Above it, the dimmer: a black layer over the player, which a swipe along it makes lighter (to the
// right) or darker (to the left, all the way: a black screen); kept on this device (prefs.lockDim).
const lockLayer = $("lock"), unlock = $("unlock"), knob = $("unlockKnob");
const dimmer = $("dimmer"), dimKnob = $("dimKnob");
let unlockTimer = 0, slide = null, knobAt = 0, dimSlide = null;
function setLocked(on) {
  lockLayer.hidden = !on;
  player.classList.toggle("locked", on);
  for (const part of player.children) if (part !== lockLayer) part.inert = on;   // nothing under it takes focus either
  slide = dimSlide = null;
  moveKnob(0);
  drawDim();
  if (on) showUnlock();
  else for (const el of [unlock, dimmer]) el.classList.remove("show");
}
/** Shows the sliders for a few seconds (every touch on the lock shows them again). */
function showUnlock() {
  for (const el of [unlock, dimmer]) el.classList.add("show");
  clearTimeout(unlockTimer);
  unlockTimer = setTimeout(() => { if (!slide && !dimSlide) for (const el of [unlock, dimmer]) el.classList.remove("show"); }, 3500);
}
const knobRoom = () => unlock.clientWidth - knob.offsetWidth - 10;   // the knob sits 5 px inside each end
function moveKnob(x, glide = false) {
  const share = x / (knobRoom() || 1);
  knobAt = x;
  knob.classList.toggle("back", glide);
  knob.style.transform = x ? `translateX(${x}px)` : "";
  unlock.querySelector(".unlock-text").style.opacity = String(Math.max(0, 1 - share * 1.6));
  knob.setAttribute("aria-valuenow", String(Math.round(share * 100)));
}
$("lockBtn").addEventListener("click", () => setLocked(true));
lockLayer.addEventListener("pointerdown", (e) => {
  if (knob.contains(e.target)) return;
  e.preventDefault();
  showUnlock();
});
for (const type of ["click", "dblclick", "contextmenu"]) lockLayer.addEventListener(type, (e) => e.preventDefault());
lockLayer.addEventListener("touchmove", (e) => e.preventDefault(), { passive: false });   // no scrolling or zooming under it
lockLayer.addEventListener("gesturestart", (e) => e.preventDefault());                   // Safari's pinch
knob.addEventListener("pointerdown", (e) => {
  if (slide) return;
  e.preventDefault();
  knob.setPointerCapture(e.pointerId);
  slide = { id: e.pointerId, x: e.clientX, y: e.clientY, at: 0 };
  moveKnob(0);
  showUnlock();
});
knob.addEventListener("pointermove", (e) => {
  if (e.pointerId !== slide?.id) return;
  if (Math.abs(e.clientY - slide.y) > unlock.offsetHeight * 1.5) { endSlide(false); return; }   // wandered off the track
  slide.at = clamp(e.clientX - slide.x, 0, knobRoom());
  moveKnob(slide.at);
});
knob.addEventListener("pointerup", (e) => { if (e.pointerId === slide?.id) endSlide(slide.at >= knobRoom() - 4); });
knob.addEventListener("pointercancel", (e) => { if (e.pointerId === slide?.id) endSlide(false); });
function endSlide(done) {
  if (knob.hasPointerCapture(slide.id)) knob.releasePointerCapture(slide.id);
  slide = null;
  if (done) { setLocked(false); return; }
  moveKnob(0, true);   // springs back
  showUnlock();
}
// With the keyboard, the arrow keys move the lock a quarter of the way at a time.
knob.addEventListener("keydown", (e) => {
  const step = { ArrowRight: 1, ArrowUp: 1, PageUp: 1, End: 4, ArrowLeft: -1, ArrowDown: -1, PageDown: -1, Home: -4 }[e.key];
  if (!step || slide) return;
  e.preventDefault();
  e.stopPropagation();   // not the player's shortcuts
  const room = knobRoom(), x = clamp(knobAt + (step * room) / 4, 0, room);
  if (x >= room) setLocked(false);
  else { moveKnob(x, true); showUnlock(); }
});
/** The dimmer as set: the layer's darkness, and its knob (at the right end while nothing is dimmed). */
function drawDim() {
  const dark = prefs.lockDim;
  $("dimLayer").style.opacity = String(dark);
  dimmer.style.setProperty("--clear", String(1 - dark));
  dimKnob.setAttribute("aria-valuenow", String(Math.round((1 - dark) * 100)));
  dimKnob.setAttribute("aria-valuetext", dark ? `${Math.round(dark * 100)}% dark` : "Not dimmed");
}
const dimRoom = () => dimmer.clientWidth - dimKnob.offsetWidth - 8;   // the knob sits 4 px inside each end
// A swipe anywhere along the dimmer moves its knob as far as the finger goes; a tap changes nothing.
dimmer.addEventListener("pointerdown", (e) => {
  if (dimSlide) return;
  e.preventDefault();
  dimmer.setPointerCapture(e.pointerId);
  dimSlide = { id: e.pointerId, x: e.clientX, clear: 1 - prefs.lockDim };
  showUnlock();
});
dimmer.addEventListener("pointermove", (e) => {
  if (e.pointerId !== dimSlide?.id) return;
  const clear = clamp(dimSlide.clear + (e.clientX - dimSlide.x) / (dimRoom() || 1), 0, 1);
  prefs.lockDim = Math.round((1 - clear) * 100) / 100;
  drawDim();
});
for (const type of ["pointerup", "pointercancel"]) dimmer.addEventListener(type, (e) => {
  if (e.pointerId !== dimSlide?.id) return;
  dimSlide = null;
  savePrefs();
  showUnlock();
});
// With the keyboard, the arrow keys make it a tenth lighter (→) or darker (←).
dimKnob.addEventListener("keydown", (e) => {
  const step = { ArrowRight: 1, ArrowUp: 1, PageUp: 3, End: 10, ArrowLeft: -1, ArrowDown: -1, PageDown: -3, Home: -10 }[e.key];
  if (!step || dimSlide) return;
  e.preventDefault();
  e.stopPropagation();   // not the player's shortcuts
  prefs.lockDim = clamp(Math.round(prefs.lockDim * 10 - step) / 10, 0, 1);
  drawDim();
  savePrefs();
  showUnlock();
});

// ---------------------------------------------------------------- seeking, with a brief hint on the video
function skip(s) {
  video.currentTime = clamp(video.currentTime + s, 0, video.duration || 0);
  flash(s < 0 ? `« ${-s} s` : `${s} s »`);
}
let flashTimer = 0;
function flash(text) {
  const f = $("flash");
  f.textContent = text;
  f.classList.add("show");
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => f.classList.remove("show"), 700);
}

// ---------------------------------------------------------------- speed (0.2× to 4×)
/** Sets the speed, or says so and returns false when this browser refuses it. A speed the viewer
 *  chose (remember) is kept for the lecture's Dropbox folder, and as the speed of folders without one. */
function applyRate(r, remember = true) {
  r = Math.round(clamp(r, RATE_MIN, RATE_MAX) * 100) / 100;
  try {
    video.defaultPlaybackRate = r;
    video.playbackRate = r;
  } catch {
    toast(`This browser can't play at ${fmtRate(r)}.`);
    return false;
  }
  if (!remember) return true;
  prefs.rate = r;
  if (S.folder != null) prefs.folderRates[S.folder.toLowerCase()] = r;
  savePrefs();
  return true;
}
/** The Dropbox folder of the lecture opened (its speed is kept per folder), or null for a file on this
 *  device that isn't in Dropbox. */
function lectureFolder(picked) {
  if (picked.dropbox?.path) return folderOf(picked.dropbox.path);
  const it = picked.fingerprint && library.items.find((i) => i.entry?.fingerprint === picked.fingerprint);
  return it ? it.folder : null;
}
// − and + step 0.05× (from a typed speed between two steps, to the nearer step that way), in the bar
// and in the dialog; the arrow keys in the dialog do the same, and Page Up/Down jump to the next preset.
$("speedPreset").append(new Option("Custom", ""), ...RATE_PRESETS.map((r) => new Option(fmtRate(r), String(r))));
function nudgeRate(dir) {
  const k = video.playbackRate * 20;   // in 0.05× steps
  applyRate((dir > 0 ? Math.floor(k + 1e-6) + 1 : Math.ceil(k - 1e-6) - 1) / 20);
}
function syncSpeedControls() {
  const r = video.playbackRate;
  if (document.activeElement !== $("speedNum")) $("speedNum").value = r.toFixed(2);
  $("speedPreset").value = RATE_PRESETS.includes(r) ? String(r) : "";
  $("speedDown").disabled = r <= RATE_MIN + 1e-9;
  $("speedUp").disabled = r >= RATE_MAX - 1e-9;
  $("speedFor").textContent = S.folder == null ? "Kept on this device."
    : `Kept on this device for the lectures in “${folderTitle(S.folder)}”; each folder keeps its own.`;
}
$("speedBtn").addEventListener("click", () => { syncSpeedControls(); syncSwapControls(); $("speedDialog").showModal(); });
$("speedDown").addEventListener("click", () => nudgeRate(-1));
$("speedUp").addEventListener("click", () => nudgeRate(1));
$("barSlower").addEventListener("click", () => nudgeRate(-1));
$("barFaster").addEventListener("click", () => nudgeRate(1));
$("speedDialog").addEventListener("keydown", (e) => {
  if (e.target === $("speedNum") || e.target === $("speedPreset")) return;   // they use the arrows themselves
  const dir = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
  if (dir) nudgeRate(dir);
  else if (e.key === "PageUp" || e.key === "PageDown") stepRate(e.key === "PageUp" ? 1 : -1);
  else return;
  e.preventDefault();
});
$("speedNum").addEventListener("change", () => {
  const r = parseFloat($("speedNum").value);
  if (Number.isFinite(r)) applyRate(r);
  $("speedNum").value = video.playbackRate.toFixed(2);
});
$("speedPreset").addEventListener("change", () => { if ($("speedPreset").value) applyRate(Number($("speedPreset").value)); });
$("speedNormal").addEventListener("click", () => applyRate(1));
video.addEventListener("ratechange", () => { updateChips(); syncSpeedControls(); });
// The speed switch (⇄ beside the progress bar, or S): between two speeds chosen in the speed dialog,
// kept on the device. A tap goes to the one of the two that is farther from the speed now (the other
// one, also after − or + changed it a little). Like any speed chosen, it is kept for the folder.
function swapTarget() {
  const r = video.playbackRate || prefs.rate, [a, b] = prefs.speedPair;
  return Math.abs(r - a) >= Math.abs(r - b) ? a : b;
}
function switchSpeed() {
  if (applyRate(swapTarget())) flash(fmtRate(video.playbackRate));
}
$("swapBtn").addEventListener("click", switchSpeed);
function syncSwapControls() {
  prefs.speedPair.forEach((r, i) => { const el = $(i ? "swapB" : "swapA"); if (document.activeElement !== el) el.value = r.toFixed(2); });
}
for (const [i, id] of [[0, "swapA"], [1, "swapB"]]) {
  $(id).addEventListener("change", () => {
    const r = parseFloat($(id).value);
    if (Number.isFinite(r)) prefs.speedPair[i] = Math.round(clamp(r, RATE_MIN, RATE_MAX) * 100) / 100;
    savePrefs();
    syncSwapControls();
    updateChips();
  });
}
for (const [i, id] of [[0, "swapANow"], [1, "swapBNow"]]) {
  $(id).addEventListener("click", () => { prefs.speedPair[i] = video.playbackRate; savePrefs(); syncSwapControls(); updateChips(); });
}
/** Keyboard: the next preset speed up (+1) or down (-1). */
function stepRate(dir) {
  const r = video.playbackRate;
  const next = dir > 0 ? RATE_PRESETS.find((p) => p > r + 1e-9) : RATE_PRESETS.findLast((p) => p < r - 1e-9);
  if (next) applyRate(next);
}

// ---------------------------------------------------------------- timing offset
// The Exact button switches between exact timing and one offset set in the settings:
// + shows the subtitles before the voice (to read ahead), - after it.
function setOffset(ms = prefs.offsetMs, on = prefs.offsetOn) {
  prefs.offsetMs = clamp(Math.round(ms / 100) * 100, -OFFSET_MAX_MS, OFFSET_MAX_MS);
  prefs.offsetOn = on;
  savePrefs();
  S.leadMs = on ? prefs.offsetMs : 0;
  rebuildEvents();
  updateChips();
  syncOffsetControls();
}
function syncOffsetControls() {
  if (document.activeElement !== $("offset")) $("offset").value = +(prefs.offsetMs / 1000).toFixed(2);
  const s = +Math.abs(prefs.offsetMs / 1000).toFixed(2);
  $("offsetSays").textContent = prefs.offsetMs > 0 ? `Subtitles ${s} s before the voice, to read ahead. − puts them after it.`
    : prefs.offsetMs < 0 ? `Subtitles ${s} s after the voice. + puts them before it.`
    : "Same as exact. + puts the subtitles before the voice, − after it.";
}
$("leadBtn").addEventListener("click", () => setOffset(prefs.offsetMs, !prefs.offsetOn));
$("offsetDown").addEventListener("click", () => setOffset(prefs.offsetMs - 500));
$("offsetUp").addEventListener("click", () => setOffset(prefs.offsetMs + 500));
$("offset").addEventListener("change", () => {
  const s = parseFloat($("offset").value);
  if (Number.isFinite(s)) setOffset(s * 1000);
  $("offset").value = +(prefs.offsetMs / 1000).toFixed(2);
});

// ---------------------------------------------------------------- fixing words
let editing = -1;
function openEditor(i) {
  editing = i;
  const w = S.words[i];
  $("editorText").value = w.text;
  $("editorWhen").textContent = `At ${clock((w.start + S.audioOffsetMs) / 1000)}` + (w.orig && w.orig !== w.text ? ` · originally “${w.orig}”` : "");
  $("editor").returnValue = "";   // it would otherwise keep the last one, and Escape would "save"
  $("editor").showModal();
  $("editorText").select();
}
// Cancel is not a submit button, so Enter in the text box saves.
$("editorCancel").addEventListener("click", () => $("editor").close("cancel"));
$("editor").addEventListener("close", () => {
  if ($("editor").returnValue !== "save" || editing < 0) return;
  changeFix(deltaFor(S.words[editing], $("editorText").value));
});
/** A fix made, changed or undone on this device: shown at once, then sent to GitHub. */
function changeFix(delta) {
  S.rec.fixes = applyDeltas(S.rec.fixes, [delta]);
  if (gh && S.repoKey) S.rec.pending = [...(S.rec.pending || []), delta];
  else S.rec.synced = false;          // goes to GitHub when this lecture is linked to it
  applyAndRelayout();
  if (!gh || !S.repoKey) return toast("Fix saved on this device");
  toast("Fix saved");
  syncFixes().then((ok) => { if (!ok && !S.rec.syncError) toast("Fix saved on this device; it will sync when online"); });
}
function applyAndRelayout() {
  S.words = applyFixes(S.baseWords, S.rec.fixes);
  rebuildLayout();
  save();
}

// Fixes are kept per lecture in fixes/<key>.json. Local changes wait in rec.pending until GitHub
// has them; they are applied to GitHub's latest list (core/sync.js), so devices don't overwrite
// each other, and whatever other devices added comes back.
let syncing = null, syncAgain = false;
function syncFixes() {
  if (!gh || !S.repoKey || !S.id) return Promise.resolve(false);
  if (syncing) { syncAgain = true; return syncing; }
  const id = S.id, rec = S.rec, key = S.repoKey, name = S.videoName;
  if (!rec.synced && rec.fixes?.length && !rec.pending?.length) rec.pending = rec.fixes.map((f) => ({ ...f }));
  const sent = (rec.pending || []).slice();
  syncing = gh.update(`fixes/${key}.json`, (cur) => (sent.length
    ? { video: name, fixes: applyDeltas(cur?.fixes, sent), updated: new Date().toISOString() } : undefined),
  `Fix words in ${name}`).then((data) => {
    rec.pending = (rec.pending || []).slice(sent.length);
    Object.assign(rec, { synced: true, syncError: null, syncedAt: Date.now() });
    const fixes = applyDeltas(data?.fixes, rec.pending), changed = !sameFixes(fixes, rec.fixes);
    rec.fixes = fixes;
    if (S.id !== id) store.save(id, structuredClone(rec));
    else if (changed) applyAndRelayout();
    else save();
    return true;
  }).catch((err) => {
    rec.syncError = err.kind === "offline" ? null : err.message;
    if (rec.syncError) toast(`Fixes not synced: ${err.message}`);
    return false;
  }).finally(() => {
    syncing = null;
    drawSyncNote();
    if (syncAgain) { syncAgain = false; syncFixes(); }
  });
  drawSyncNote();
  return syncing;
}
function drawSyncNote() {
  const n = (S.rec.pending || []).length, fixes = (S.rec.fixes || []).length;
  $("ghNote").textContent = !gh ? "Not connected: transcripts come from files you pick, and fixes stay on this device."
    : !S.repoKey ? `Connected to ${gh.repo}. This lecture isn't there yet.`
    : `Connected to ${gh.repo}. This lecture: ${fixes} fix${fixes === 1 ? "" : "es"}` +
      (syncing ? ", syncing…" : S.rec.syncError ? `; not synced: ${S.rec.syncError}`
        : n ? `; ${n} change${n === 1 ? "" : "s"} waiting to sync.` : ", all on GitHub.");
}

// ---------------------------------------------------------------- notes
// Text notes on a lecture, each at the moment of the video where its typing began. They show on a
// layer over the video and subtitles (which show through), the newest first, under the box they are
// typed in; a tap on a note's time goes there. A note swiped left is deleted (Undo in the toast),
// one swiped right is edited in place. Kept per lecture like fixes: rec.notes on the device, and
// notes/<key>.json in the repository for every device. Changes made here wait in rec.notesPending
// until GitHub has them and are applied to GitHub's latest notes (core/notes.js).
const notesLayer = $("notes"), noteInput = $("noteInput");
let draftAt = null;        // where the note being typed was begun (ms into the video), null while the box is empty
let noteEditing = null;    // the note being edited in place: the list waits to be drawn again
const videoMs = () => Math.round(video.currentTime * 1000);
function setNotesOpen(on) {
  if (on && !S.id) return toast("Notes come with the transcript: this lecture doesn't have one yet.");
  notesLayer.hidden = !on;
  $("notesBtn").setAttribute("aria-pressed", String(on));
  if (!on) {
    noteEditing = null;
    if (notesLayer.contains(document.activeElement)) document.activeElement.blur();
    return;
  }
  drawNotes();
  drawNoteWhen();
  syncNotes();   // what other devices added since
  if (matchMedia("(pointer: fine)").matches) noteInput.focus();   // not on touch screens: the keyboard would cover the notes
}
$("notesBtn").addEventListener("click", () => setNotesOpen(notesLayer.hidden));
$("notesClose").addEventListener("click", () => setNotesOpen(false));
notesLayer.addEventListener("keydown", (e) => { if (e.key === "Escape" && !noteEditing) { e.preventDefault(); setNotesOpen(false); } });
function drawNoteWhen() {
  $("noteWhen").textContent = `At ${clock((draftAt ?? videoMs()) / 1000)}`;
  $("noteWhen").classList.toggle("fixed", draftAt !== null);
}
video.addEventListener("timeupdate", () => { if (!notesLayer.hidden && draftAt === null) drawNoteWhen(); });
/** The box grows with what is typed, up to five lines. */
function fitNoteInput() {
  noteInput.style.height = "auto";
  noteInput.style.height = `${Math.min(noteInput.scrollHeight + 2, 5 * 22 + 20)}px`;
}
noteInput.addEventListener("input", () => {
  draftAt = noteInput.value.trim() ? draftAt ?? videoMs() : null;
  drawNoteWhen();
  fitNoteInput();
});
const isEnter = (e) => e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229;   // Shift+Enter: a new line
noteInput.addEventListener("keydown", (e) => {
  if (!isEnter(e)) return;
  e.preventDefault();
  const text = noteInput.value.trim();
  if (!text || !S.id) return;
  const now = new Date().toISOString();
  changeNote({ id: newNoteId(), at_ms: draftAt ?? videoMs(), text, created: now, updated: now });
  noteInput.value = "";
  draftAt = null;
  drawNoteWhen();
  fitNoteInput();
});
/** A note added, changed or deleted on this device: shown at once, then sent to GitHub. */
function changeNote(note) {
  S.rec.notes = applyNoteChanges(S.rec.notes, [note]);
  if (gh && S.repoKey) S.rec.notesPending = [...(S.rec.notesPending || []), note];
  else S.rec.notesSynced = false;   // goes to GitHub when this lecture is linked to it
  save();
  drawNotes();
  syncNotes();
}
function deleteNote(note) {
  const gone = { ...note, deleted: true, updated: noteStamp(note.updated) };
  changeNote(gone);
  toast("Note deleted", "Undo", () => {
    const { deleted, ...back } = note;
    if (S.rec.notes?.some((n) => n.id === note.id)) changeNote({ ...back, updated: noteStamp(gone.updated) });
  });
}
function drawNotes() {
  if (notesLayer.hidden) return;
  drawNotesStatus();
  if (noteEditing) return;   // drawn when the edit ends
  const notes = shownNotes(S.rec.notes);
  $("noteList").replaceChildren(...notes.map(noteRow));
  $("notesEmpty").hidden = notes.length > 0;
  $("notesHint").hidden = !notes.length;
}
function drawNotesStatus() {
  const n = shownNotes(S.rec.notes).length, waiting = (S.rec.notesPending || []).length || S.rec.notesSynced === false;
  const state = !gh ? "kept on this device" : !S.repoKey ? "on this device until the lecture is on GitHub"
    : notesSyncing ? "syncing…" : S.rec.notesError ? `not synced: ${S.rec.notesError}` : waiting ? "waiting to sync" : n ? "on GitHub" : "";
  $("notesStatus").textContent = [n && `${n} note${n === 1 ? "" : "s"}`, state].filter(Boolean).join(" · ");
}
function noteRow(note) {
  const at = clock(note.at_ms / 1000), time = el("button", { type: "button", className: "note-time", textContent: at, ariaLabel: `Go to ${at}` });
  time.addEventListener("click", () => { video.currentTime = note.at_ms / 1000; });
  const body = el("div", { className: "note-body" }, time, el("span", { className: "note-text", textContent: note.text }));
  const li = el("li", { className: "note", tabIndex: 0, ariaLabel: `${at}: ${note.text}. Delete key: delete it; Enter: edit it.` },
    el("span", { className: "note-under edit", textContent: "Edit" }), el("span", { className: "note-under delete", textContent: "Delete" }), body);
  li.addEventListener("keydown", (e) => {
    if (e.target !== li) return;
    if (e.key === "Delete" || e.key === "Backspace") deleteNote(note);
    else if (e.key === "Enter") editNote(li, note);
    else return;
    e.preventDefault();
  });
  swipeable(li, body, note);
  return li;
}
/** Swiping a note sideways: past SWIPE px to the left deletes it, to the right edits it; less
 *  springs back. Up and down still scroll the list (touch-action: pan-y). */
const SWIPE = 70;
function swipeable(li, body, note) {
  let start = null, dx = 0, swipedAt = 0;
  const reset = () => {
    start = null;
    li.classList.remove("swiping", "left", "right", "past");
    body.style.transform = "";
  };
  li.addEventListener("pointerdown", (e) => {
    if (e.button > 0 || noteEditing) return;
    start = { x: e.clientX, y: e.clientY, id: e.pointerId, on: false };
    dx = 0;
  });
  li.addEventListener("pointermove", (e) => {
    if (e.pointerId !== start?.id) return;
    const x = e.clientX - start.x, y = e.clientY - start.y;
    if (!start.on) {
      if (Math.abs(y) > 12 && Math.abs(y) > Math.abs(x)) return reset();   // a scroll
      if (Math.abs(x) < 12) return;
      start.on = true;
      try { li.setPointerCapture(e.pointerId); } catch { /* a pointer already gone: nothing to follow */ }
      li.classList.add("swiping");
    }
    dx = x;
    body.style.transform = `translateX(${dx}px)`;
    li.classList.toggle("left", dx < 0);
    li.classList.toggle("right", dx > 0);
    li.classList.toggle("past", Math.abs(dx) >= SWIPE);
  });
  li.addEventListener("pointerup", (e) => {
    if (e.pointerId !== start?.id) return;
    const swiped = start.on;
    reset();
    if (!swiped) return;
    swipedAt = Date.now();
    if (dx <= -SWIPE) deleteNote(note);
    else if (dx >= SWIPE) editNote(li, note);
  });
  li.addEventListener("pointercancel", (e) => { if (e.pointerId === start?.id) reset(); });
  li.addEventListener("click", (e) => { if (Date.now() - swipedAt < 500) e.stopPropagation(); }, true);   // the end of a swipe isn't a tap
}
/** Edits a note in its place: Enter (or leaving the box) keeps the change, Escape doesn't; emptied, it is deleted. */
function editNote(li, note) {
  if (noteEditing) return;
  noteEditing = note.id;
  const box = el("textarea", { className: "note-edit", value: note.text, rows: Math.min(6, note.text.split("\n").length + 1),
    enterKeyHint: "done", ariaLabel: "Edit the note" });
  li.querySelector(".note-text").replaceWith(box);
  box.focus();
  box.setSelectionRange(box.value.length, box.value.length);
  let done = false;
  const finish = (keep) => {
    if (done) return;
    done = true;
    noteEditing = null;
    const text = box.value.trim();
    if (keep && !text) deleteNote(note);
    else if (keep && text !== note.text) changeNote({ ...note, text, updated: noteStamp(note.updated) });
    else drawNotes();
  };
  box.addEventListener("keydown", (e) => {
    if (isEnter(e)) finish(true);
    else if (e.key === "Escape") finish(false);
    else return;
    e.preventDefault();
    e.stopPropagation();
  });
  box.addEventListener("blur", () => finish(true));
}
let notesSyncing = null, notesAgain = false;
function syncNotes() {
  if (!gh || !S.repoKey || !S.id) return Promise.resolve(false);
  if (notesSyncing) { notesAgain = true; return notesSyncing; }
  const id = S.id, rec = S.rec, key = S.repoKey, name = S.videoName;
  if (!rec.notesSynced && rec.notes?.length && !rec.notesPending?.length) rec.notesPending = rec.notes.slice();
  const sent = (rec.notesPending || []).slice();
  notesSyncing = gh.update(`notes/${key}.json`, (cur) => (sent.length
    ? { video: name, notes: applyNoteChanges(cur?.notes, sent), updated: new Date().toISOString() } : undefined),
  `Notes on ${name}`).then((data) => {
    rec.notesPending = (rec.notesPending || []).slice(sent.length);
    Object.assign(rec, { notesSynced: true, notesError: null });
    rec.notes = applyNoteChanges(data?.notes, rec.notesPending);
    if (S.id !== id) store.save(id, structuredClone(rec));
    else save();
    return true;
  }).catch((err) => {
    rec.notesError = err.kind === "offline" ? null : err.message;
    return false;
  }).finally(() => {
    notesSyncing = null;
    if (S.id === id) drawNotes();
    if (notesAgain) { notesAgain = false; syncNotes(); }
  });
  drawNotes();
  return notesSyncing;
}

// ---------------------------------------------------------------- one lecture after another
// A lecture opened from the library plays among its folder's (the library's order, hidden ones
// passed over); Play by tag gives a list instead. The bar's previous and next buttons go through it
// in that order, whatever the end mode. The end mode button says what happens when a lecture ends in
// the app: the next one is put in place, paused (Stop); the next one plays, up to the last one; or a
// random one plays (transcribed ones first) until each has played once. The two that go on are drawn
// in the highlight color. The lecture that comes next is fetched ahead, so that it opens quickly
// (fetchAhead). Leaving the player sets the mode back to Stop. A folder's in-order button plays it to
// its end from its first new lecture (playFolderOn). A lecture that ends while the app is hidden just
// stops; the next one is put in place, paused, once the app is back (nextOnReturn).
let scope = null;   // {folder} or {list, label}, with played: the paths played in it (for random)
let endMode = "stay";   // one of END_MODES
let coming = null;   // {it, play}: the lecture opening in place of the one before (showComing), and whether it plays once open
let endSeen = null;   // S.picked once its end is dealt with: an end said again (the video taking over from bg there) counts once
let endAway = null;   // {picked, it}: a lecture that ended while the app was hidden, and the one to put in its place when it's back
const lectureTitle = (it) => it.name.replace(/\.[^.]+$/, "");
/** The lectures the open one plays among: a list by tag, or its folder's without the hidden ones
 *  (but with the open one, hidden or not, so that the steps go on from it). */
function scopeList() {
  if (!scope) return [];
  const open = openItem()?.path;
  return scope.list ?? library.items.filter((i) => i.folder === scope.folder && (!library.hidden.has(i.hash) || i.path === open));
}
const scopeName = () => (scope?.list ? "in the list" : "in this folder");
/** The library's item for the lecture open: streamed from Dropbox, or a copy of one (the same video). */
function openItem() {
  const d = S.picked?.dropbox, fp = S.picked?.fingerprint;
  return library.items.find((i) => (d?.path ? i.path === d.path : fp && i.entry?.fingerprint === fp)) ?? null;
}
/** Opens a library lecture, which then plays: among `within` (a scope), else among its folder's;
 *  from where it was left, or from its start (`opts.fromStart`). */
async function playItem(it, within, opts) {
  const fresh = library.items.find((i) => i.path === it.path) ?? it;   // a list keeps its items as they were
  await openFromDropbox(fresh, within, opts);
}
/** The scope; a lecture opened another way that is in the library too (a copy on this device) plays
 *  among its folder's. */
function ensureScope() {
  const now = !scope && openItem();
  if (now) scope = { folder: now.folder, played: new Set() };
  return scope;
}
/** The bar's previous (-1) and next (1) buttons: that lecture from its start. */
function stepLecture(dir) {
  const now = ensureScope() && openItem(), it = now && neighbor(scopeList(), now, dir);
  if (!it || library.opening) return;
  save();   // the lecture left keeps the very spot
  pausePlayback();
  putInPlace(it, true);
}
/** The lecture `it` in place of the open one, from its start: its name and length show at once; it
 *  plays once open if `play` (a tap on play meanwhile changes that). */
function putInPlace(it, play) {
  if (!dbx || library.opening) return;   // it couldn't open now
  showComing(it, play);
  playItem(it, scope, { fromStart: true, coming });
}
function drawSteps() {
  const now = ensureScope() && openItem(), list = scopeList(), can = (dir) => !!(now && neighbor(list, now, dir));
  $("prevBtn").disabled = !can(-1);
  $("nextBtn").disabled = !can(1);
  drawEndMode();   // it names the folder or the list
  drawThisLecture();
}
$("prevBtn").addEventListener("click", () => stepLecture(-1));
$("nextBtn").addEventListener("click", () => stepLecture(1));
/** A folder's in-order button: the folder plays one lecture after another to its end, from its first
 *  new lecture, else the one played last on this device, else its first. */
async function playFolderOn(folder) {
  allowMedia();   // the tap
  const list = library.items.filter((i) => i.folder === folder && !library.hidden.has(i.hash));
  let it = list.find(isNew);
  if (!it) {   // its lectures' records on this device say when each was opened last
    const recs = (await store.list()).filter((r) => r.lastOpened && r.dropbox);
    const byHash = new Map(recs.map((r) => [r.dropbox.hash, r.lastOpened])), byPath = new Map(recs.map((r) => [r.dropbox.path.toLowerCase(), r.lastOpened]));
    const opened = (i) => (i && (byHash.get(i.hash) ?? byPath.get(i.path.toLowerCase()))) || 0;
    it = list.reduce((best, i) => (opened(i) > opened(best) ? i : best), null);
  }
  it ??= list[0];
  if (!it) return;
  setEndMode("next");
  playItem(it);
}
/** A random lecture to follow `now` that hasn't played in the scope yet (transcribed ones first), or
 *  null once each has. */
function pickRandom(now) {
  scope.played.add(now.path);
  return randomOther(scopeList(), now, scope.played);
}
/** The lecture that follows `now` as the end mode says, or null: the next one (also for Stop, which
 *  puts it in place without playing it), or a random one (the one chosen ahead, while it still may be). */
function nextAfter(now) {
  if (endMode !== "shuffle") return neighbor(scopeList(), now, 1);
  const c = upNext?.mode === "shuffle" && upNext.it;
  return c && c.path !== now.path && !scope.played.has(c.path) && scopeList().some((i) => i.path === c.path) ? c : pickRandom(now);
}
/** When a lecture ends: the next one is put in place from its start (its name and length show at
 *  once; fetched ahead, it opens quickly), and plays unless the end mode is Stop. With the app hidden
 *  the lecture just ends, and the next one is put in place, paused, once the app is back. */
function lectureEnded() {
  S.playing = false;
  if (endSeen === S.picked) return;   // the same end again
  endSeen = S.picked;
  const ended = ensureScope() && openItem();
  if (!ended) return;
  const it = nextAfter(ended), away = document.hidden;   // before the one that ended may be hidden
  if (!it && !away) toast(endMode === "shuffle" ? `Every lecture ${scopeName()} has played.` : `That was the last lecture ${scopeName()}.`);
  countFinished(ended);
  if (!it || library.opening) return;
  if (away) endAway = { picked: S.picked, it };
  else putInPlace(it, endMode !== "stay");
}
/** Back in the app after a lecture ended while it was hidden: the next one in its place, paused. */
function nextOnReturn() {
  const away = endAway;
  endAway = null;
  if (away && away.picked === S.picked && !player.hidden && media().paused && !library.opening) putInPlace(away.it, false);
}
// Plays to the end, kept on this device by file (Dropbox's content hash) with when each was, the last
// 20: Settings → Hiding files hides a lecture once it has played to the end prefs.hideAfter times (0:
// never) in the last prefs.hideWithin days (0: at any time). Only ever hides; a file put back starts
// afresh. (3.4.0 kept counts without dates: they are dropped.)
const PLAYED_TO_END_KEY = "lecture-karaoke.playedToEnd", DAY_MS = 86400000;
try { localStorage.removeItem("lecture-karaoke.finished"); } catch { /* none */ }
function playsToEnd() {
  try { return JSON.parse(localStorage.getItem(PLAYED_TO_END_KEY) || "{}") || {}; } catch { return {}; }
}
function keepPlaysToEnd(plays) {
  try { localStorage.setItem(PLAYED_TO_END_KEY, JSON.stringify(plays)); } catch { /* not kept */ }
}
function countFinished(it) {
  const plays = playsToEnd(), now = Date.now(), times = [...(plays[it.hash] || []), now].slice(-20);
  plays[it.hash] = times;
  keepPlaysToEnd(plays);
  const days = prefs.hideWithin, n = days ? times.filter((t) => now - t < days * DAY_MS).length : times.length;
  if (prefs.hideAfter && n >= prefs.hideAfter && !library.hidden.has(it.hash)) {
    const when = days ? ` in the last ${days === 1 ? "day" : `${days} days`}` : "";
    setHidden([it], true, { undoMs: 3000, says: `Hid “${lectureTitle(it)}”: played to the end ${n === 1 ? "once" : `${n} times`}${when}.` });
  }
}
function forgetFinished(items) {
  const plays = playsToEnd();
  for (const it of items) delete plays[it.hash];
  keepPlaysToEnd(plays);
}
/** As the next lecture opens, before anything about it is fetched: its name and length (the index's)
 *  in the bar, the window's title and on the lock screen, and the subtitles of the one before give way
 *  to a line saying it loads. The play button says whether it plays once open (`play`). */
function showComing(it, play) {
  coming = { it, play };
  drawPlayLook(play);
  $("barTitle").textContent = $("barTitle").title = it.name;
  document.title = `${lectureTitle(it)} · Lecture Karaoke`;
  $("time").textContent = clock(0);
  $("timeEnd").textContent = clock((it.entry?.duration_ms || 0) / 1000);
  $("seek").value = 0;
  S.events = [];   // the karaoke of the one before stops
  S.shown = -2;
  draw(-1);
  $("next").textContent = `Loading ${lectureTitle(it)}…`;
  if (mediaSession && typeof MediaMetadata === "function") {
    try { mediaSession.metadata = new MediaMetadata({ title: lectureTitle(it), artist: shownFolder(it.folder), album: "Lecture Karaoke" }); } catch { /* not here */ }
  }
}
/** The next lecture couldn't be opened: the bar, the subtitles and the lock screen are the open
 *  lecture's again. */
function unshowComing() {
  $("barTitle").textContent = $("barTitle").title = S.videoName;
  document.title = `${S.videoName.replace(/\.[^.]+$/, "")} · Lecture Karaoke`;
  S.lastSecond = -1;   // its time and length
  if (S.pieces?.length) rebuildEvents();
  else { S.shown = -2; draw(-1); }
  setLook();
}
const END_LOOKS = {
  stay: { svg: () => STAY_SVG, says: () => `When a lecture ends, playback stops, with the next one ${scopeName()} ready to play.` },
  next: { svg: () => LIST_SVG, says: () => `When a lecture ends, the next one ${scopeName()} plays, up to the last one.`, always: true },
  shuffle: { svg: () => SHUFFLE_SVG, says: () => `When a lecture ends, a random one ${scopeName()} plays, until each has played once.`, always: true },
};
const endSays = () => { const s = END_LOOKS[endMode].says; return typeof s === "function" ? s() : s; };
function setEndMode(mode) {
  endMode = mode;
  drawEndMode();
}
function drawEndMode() {
  const b = $("endBtn"), look = END_LOOKS[endMode];
  b.innerHTML = look.svg();
  b.classList.toggle("always", !!look.always);
  b.setAttribute("aria-label", `End mode: ${endSays()}`);
  b.title = endSays();
}
$("endBtn").addEventListener("click", () => setEndMode(nextEndMode(endMode)));   // its icon says the mode
const STAY_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 12h11M10.5 7l5 5-5 5M20 5v14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

// ---------------------------------------------------------------- sleep timer
// The moon button: playback pauses after the minutes chosen. While it runs the button is lit and the
// dialog says how long is left (no toasts: the button shows it). A timer checks, and so does the
// lecture as it plays (timers may wait while the app is in the background).
const SLEEP_PRESETS = [5, 10, 15, 20, 30, 45, 60, 90];
let sleep = null;   // {at, timer}
function setSleep(min) {
  clearTimeout(sleep?.timer);
  sleep = min > 0 ? { at: Date.now() + min * 60000, timer: setTimeout(checkSleep, min * 60000 + 100) } : null;
  drawSleep();
}
function checkSleep() {
  if (!sleep || Date.now() < sleep.at) return;
  setSleep(0);
  pausePlayback();
}
function drawSleep() {
  const left = sleep ? clock(Math.max(0, sleep.at - Date.now()) / 1000) : "";
  $("sleepBtn").setAttribute("aria-pressed", String(!!sleep));
  $("sleepBtn").title = sleep ? `Sleep timer: pauses in ${left}` : "Sleep timer";
  $("sleepSays").textContent = sleep ? `Pauses in ${left}.` : "Pauses playback after the minutes you choose.";
  $("sleepOff").hidden = !sleep;
}
setInterval(() => { if (sleep) { checkSleep(); if (sleep && $("sleepDialog").open) drawSleep(); } }, 1000);
function startSleep(min) {
  $("sleepDialog").close();
  setSleep(min);
}
$("sleepPresets").append(...SLEEP_PRESETS.map((m) => {
  const b = el("button", { type: "button", className: "chip", textContent: `${m} min` });
  b.addEventListener("click", () => startSleep(m));
  return b;
}));
$("sleepBtn").addEventListener("click", () => {
  $("sleepMin").value = prefs.sleepMin || 30;
  drawSleep();
  $("sleepDialog").showModal();
});
$("sleepStart").addEventListener("click", () => {
  const m = Math.round(Number($("sleepMin").value));
  if (!(m >= 1 && m <= 600)) return $("sleepMin").focus();
  prefs.sleepMin = m;
  savePrefs();
  startSleep(m);
});
$("sleepMin").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("sleepStart").click(); } });
$("sleepOff").addEventListener("click", () => { setSleep(0); $("sleepDialog").close(); });
$("sleepCancel").addEventListener("click", () => $("sleepDialog").close());

// ---------------------------------------------------------------- the lock screen, and playing on in the background
// A phone stops a video, sound and all, when the screen locks or the app goes to the background
// (iPhone does so with anything that has a picture), but lets audio play on. So on a phone the open
// lecture is loaded in an audio element too (bg: its index, not the whole stream), and when the app is
// hidden while it plays, the sound goes on from bg, from the same moment at the same speed, after a
// moment while bg fetches it from there; back in the app the video takes over from where bg is. The
// phone lets bg start only right away, while the video's sound has just stopped. That is all: a
// lecture that ends with the app hidden just ends (the end mode acts in the app), and a recording plays
// on by itself. The lock screen shows the lecture and whether it plays, with play/pause only and no
// seek bar (drawNowPlaying). While bg sounds the video is muted too: WebKit gives the lock screen to
// the largest element that may sound, so a paused video kept it and showed ▶ while bg played (muted
// ones don't count).
const BG = isMobile;   // a computer plays on in the background by itself
const bg = Object.assign(document.createElement("audio"), { preload: "metadata" });
let bgOn = false, bgUrl = "";   // bgOn: the sound comes from bg; bgUrl: its stream
/** The element the lecture plays from: the video, or bg while the app is hidden. */
const media = () => (bgOn ? bg : video);
const hasPicture = () => !(S.picked?.audio || (video.readyState && !video.videoWidth));
const folderRate = (folder) => (folder != null && prefs.folderRates[folder.toLowerCase()]) || prefs.rate;
const mediaSession = "mediaSession" in navigator ? navigator.mediaSession : null;
/** Sets a lock-screen (Media Session) action. */
function setAction(name, fn) {
  try { mediaSession?.setActionHandler(name, fn); } catch { /* not this one here */ }
}
/** A phone lets an element play by itself only once a tap has played it: the first tap that leads to
 *  playing gives the video and bg a moment of that, muted and paused at once (allowMedia). */
const unlocked = new WeakSet();
function allowPlay(el) {
  const tap = navigator.userActivation?.isActive;
  if (!isMobile || unlocked.has(el) || tap === false || !el.paused || (el === bg && bgOn)) return;
  if (tap) unlocked.add(el);   // a browser that can't tell tries again on the next tap
  if (el === bg) try { if (navigator.audioSession) navigator.audioSession.type = "playback"; } catch { /* not here */ }
  const muted = el.muted;
  el.muted = true;
  el.play().catch(() => {});
  el.pause();
  el.muted = muted;
}
/** In a tap that opens or plays a lecture: the video plays once it is open, and bg when the app is hidden. */
function allowMedia() {
  allowPlay(video);
  allowPlay(bg);
}
/** bg loads the lecture opened, ready to take over. */
function loadBg() {
  if (!BG || bgOn || !S.videoUrl || bgUrl === S.videoUrl) return;
  bgUrl = S.videoUrl;
  bg.src = bgUrl;
}
/** Plays the open lecture: the video, or bg while the app is hidden. */
function resume() {
  allowMedia();
  if (player.hidden || !S.videoUrl) return;
  if (BG && document.hidden) playHidden();
  else video.play().catch(() => {});
}
function pausePlayback() {
  S.playing = false;
  media().pause();
}
/** The sound from bg, at the video's speed: from `at` s, else from where the video is (or, paused
 *  there, where bg is). The video pauses, also so that the phone doesn't play it again when it is
 *  unlocked. */
function playHidden(at) {
  if (at != null || !bgOn || bgUrl !== S.videoUrl) {
    at ??= video.readyState ? video.currentTime : S.startAt;
    if (bgUrl !== S.videoUrl || !bg.readyState) {
      bgUrl = S.videoUrl;
      bg.src = `${bgUrl}#t=${at.toFixed(3)}`;   // a media fragment: from there
    } else bg.currentTime = at;
    bg.defaultPlaybackRate = bg.playbackRate = video.playbackRate;
  }
  bgOn = true;
  S.playing = true;
  bg.play().catch(() => {
    if (!bgOn || !bg.paused) return;
    bgOn = false;   // not allowed now (the lock screen's play button is)
    S.playing = false;
    drawNowPlaying();
  });
  S.handing = true;   // not the viewer's pause
  video.pause();
  S.handing = false;
}
/** Back in the app: the video takes over from where bg is. */
function toForeground() {
  video.muted = false;   // it was while bg played
  if (!bgOn) return;
  const at = bg.currentTime, playing = !bg.paused && !bg.ended, picked = S.picked;
  bgOn = false;
  bg.pause();
  const go = () => {
    if (S.picked !== picked) return;   // another lecture is in place by now
    video.currentTime = at;
    if (playing) video.play().catch(() => {});
    else drawNowPlaying();
  };
  if (video.readyState && !S.swapping) go();
  else video.addEventListener("loadedmetadata", go, { once: true });
}
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) { toForeground(); nextOnReturn(); }
  else if (BG && S.playing && !bgOn && !player.hidden && !video.ended && hasPicture()) playHidden();
});

// The lectures that may come next, fetched ahead so that they open at once (then only the video has
// to load): the next one in the folder or list, as soon as the open lecture plays (or 3 s after it
// opened), for ⏭, the end mode's next and the one Stop puts in place; and 30 s before the end, the one
// the end mode picks (shuffle's random one is chosen then and kept: upNext). Each gets its Dropbox
// link (kept by linkFor), its transcript (kept here, by path) and what the player needs to know of
// the file (dropboxMediaInfo keeps that). (3.1.0 to 3.3.0 also loaded the next one's sound ahead, in
// bg; on iPhone the video then didn't load until paused and played again.)
const ahead = new Map();   // path → {ref, text: a promise of its transcript text, or of null}
let upNext = null;   // {it, mode}: the lecture to follow the open one, chosen near its end in that end mode
function fetchAhead(it) {
  if (!it || !dbx || ahead.has(it.path)) return;
  it = library.items.find((i) => i.path === it.path) ?? it;   // a list by tag keeps its items as they were
  const ref = it.status === "ready" ? transcriptRef(it) : null;
  ahead.set(it.path, { ref, text: ref ? transcriptFile(ref).catch(() => null) : Promise.resolve(null) });
  while (ahead.size > 3) ahead.delete(ahead.keys().next().value);
  linkFor(it.path).catch(() => {});
  dropboxMediaInfo(it).catch(() => {});
}
/** The next lecture in the folder or list, fetched ahead once the open one has loaded enough to play on
 *  (canplaythrough), or 8 s after it opened: the stream comes first, above all at a high speed. */
function aheadSoon(picked) {
  const go = () => {
    clearTimeout(timer);
    video.removeEventListener("canplaythrough", go);
    const now = S.picked === picked && !player.hidden && ensureScope() && openItem();
    if (now) fetchAhead(neighbor(scopeList(), now, 1));
  };
  const timer = setTimeout(go, 8000);
  video.addEventListener("canplaythrough", go);
}

// While the video waits for its stream (it plays faster than the connection brings it, at a high
// speed say), "Loading…" shows over it, so that the pause isn't a mystery; it goes on by itself. And
// if it stands still while it has what it needs (readyState 3 or more, which a stalled player can do
// after a while at a high speed), a tiny seek starts it again.
let loadingTimer = 0;
const waitingNow = () => !player.hidden && !bgOn && S.playing && !video.paused && !video.ended && video.readyState < 3;
video.addEventListener("waiting", () => {
  clearTimeout(loadingTimer);
  loadingTimer = setTimeout(() => { $("loadingNote").hidden = !waitingNow(); }, 500);
});
for (const ev of ["playing", "pause", "ended", "emptied", "canplay"]) {
  video.addEventListener(ev, () => { clearTimeout(loadingTimer); if (!waitingNow()) $("loadingNote").hidden = true; });
}
const still = { at: -1, since: 0, nudged: 0 };
setInterval(() => {
  if (player.hidden || bgOn || document.hidden || !S.playing || video.paused || video.ended || video.seeking || S.swapping || video.readyState < 3) {
    still.since = 0;
    return;
  }
  const t = video.currentTime, now = Date.now();
  if (t !== still.at || !still.since) { still.at = t; still.since = now; return; }
  if (now - still.since > 6000 && now - still.nudged > 15000) {
    still.nudged = now;
    still.since = 0;
    video.currentTime = t + 0.01;
  }
}, 1000);
video.addEventListener("timeupdate", () => {
  if (upNext || document.hidden || player.hidden || video.paused || !(video.duration > 0)) return;
  if ((video.duration - video.currentTime) / (video.playbackRate || 1) <= 30) readyNext();
});
function readyNext() {
  const now = dbx && ensureScope() && openItem(), it = now && nextAfter(now);
  if (!it) return;
  upNext = { it, mode: endMode };
  fetchAhead(it);
}

for (const el of [video, bg]) {
  const mine = (fn) => () => { if (el === media()) fn(); };
  el.addEventListener("ended", mine(lectureEnded));
  el.addEventListener("playing", () => { endSeen = endAway = null; });   // played again: its next end counts too
  el.addEventListener("playing", mine(() => { const now = ensureScope() && openItem(); if (now) scope.played.add(now.path); }));
  el.addEventListener("timeupdate", mine(() => { if (sleep) checkSleep(); }));
  for (const ev of ["playing", "pause", "ratechange", "seeked", "loadedmetadata", "ended"]) el.addEventListener(ev, mine(drawNowPlaying));
}
bg.addEventListener("playing", () => queuePlayed([playingFile()]));
bg.addEventListener("playing", () => { if (bgOn) video.muted = true; });   // the lock screen goes with bg
bg.addEventListener("error", () => {   // an expired link
  if (!bgOn || !stream || Date.now() - stream.lastError < 20000) return;
  stream.lastError = Date.now();
  renewStream();
});
/** The lock screen's state: playing or not (once it really plays), and the position, but with no end
 *  (an infinite duration, which WebKit leaves out), so that the phone draws no seek bar. */
function drawNowPlaying() {
  if (!mediaSession) return;
  const m = media();
  mediaSession.playbackState = player.hidden ? "none" : m.paused || m.ended ? "paused" : "playing";
  try {
    mediaSession.setPositionState({ duration: Infinity, playbackRate: m.playbackRate || 1, position: m.currentTime || 0 });
  } catch { /* not here */ }
}
// The lock screen's buttons: play/pause only. WebKit offers the phone just the actions that have a
// handler, so it shows no skip buttons either.
setAction("play", () => (coming ? comingPlays(true) : resume()));   // while the next lecture is put in place: whether it plays
setAction("pause", () => (coming ? comingPlays(false) : pausePlayback()));

// Dropbox links, kept for opening a lecture again while they last (4 hours).
const links = new Map();   // path → {link, fetched}
const asking = new Map();   // path → the promise of a link being asked for (ahead, say), which an open then waits for
async function linkFor(path) {
  const got = links.get(path);
  if (got && Date.now() - got.fetched < LINK_RENEW_MS) return got;
  if (!asking.has(path)) {
    asking.set(path, dbx.temporaryLink(path).then(({ link }) => {
      const fresh = { link, fetched: Date.now() };
      links.set(path, fresh);
      return fresh;
    }).finally(() => asking.delete(path)));
  }
  return asking.get(path);
}

// ⋯ Settings → This lecture, and the bar's star: a library lecture's star, as in the list. The bar's
// hide button takes the open lecture off the library's list (lit while it is off it; a tap puts it
// back), as hide mode's eye does there, with Undo for 3 s. It plays on, and ⏮/⏭ still go on from it.
$("starBtn").innerHTML = STAR_SVG;
$("hideBtn").innerHTML = EYE_OFF_SVG;
function drawThisLecture() {
  const it = !player.hidden && openItem(), important = !it || !library.unimportant.has(it.hash);
  $("thisSet").hidden = !it;
  if (it) $("thisImportant").checked = important;
  const b = $("starBtn");
  b.disabled = !it;
  b.setAttribute("aria-pressed", String(important));
  b.title = !it ? "Important: for lectures in the Dropbox library"
    : important ? "Important (tap: not important, left out of Play by tag)" : "Not important: left out of Play by tag (tap: important)";
  const h = $("hideBtn"), hidden = !!it && library.hidden.has(it.hash);
  h.disabled = !it;
  h.setAttribute("aria-pressed", String(hidden));
  h.title = !it ? "Hide from the list: for lectures in the Dropbox library" : hidden ? "Hidden from the list (tap: show it in the list again)" : "Hide from the list";
}
$("hideBtn").addEventListener("click", () => { const it = openItem(); if (it) setHidden([it], !library.hidden.has(it.hash), { undoMs: 3000 }); });
$("thisImportant").addEventListener("change", () => { const it = openItem(); if (it) setImportant([it], $("thisImportant").checked); });
$("starBtn").addEventListener("click", () => { const it = openItem(); if (it) setImportant([it], library.unimportant.has(it.hash), true); });

// ---------------------------------------------------------------- settings
function openSettings() {
  syncOffsetControls();
  syncSplitControls();
  drawSyncNote();
  $("sync").value = S.syncMs;
  $("syncOut").textContent = `${S.syncMs > 0 ? "+" : ""}${S.syncMs} ms`;
  $("language").value = S.language;
  $("offsetInfo").textContent = isFirefox ? "" :
    S.audioOffsetMs ? `This file's audio starts ${S.audioOffsetMs} ms in; that is already allowed for.` : "";
  drawFixList();
  drawTranscriptLinks();
  drawThisLecture();
  drawView();
  $("hideAfter").value = String(prefs.hideAfter);
  $("hideWithin").value = String(prefs.hideWithin);
  $("hideWithin").disabled = !prefs.hideAfter;
  $("settings").classList.toggle("no-lecture", player.hidden);   // from the start screen
  $("settings").showModal();
  renderGet();
}
$("hideAfter").addEventListener("change", () => {
  prefs.hideAfter = Number($("hideAfter").value) || 0;
  $("hideWithin").disabled = !prefs.hideAfter;
  savePrefs();
});
$("hideWithin").addEventListener("change", () => {
  prefs.hideWithin = Number($("hideWithin").value) || 0;
  savePrefs();
});
$("settings").addEventListener("close", drawLive);
function syncSplitControls() {
  const o = orient(), [lo, hi] = SPLIT_RANGE[o], share = videoShare();
  Object.assign($("split"), { min: lo * 100, max: hi * 100 });
  $("split").value = Math.round(share * 100);
  $("splitLabel").textContent = `Video area (${o})`;
  $("splitOut").textContent = `${Math.round(share * 100)}% of the ${o === "landscape" ? "width" : "height"}` +
    (prefs.split[o] == null ? " · auto" : "");
}
$("split").addEventListener("input", () => setSplit(Number($("split").value) / 100));
$("split").addEventListener("change", savePrefs);
$("splitReset").addEventListener("click", () => { setSplit(null); savePrefs(); });
$("sync").addEventListener("input", () => {
  S.syncMs = Number($("sync").value);
  $("syncOut").textContent = `${S.syncMs > 0 ? "+" : ""}${S.syncMs} ms`;
  rebuildEvents();
});
$("sync").addEventListener("change", save);
$("language").addEventListener("change", () => { S.language = $("language").value; if (S.transcript) { rebuildLayout(); save(); } });
function goHome() {
  if ($("settings").open) $("settings").close();
  setNotesOpen(false);
  cancelCropping();
  scope = null;
  if (arranging) setArranging(false);
  if (!lockLayer.hidden) setLocked(false);
  pausePlayback();
  video.pause();
  bgOn = false;
  video.muted = false;
  upNext = coming = endAway = null;
  ahead.clear();
  setEndMode("stay");   // the end mode starts at stop every time
  save();
  player.hidden = true;
  drawNowPlaying();
  setLook();
  $("welcome").hidden = false;
  document.title = "Lecture Karaoke";
  Object.assign(S, { videoFile: null, jsonFile: null, picked: S.picked, wanted: null });
  setStep("video", "Choose the lecture video or audio", false);
  setStep("json", "Choose its .json file", false);
  updateStart();
  drawRecent();
  W = null;   // a transfer still running carries on (the line at the top shows it)
  stream = null;
  stopPolling();
  renderGet();
  loadLibrary();
}
$("openOther").addEventListener("click", goHome);
$("arrangeBtn").addEventListener("click", () => { $("settings").close(); setArranging(true); });

// ---------------------------------------------------------------- GitHub settings
function openGhDialog() {
  const cfg = ghConfig();
  $("ghRepo").value = cfg?.repo || "Tien3991/lecture-transcripts";
  $("ghToken").value = "";
  $("ghToken").placeholder = cfg?.token ? "saved (leave empty to keep it)" : "github_pat_…";
  $("ghStatus").textContent = "";
  $("ghRemove").hidden = !cfg;
  $("ghDialog").showModal();
}
$("ghLine").addEventListener("click", openGhDialog);
$("ghOpen").addEventListener("click", openGhDialog);
$("ghCancel").addEventListener("click", () => $("ghDialog").close());
$("ghRemove").addEventListener("click", () => {
  try { localStorage.removeItem(GH_KEY); } catch { /* storage unavailable */ }
  connect(null);
  $("ghDialog").close();
  toast("Disconnected; the token was removed from this device");
});
$("ghDialog").querySelector("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const repo = $("ghRepo").value.trim().replace(/^https:\/\/github\.com\//, "").replace(/(\.git|\/)$/, "");
  const token = $("ghToken").value.trim() || ghConfig()?.token;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !token) {
    $("ghStatus").textContent = "Enter the repository as owner/name, and a token.";
    return;
  }
  $("ghStatus").textContent = "Checking…";
  try {
    const test = new GitHub({ repo, token, api: devApi() });
    const info = await test.repoInfo();
    const index = await test.readText("index.json");
    const count = index ? (JSON.parse(index.text).videos || []).length : 0;
    try { localStorage.setItem(GH_KEY, JSON.stringify({ repo, token })); } catch { /* kept for this visit only */ }
    connect({ repo, token });
    $("ghDialog").close();
    toast(`Connected to ${repo}: ${count} transcript${count === 1 ? "" : "s"}` + (info.private ? "" : ". Warning: this repository is public!"));
    if (!player.hidden && S.transcript) linkToRepo();
  } catch (err) {
    $("ghStatus").textContent = err.message;
  }
});
function drawFixList() {
  const fixes = S.rec.fixes || [];
  $("fixList").replaceChildren(...(fixes.length ? fixes.map((f) => {
    const li = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = `${clock((f.start_ms + S.audioOffsetMs) / 1000)}  “${f.old}” → ${f.new ? `“${f.new}”` : "removed"}`;
    const undo = Object.assign(document.createElement("button"), { type: "button", textContent: "Undo" });
    undo.addEventListener("click", () => {
      changeFix({ start_ms: f.start_ms, old: f.old, new: null });
      drawFixList();
    });
    li.append(label, undo);
    return li;
  }) : [Object.assign(document.createElement("li"), { textContent: "No fixes yet: turn on Fix and tap a word." })]));
}
$("exportBtn").addEventListener("click", async () => {
  if (!S.transcript) return toast("There is no transcript yet.");
  const base = S.videoName.replace(/\.[^.]+$/, "");
  const files = [
    new File([JSON.stringify(exportTranscript(S.transcript, S.words, S.rec.fixes || [], S.videoName))],
      `${base}.json`, { type: "application/json" }),
    new File([transcriptText(S.words)], `${base} - transcript.txt`, { type: "text/plain" }),
  ];
  // Phones and tablets save files through the share sheet ("Save to Files"); computers download.
  if (isMobile && navigator.canShare?.({ files })) {
    try { await navigator.share({ files, title: base }); return; } catch (err) { if (err.name === "AbortError") return; }
  }
  for (const f of files) {
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(f), download: f.name });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }
});

// Settings → Transcript: a link to the lecture's transcript with its word fixes as plain text (one
// sentence per line) and one as JSON. Phones and tablets open the share sheet (Save to Files, Copy,
// other apps); computers download the file.
function transcriptAs(kind) {
  const base = S.videoName.replace(/\.[^.]+$/, "");
  return kind === "json"
    ? new File([JSON.stringify(exportTranscript(S.transcript, S.words, S.rec.fixes || [], S.videoName))], `${base}.json`,
      { type: "application/json" })
    : new File([transcriptText(S.words)], `${base}.txt`, { type: "text/plain" });
}
/** Points the link at a fresh copy of the transcript; returns that file. */
function linkTranscript(a, kind) {
  if (a.href.startsWith("blob:")) URL.revokeObjectURL(a.href);
  const file = transcriptAs(kind);
  Object.assign(a, { href: URL.createObjectURL(file), download: file.name });
  return file;
}
function drawTranscriptLinks() {
  const links = [[$("txText"), "text"], [$("txJson"), "json"]];
  for (const [a, kind] of links) {
    a.hidden = !S.transcript;
    if (S.transcript) linkTranscript(a, kind);
  }
  $("txNote").textContent = S.transcript
    ? "This lecture's transcript with your word fixes: one sentence per line, or all of it with word timings."
    : "No transcript yet.";
}
for (const [id, kind] of [["txText", "text"], ["txJson", "json"]]) {
  $(id).addEventListener("click", async (e) => {
    if (!S.transcript) return e.preventDefault();
    const a = e.currentTarget, file = linkTranscript(a, kind);   // with the latest fixes
    if (!isMobile || !navigator.canShare?.({ files: [file] })) return;   // the link downloads it
    e.preventDefault();
    try {
      await navigator.share({ files: [file], title: file.name });
    } catch (err) {
      if (err.name !== "AbortError") Object.assign(document.createElement("a"), { href: a.href, download: file.name }).click();
    }
  });
}

// ---------------------------------------------------------------- remembering, wake lock, toast
let toastTimer = 0;
function save() {
  if (!S.id) return;
  S.rec.position = media().currentTime || S.rec.position || 0;
  Object.assign(S.rec, { syncMs: S.syncMs, language: S.language });
  delete S.rec.leadMs;        // 1.0.x kept the lead per transcript; it is a viewer preference now
  delete S.rec.lastLeadMs;
  store.save(S.id, structuredClone(S.rec));
}
setInterval(() => { if (!media().paused) save(); }, 5000);
addEventListener("pagehide", save);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) save();
  else if (!video.paused) keepAwake(true);
});

let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && "wakeLock" in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => (wakeLock = null));
    } else if (!on && wakeLock) {
      await wakeLock.release();
    }
  } catch { /* not allowed here: fine */ }
}

/** A message for a few seconds (ms), with a button for an action if given, and × to close it at once.
 *  In the player it shows at the top left, clear of the bar. */
function toast(text, actionLabel, action, ms = 5000) {
  const t = $("toast");
  t.replaceChildren(Object.assign(document.createElement("span"), { className: "toast-text", textContent: text }));
  if (actionLabel) {
    const b = Object.assign(document.createElement("button"), { type: "button", textContent: actionLabel });
    b.addEventListener("click", () => { action(); closeToast(); });
    t.append(b);
  }
  const x = Object.assign(document.createElement("button"), { type: "button", className: "toast-close", textContent: "×", title: "Close" });
  x.setAttribute("aria-label", "Close the message");
  x.addEventListener("click", closeToast);
  t.append(x);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(closeToast, ms);
}
function closeToast() {
  clearTimeout(toastTimer);
  $("toast").hidden = true;
}

// ---------------------------------------------------------------- start-up
$("version").textContent = `v${VERSION}`;
connect(ghConfig());
renderBar();
drawEndMode();
drawRecent();
addEventListener("online", () => syncFixes());
let lastPull = 0;
document.addEventListener("visibilitychange", () => {   // back in the app: other devices' fixes
  if (!document.hidden && !player.hidden && Date.now() - lastPull > 30000) { lastPull = Date.now(); syncFixes(); }
});
$("iosHint").hidden = !isIOS;
navigator.storage?.persist?.().catch(() => {});
if ("serviceWorker" in navigator && !dev) {
  navigator.serviceWorker.register("sw.js").then((reg) => {
    reg.addEventListener("updatefound", () => {
      const nw = reg.installing;
      nw?.addEventListener("statechange", () => {
        if (nw.state === "installed" && navigator.serviceWorker.controller) $("updateBanner").hidden = false;
      });
    });
  }).catch(() => {});
}
$("reloadBtn").addEventListener("click", () => location.reload());

// Development only (localhost): ?video=URL&json=URL opens files served by dev/serve.mjs.
if (dev) {
  window.__lk = { S, video, prefs, store, activeEvent, spokenCount, syncFixes, library, pickedVideo, openFromDropbox, renewStream,
    loadLibrary, pollTranscript, probeMedia, viz, get gh() { return gh; }, get dbx() { return dbx; }, get W() { return W; },
    get stream() { return stream; }, get transfer() { return transfer; }, get audioGraph() { return audioGraph; },
    bg, get bgOn() { return bgOn; }, get scope() { return scope; }, get endMode() { return endMode; },
    get upNext() { return upNext; }, ahead, links, get coming() { return coming; }, get endAway() { return endAway; },
    get endSeen() { return endSeen; }, lectureEnded, nextOnReturn, get view() { return view; }, get cropping() { return cropping; },
    get wholeFrame() { return wholeFrame; }, applyView, toast };   // for checks
  const q = new URLSearchParams(location.search);
  // ?pick=URL: as if that file had been picked on this device
  if (q.get("pick")) {
    (async () => {
      const url = q.get("pick"), blob = await (await fetch(url)).blob();
      pickedVideo(new File([blob], decodeURIComponent(url.split("/").pop()), { type: blob.type }));
    })().catch((err) => setProblems([`Dev pick failed: ${err.message}`]));
  }
  if (q.get("video") && q.get("json")) {
    (async () => {
      const vurl = q.get("video"), name = decodeURIComponent(vurl.split("/").pop());
      const data = await (await fetch(q.get("json"))).json();
      let picked;
      if (mediaKind(name) === "mp4") {
        const size = Number((await fetch(vurl, { method: "HEAD" })).headers.get("Content-Length"));
        const read = async (offset, length) => new Uint8Array(await (await fetch(vurl,
          { headers: { Range: `bytes=${offset}-${offset + length - 1}` } })).arrayBuffer());
        const info = await readMp4Info(read, size), audio = !info.tracks.some((t) => t.handler === "vide");
        picked = { url: vurl, name, size, info, fingerprint: await videoFingerprint(info, size), audio, art: audio ? mp4Artwork(info.moov) : null };
      } else {   // other audio: read whole, as if picked
        const { file, ...rest } = await probeMedia(new File([await (await fetch(vurl)).blob()], name));
        picked = { ...rest, url: vurl, name, size: file.size };
      }
      await openPair(data, picked, { ref: null, key: null });
    })().catch((err) => setProblems([`Dev open failed: ${err.message}`]));
  }
}
