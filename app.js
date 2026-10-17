// Lecture Karaoke: plays a local lecture video with live karaoke subtitles from its Soniox
// transcript. The subtitle rules are the vertical_video_maker pipeline's (ported in core/).
import { CONJ_BY_LANGUAGE, wordsFromTranscript } from "./core/transcript.js";
import { activeEvent, buildEvents, buildPieces, spokenCount } from "./core/timeline.js";
import { blobReader, readMp4Info } from "./core/mp4.js";
import { applyFixes, exportTranscript, setFix, transcriptText } from "./core/corrections.js";
import * as store from "./core/store.js";

const VERSION = "1.1.1";
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
const video = $("video"), panel = $("panel"), player = $("player"), bar = document.querySelector(".bar");
const S = {
  videoFile: null, jsonFile: null, videoUrl: null, videoName: "", transcript: null, id: null, rec: {},
  baseWords: [], words: [], pieces: [], events: [], durationMs: 0, audioOffsetMs: 0,
  leadMs: 0, syncMs: 0, language: "en", editing: false, shown: -2, spoken: -1, lastSecond: -1,
};

// ---------------------------------------------------------------- viewer preferences
// Kept on this device for every lecture: speed, the timing offset and whether it is on, and the
// video/subtitle split for each orientation. (Position, sync, language and fixes are kept per
// transcript in IndexedDB.) The key carries the app prefix: all Pages projects share one origin.
const PREFS_KEY = "lecture-karaoke.prefs";
const prefs = { rate: 1, offsetMs: 3000, offsetOn: false, split: { portrait: null, landscape: null } };
try {
  const saved = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
  Object.assign(prefs, saved, { split: { ...prefs.split, ...saved.split } });
  const oldRate = Number(localStorage.getItem("lecture-karaoke.rate"));   // 1.0.1 kept only the speed
  if (oldRate && !("rate" in saved)) prefs.rate = oldRate;
} catch { /* storage unavailable: defaults */ }
prefs.rate = clamp(Number(prefs.rate) || 1, RATE_MIN, RATE_MAX);
prefs.offsetMs = Number.isFinite(Number(prefs.offsetMs)) ? clamp(Number(prefs.offsetMs), -OFFSET_MAX_MS, OFFSET_MAX_MS) : 3000;
prefs.offsetOn = prefs.offsetOn === true;
for (const o of ["portrait", "landscape"]) if (!Number.isFinite(prefs.split[o])) prefs.split[o] = null;
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

// ---------------------------------------------------------------- opening files
const problems = $("problems");
function setProblems(list) {
  problems.replaceChildren(...list.map((t) => Object.assign(document.createElement("p"), { textContent: t })));
}
function chooseVideo(file) {
  S.videoFile = file;
  $("videoName").textContent = file.name;
  $("pickVideo").closest(".pick").classList.add("done");
  updateStart();
}
function chooseJson(file) {
  S.jsonFile = file;
  $("jsonName").textContent = file.name;
  $("pickJson").closest(".pick").classList.add("done");
  updateStart();
}
function updateStart() {
  $("startBtn").disabled = !(S.videoFile && S.jsonFile);
  setProblems([]);
}
$("pickVideo").addEventListener("change", (e) => e.target.files[0] && chooseVideo(e.target.files[0]));
$("pickJson").addEventListener("change", (e) => e.target.files[0] && chooseJson(e.target.files[0]));

// Drag and drop both files onto the welcome screen.
addEventListener("dragover", (e) => { e.preventDefault(); document.body.classList.add("dragging"); });
addEventListener("dragleave", (e) => { if (!e.relatedTarget) document.body.classList.remove("dragging"); });
addEventListener("drop", (e) => {
  e.preventDefault();
  document.body.classList.remove("dragging");
  if (!player.hidden) return;
  for (const f of e.dataTransfer.files) {
    if (/\.json$/i.test(f.name) || f.type === "application/json") chooseJson(f);
    else if (f.type.startsWith("video/") || /\.(mp4|m4v|mov)$/i.test(f.name)) chooseVideo(f);
  }
});

$("startBtn").addEventListener("click", async () => {
  $("startBtn").disabled = true;
  try {
    const data = JSON.parse(await S.jsonFile.text());
    const info = await readMp4Info(blobReader(S.videoFile), S.videoFile.size);
    const url = URL.createObjectURL(S.videoFile);
    await openPair(data, info, url, S.videoFile.name, S.videoFile.size);
  } catch (err) {
    setProblems([`Could not open these files: ${err.message}`]);
    $("startBtn").disabled = false;
  }
});

