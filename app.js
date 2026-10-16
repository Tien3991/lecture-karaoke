// Lecture Karaoke: plays a local lecture video with live karaoke subtitles from its Soniox
// transcript. The subtitle rules are the vertical_video_maker pipeline's (ported in core/).
import { CONJ_BY_LANGUAGE, wordsFromTranscript } from "./core/transcript.js";
import { activeEvent, buildEvents, buildPieces, spokenCount } from "./core/timeline.js";
import { blobReader, readMp4Info } from "./core/mp4.js";
import { applyFixes, exportTranscript, setFix, transcriptText } from "./core/corrections.js";
import * as store from "./core/store.js";

const VERSION = "1.0.0";
// Proportions of the burned vertical video (identical in every pipeline calibration), in em of
// the main subtitle text: line limit, frame width, and the height the three blocks need.
const FIT_EM = 892.4 / 67.797, FRAME_EM = 1080 / 67.797, PANEL_EM = 14.4, CTX_SCALE = 74 / 93;
const FONT = '700 100px "LK Sans"';
const SPEEDS = [1, 1.25, 1.5, 1.75, 2, 0.5, 0.75];
const isFirefox = /Firefox\//.test(navigator.userAgent);
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isMobile = isIOS || /Android/i.test(navigator.userAgent);
const dev = ["localhost", "127.0.0.1"].includes(location.hostname);

const $ = (id) => document.getElementById(id);
const video = $("video"), panel = $("panel");
const S = {
  videoFile: null, jsonFile: null, videoUrl: null, videoName: "", transcript: null, id: null, rec: {},
  baseWords: [], words: [], pieces: [], events: [], durationMs: 0, audioOffsetMs: 0,
  leadMs: 0, syncMs: 0, language: "en", editing: false, shown: -2, spoken: -1, lastSecond: -1,
};

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
  if (!$("player").hidden) return;
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
    leadMs: rec.leadMs ?? 0, syncMs: rec.syncMs ?? 0, language: rec.language ?? "en", shown: -2,
  });
  S.rec.video = { name, size };
  S.baseWords = wordsFromTranscript(data);
  S.words = applyFixes(S.baseWords, S.rec.fixes);
  await prepareFont([...new Set(S.words.map((w) => w.text).join(""))].join(""));
  rebuildLayout();
  if (S.videoUrl) URL.revokeObjectURL(S.videoUrl);
  S.videoUrl = url;
  video.src = url;
  video.defaultPlaybackRate = video.playbackRate = savedRate();
  $("welcome").hidden = true;
  $("player").hidden = false;
  document.title = `${name.replace(/\.[^.]+$/, "")} · Lecture Karaoke`;
  updateChips();
  resize();
  video.addEventListener("loadedmetadata", () => {
    if (rec.position > 5 && rec.position < video.duration - 10) {
      video.currentTime = rec.position;
      toast(`Resumed at ${clock(rec.position)}`, "Start over", () => (video.currentTime = 0));
    }
  }, { once: true });
  save();
}

// ---------------------------------------------------------------- layout and timing
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

function resize() {
  const r = panel.getBoundingClientRect();
  if (!r.width || !r.height) return;
  panel.style.setProperty("--em", `${Math.min(r.width / FRAME_EM, r.height / PANEL_EM)}px`);
}
new ResizeObserver(resize).observe(panel);

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
$("speedBtn").addEventListener("click", () => {
  video.playbackRate = SPEEDS[(SPEEDS.indexOf(video.playbackRate) + 1) % SPEEDS.length];
});
// The speed is a viewer preference, kept across lectures (the key carries the app prefix).
const RATE_KEY = "lecture-karaoke.rate";
function savedRate() {
  try { return SPEEDS.includes(Number(localStorage.getItem(RATE_KEY))) ? Number(localStorage.getItem(RATE_KEY)) : 1; } catch { return 1; }
}
video.addEventListener("ratechange", () => {
  updateChips();
  try { localStorage.setItem(RATE_KEY, String(video.playbackRate)); } catch { /* storage unavailable */ }
});
$("leadBtn").addEventListener("click", () => setLead(S.leadMs ? 0 : (S.rec.lastLeadMs || 3000)));
$("editBtn").addEventListener("click", () => setEditing(!S.editing));
$("moreBtn").addEventListener("click", openSettings);

const fsTarget = document.documentElement;
const canFullscreen = !!(fsTarget.requestFullscreen || fsTarget.webkitRequestFullscreen);
$("fsBtn").hidden = !canFullscreen;
$("fsBtn").addEventListener("click", () => {
  if (document.fullscreenElement || document.webkitFullscreenElement) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  else (fsTarget.requestFullscreen || fsTarget.webkitRequestFullscreen).call(fsTarget);
});

function setLead(ms) {
  S.leadMs = ms;
  if (ms) S.rec.lastLeadMs = ms;
  rebuildEvents();
  updateChips();
  save();
}
function setEditing(on) {
  S.editing = on;
  panel.classList.toggle("editing", on);
  $("editNote").hidden = !on;
  $("editBtn").setAttribute("aria-pressed", String(on));
  if (on) video.pause();
}
function updateChips() {
  $("speedBtn").textContent = `${video.playbackRate}×`;
  $("leadBtn").textContent = S.leadMs ? `${S.leadMs / 1000} s ahead` : "Exact";
}

addEventListener("keydown", (e) => {
  if ($("player").hidden || e.target.closest("input, select, textarea, dialog")) return;
  const k = e.key.toLowerCase();
  if (k === " ") { e.preventDefault(); togglePlay(); }
  else if (k === "arrowleft") video.currentTime = Math.max(0, video.currentTime - 5);
  else if (k === "arrowright") video.currentTime = Math.min(video.duration || 0, video.currentTime + 5);
  else if (k === "arrowup" || k === "]") video.playbackRate = Math.min(2, video.playbackRate + 0.25);
  else if (k === "arrowdown" || k === "[") video.playbackRate = Math.max(0.5, video.playbackRate - 0.25);
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
  const lead = S.leadMs === 0 ? "0" : S.leadMs === 3000 ? "3000" : "custom";
  document.querySelector(`input[name=lead][value="${lead}"]`).checked = true;
  if (lead === "custom") $("leadCustom").value = S.leadMs / 1000;
  $("sync").value = S.syncMs;
  $("syncOut").textContent = `${S.syncMs > 0 ? "+" : ""}${S.syncMs} ms`;
  $("language").value = S.language;
  $("offsetInfo").textContent = isFirefox ? "" :
    S.audioOffsetMs ? `This file's audio starts ${S.audioOffsetMs} ms in; that is already allowed for.` : "";
  drawFixList();
  $("settings").showModal();
}
for (const r of document.querySelectorAll("input[name=lead]")) {
  r.addEventListener("change", () => setLead(r.value === "custom" ? Math.round(Number($("leadCustom").value) * 1000) : Number(r.value)));
}
$("leadCustom").addEventListener("change", () => {
  document.querySelector('input[name=lead][value="custom"]').checked = true;
  setLead(Math.max(0, Math.round(Number($("leadCustom").value) * 1000)));
});
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
  $("player").hidden = true;
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
  Object.assign(S.rec, { leadMs: S.leadMs, syncMs: S.syncMs, language: S.language });
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
      window.__lk = { S, video, activeEvent, spokenCount };   // for automated checks
    })().catch((err) => setProblems([`Dev open failed: ${err.message}`]));
  }
}