/** Checks that the video and transcript belong together. Returns problems to show. */
function pairingProblems(data, info, name, size, rec) {
  const out = [];
  if (!Array.isArray(data.tokens) || !data.tokens.length || !("start_ms" in data.tokens[0])) {
    return ["The transcript isn't a Soniox transcript JSON (no tokens with times)."];
  }
  if (info.height > info.width) {
    return ["This is a vertical video, probably one already rendered with subtitles. Pick the original video instead."];
  }
  if (data.video && data.video !== name) out.push(`This transcript was made for “${data.video}”, not “${name}”.`);
  const lastMs = data.tokens[data.tokens.length - 1].end_ms;
  if (info.durationSec && lastMs > info.durationSec * 1000 + 3000) {
    out.push("The transcript is longer than the video: they probably don't belong together.");
  }
  if (rec.video && (rec.video.name !== name || rec.video.size !== size)) {
    out.push(`Last time this transcript was opened with “${rec.video.name}”.`);
  }
  return out;
}

async function openPair(data, info, url, name, size) {
  const rec = await store.load(data.id || name);
  const issues = pairingProblems(data, info, name, size, rec);
  if (issues.length && (issues[0].startsWith("This is a vertical") || issues[0].startsWith("The transcript isn't"))) {
    setProblems(issues);
    $("startBtn").disabled = false;
    return;
  }
  if (issues.length && !confirm(issues.join("\n\n") + "\n\nOpen them anyway?")) {
    $("startBtn").disabled = false;
    return;
  }
  Object.assign(S, {
    transcript: data, id: data.id || name, rec, videoName: name, durationMs: Math.round(info.durationSec * 1000),
    // Soniox counts from the first audio sample; Safari and Chromium keep the MP4's leading empty
    // edit (the audio starts that much into the timeline), Firefox drops it.
    audioOffsetMs: isFirefox ? 0 : Math.round(info.audioStartSec * 1000),
    leadMs: prefs.offsetOn ? prefs.offsetMs : 0, syncMs: rec.syncMs ?? 0, language: rec.language ?? "en",
    shown: -2, lastSecond: -1,
  });
  S.rec.video = { name, size };
  S.baseWords = wordsFromTranscript(data);
  S.words = applyFixes(S.baseWords, S.rec.fixes);
  await prepareFont([...new Set(S.words.map((w) => w.text).join(""))].join(""));
  rebuildLayout();
  if (S.videoUrl) URL.revokeObjectURL(S.videoUrl);
  S.videoUrl = url;
  video.src = url;
  applyRate(prefs.rate);
  $("welcome").hidden = true;
  player.hidden = false;
  document.title = `${name.replace(/\.[^.]+$/, "")} · Lecture Karaoke`;
  updateChips();
  layout();
  resize();
  video.addEventListener("loadedmetadata", () => {
    if (rec.position > 5 && rec.position < video.duration - 10) {
      video.currentTime = rec.position;
      toast(`Resumed at ${clock(rec.position)}`, "Start over", () => (video.currentTime = 0));
    }
  }, { once: true });
  save();
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
  if ($("settings").open) syncSplitControls();
}
new ResizeObserver(layout).observe(player);

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
  if (!S.events.length) return;
  const t = video.currentTime * 1000;
  const e = activeEvent(S.events, t);
  if (e !== S.shown) { draw(e); S.shown = e; S.spoken = -1; }
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
    $("time").textContent = `${clock(video.currentTime)} / ${clock(video.duration)}`;
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

// The MP4's own caption track would be drawn over the app by Safari: keep it off.
const captionsOff = () => { for (const t of video.textTracks) t.mode = "disabled"; };
video.addEventListener("loadedmetadata", captionsOff);
video.textTracks.addEventListener?.("addtrack", captionsOff);

// ---------------------------------------------------------------- controls
const togglePlay = () => (video.paused ? video.play().catch(() => {}) : video.pause());
$("playBtn").addEventListener("click", togglePlay);
video.addEventListener("play", () => { $("playBtn").textContent = "❚❚"; $("playBtn").ariaLabel = "Pause"; keepAwake(true); });
video.addEventListener("pause", () => { $("playBtn").textContent = "▶︎"; $("playBtn").ariaLabel = "Play"; keepAwake(false); save(); });
video.addEventListener("click", togglePlay);
$("seek").addEventListener("input", () => { if (video.duration) video.currentTime = ($("seek").value / 1000) * video.duration; });
$("editBtn").addEventListener("click", () => setEditing(!S.editing));
$("moreBtn").addEventListener("click", openSettings);

const fsTarget = document.documentElement;
const canFullscreen = !!(fsTarget.requestFullscreen || fsTarget.webkitRequestFullscreen);
$("fsBtn").hidden = !canFullscreen;
$("fsBtn").addEventListener("click", () => {
  if (document.fullscreenElement || document.webkitFullscreenElement) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  else (fsTarget.requestFullscreen || fsTarget.webkitRequestFullscreen).call(fsTarget);
});

function setEditing(on) {
  S.editing = on;
  panel.classList.toggle("editing", on);
  $("editBtn").setAttribute("aria-pressed", String(on));
  if (on) { video.pause(); toast("Tap a word to fix it"); }
}
const fmtRate = (r) => `${+r.toFixed(2)}×`;
const fmtOffset = (ms) => `${ms > 0 ? "+" : ms < 0 ? "−" : "±"}${+Math.abs(ms / 1000).toFixed(2)} s`;
function updateChips() {
  $("speedBtn").textContent = fmtRate(video.playbackRate);
  $("leadBtn").textContent = prefs.offsetOn ? fmtOffset(prefs.offsetMs) : "Exact";
  $("leadBtn").setAttribute("aria-pressed", String(prefs.offsetOn));
}

addEventListener("keydown", (e) => {
  if (player.hidden || e.target.closest("input, select, textarea, dialog")) return;
  const k = e.key.toLowerCase();
  if (k === " ") { e.preventDefault(); togglePlay(); }
  else if (k === "arrowleft") video.currentTime = Math.max(0, video.currentTime - 5);
  else if (k === "arrowright") video.currentTime = Math.min(video.duration || 0, video.currentTime + 5);
  else if (k === "arrowup" || k === "]") stepRate(1);
  else if (k === "arrowdown" || k === "[") stepRate(-1);
  else if (k === "l") $("leadBtn").click();
  else if (k === "e") $("editBtn").click();
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

// ---------------------------------------------------------------- speed (0.2× to 4×)
/** Sets the speed, or says so and returns false when this browser refuses it. */
function applyRate(r) {
  r = Math.round(clamp(r, RATE_MIN, RATE_MAX) * 100) / 100;
  try {
    video.defaultPlaybackRate = r;
    video.playbackRate = r;
  } catch {
    toast(`This browser can't play at ${fmtRate(r)}.`);
    return false;
  }
  prefs.rate = r;
  savePrefs();
  return true;
}
// The slider is logarithmic, so it is as fine around 1× as at the ends; it snaps to 0.05.
const SLIDER_STEPS = 1000;
const toSlider = (r) => Math.round((Math.log(r / RATE_MIN) / Math.log(RATE_MAX / RATE_MIN)) * SLIDER_STEPS);
const fromSlider = (v) => Math.round(RATE_MIN * (RATE_MAX / RATE_MIN) ** (v / SLIDER_STEPS) * 20) / 20;
$("speedPreset").append(new Option("Custom", ""), ...RATE_PRESETS.map((r) => new Option(fmtRate(r), String(r))));
let sliding = false;   // while a finger or mouse drags the slider, don't move its thumb under it
function syncSpeedControls() {
  const r = video.playbackRate;
  if (document.activeElement !== $("speedNum")) $("speedNum").value = +r.toFixed(2);
  if (!sliding) $("speedRange").value = toSlider(r);
  $("speedPreset").value = RATE_PRESETS.includes(r) ? String(r) : "";
}
$("speedRange").addEventListener("pointerdown", () => (sliding = true));
for (const ev of ["pointerup", "pointercancel"]) addEventListener(ev, () => { if (sliding) { sliding = false; syncSpeedControls(); } });
$("speedBtn").addEventListener("click", () => { syncSpeedControls(); $("speedDialog").showModal(); });
$("speedRange").addEventListener("input", () => applyRate(fromSlider(Number($("speedRange").value))));
// Keyboard on the slider: arrows step 0.05×, Page Up/Down jump to the next preset.
$("speedRange").addEventListener("keydown", (e) => {
  const step = { ArrowRight: 0.05, ArrowUp: 0.05, ArrowLeft: -0.05, ArrowDown: -0.05 }[e.key];
  if (step) applyRate(video.playbackRate + step);
  else if (e.key === "PageUp" || e.key === "PageDown") stepRate(e.key === "PageUp" ? 1 : -1);
  else return;
  e.preventDefault();
});
$("speedNum").addEventListener("change", () => {
  const r = parseFloat($("speedNum").value);
  if (Number.isFinite(r)) applyRate(r);
  $("speedNum").value = +video.playbackRate.toFixed(2);
});
$("speedPreset").addEventListener("change", () => { if ($("speedPreset").value) applyRate(Number($("speedPreset").value)); });
$("speedNormal").addEventListener("click", () => applyRate(1));
video.addEventListener("ratechange", () => { updateChips(); syncSpeedControls(); });
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
  S.rec.fixes = setFix(S.rec.fixes, S.words[editing], $("editorText").value);
  applyAndRelayout();
  toast("Fix saved on this device");
});
function applyAndRelayout() {
  S.words = applyFixes(S.baseWords, S.rec.fixes);
  rebuildLayout();
  save();
}

// ---------------------------------------------------------------- settings
function openSettings() {
  syncOffsetControls();
  syncSplitControls();
  $("sync").value = S.syncMs;
  $("syncOut").textContent = `${S.syncMs > 0 ? "+" : ""}${S.syncMs} ms`;
  $("language").value = S.language;
  $("offsetInfo").textContent = isFirefox ? "" :
    S.audioOffsetMs ? `This file's audio starts ${S.audioOffsetMs} ms in; that is already allowed for.` : "";
  drawFixList();
  $("settings").showModal();
}
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
$("language").addEventListener("change", () => { S.language = $("language").value; rebuildLayout(); save(); });
$("openOther").addEventListener("click", () => {
  $("settings").close();
  video.pause();
  save();
  player.hidden = true;
  $("welcome").hidden = false;
  document.title = "Lecture Karaoke";
  $("startBtn").disabled = !(S.videoFile && S.jsonFile);
});
function drawFixList() {
  const fixes = S.rec.fixes || [];
  $("fixList").replaceChildren(...(fixes.length ? fixes.map((f) => {
    const li = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = `${clock((f.start_ms + S.audioOffsetMs) / 1000)}  “${f.old}” → ${f.new ? `“${f.new}”` : "removed"}`;
    const undo = Object.assign(document.createElement("button"), { type: "button", textContent: "Undo" });
    undo.addEventListener("click", () => {
      S.rec.fixes = fixes.filter((x) => x !== f);
      applyAndRelayout();
      drawFixList();
    });
    li.append(label, undo);
    return li;
  }) : [Object.assign(document.createElement("li"), { textContent: "No fixes yet: turn on Fix and tap a word." })]));
}
$("exportBtn").addEventListener("click", async () => {
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

// ---------------------------------------------------------------- remembering, wake lock, toast
let toastTimer = 0;
function save() {
  if (!S.id) return;
  S.rec.position = video.currentTime || S.rec.position || 0;
  Object.assign(S.rec, { syncMs: S.syncMs, language: S.language });
  delete S.rec.leadMs;        // 1.0.x kept the lead per transcript; it is a viewer preference now
  delete S.rec.lastLeadMs;
  store.save(S.id, structuredClone(S.rec));
}
setInterval(() => { if (!video.paused) save(); }, 5000);
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

function toast(text, actionLabel, action) {
  const t = $("toast");
  t.replaceChildren(text);
  if (actionLabel) {
    const b = Object.assign(document.createElement("button"), { textContent: actionLabel });
    b.addEventListener("click", () => { action(); t.hidden = true; });
    t.append(b);
  }
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 5000);
}

// ---------------------------------------------------------------- start-up
$("version").textContent = `v${VERSION}`;
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
  const q = new URLSearchParams(location.search);
  if (q.get("video") && q.get("json")) {
    (async () => {
      const vurl = q.get("video");
      const data = await (await fetch(q.get("json"))).json();
      const size = Number((await fetch(vurl, { method: "HEAD" })).headers.get("Content-Length"));
      const read = async (offset, length) => new Uint8Array(await (await fetch(vurl,
        { headers: { Range: `bytes=${offset}-${offset + length - 1}` } })).arrayBuffer());
      const info = await readMp4Info(read, size);
      await openPair(data, info, vurl, decodeURIComponent(vurl.split("/").pop()), size);
      window.__lk = { S, video, prefs, activeEvent, spokenCount };   // for automated checks
    })().catch((err) => setProblems([`Dev open failed: ${err.message}`]));
  }
}
