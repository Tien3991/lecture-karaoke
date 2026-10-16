// Playback test for large local video files (blob URLs), especially on iPhone/iPad.
const $ = (id) => document.getElementById(id);
const video = $("video"), logEl = $("log"), summary = $("summary");
const done = { plays: false, nearEnd: false, fast: false, resumed: false };
let url = null, stalls = 0, hiddenAt = null, wasPlaying = false;

function log(msg) {
  const t = new Date().toLocaleTimeString();
  logEl.textContent = `${t}  ${msg}\n` + logEl.textContent;
}
function fmt(s) {
  if (!isFinite(s)) return "0:00";
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h ? `${h}:${String(m).padStart(2, "0")}` : `${m}`) + `:${String(sec).padStart(2, "0")}`;
}
function updateSummary() {
  const box = (ok, label) => `${ok ? "☑" : "☐"} ${label}`;
  summary.innerHTML = [box(done.plays, "plays"), box(done.nearEnd, "jump near the end"), box(done.fast, "2×"),
    box(done.resumed, "switch apps and come back"),
    `<span class="${stalls ? "bad" : "ok"}">${stalls} stall${stalls === 1 ? "" : "s"}</span>`].join(" · ");
}

$("file").addEventListener("change", () => {
  const file = $("file").files[0];
  if (!file) return;
  if (url) URL.revokeObjectURL(url);
  url = URL.createObjectURL(file);
  video.removeAttribute("src");
  video.innerHTML = "";
  if ($("useSource").checked) {
    const source = document.createElement("source");
    source.src = url;
    source.type = file.type || "video/mp4";
    video.appendChild(source);
  } else {
    video.src = url;
  }
  video.load();
  log(`picked "${file.name}", ${(file.size / 1e6).toFixed(0)} MB, type ${file.type || "unknown"}, ` +
      `${$("useSource").checked ? "<source> element" : "src attribute"}`);
});

for (const ev of ["loadedmetadata", "canplay", "playing", "pause", "seeking", "seeked", "waiting", "stalled",
                  "ended", "ratechange", "error", "emptied", "suspend"]) {
  video.addEventListener(ev, () => {
    if (ev === "loadedmetadata") log(`metadata: ${fmt(video.duration)}, ${video.videoWidth}x${video.videoHeight}`);
    else if (ev === "error") log(`ERROR ${video.error ? video.error.code + " " + (video.error.message || "") : ""}`);
    else if (ev === "waiting" || ev === "stalled") { stalls += ev === "waiting" && !video.seeking ? 1 : 0; log(ev); }
    else if (ev === "playing") { done.plays = true; log("playing"); }
    else if (ev === "seeked") { if (video.currentTime > video.duration - 120) done.nearEnd = true; log(`seeked to ${fmt(video.currentTime)}`); }
    else if (ev === "ratechange") { if (video.playbackRate >= 2) done.fast = true; log(`speed ${video.playbackRate}×`); }
    else if (ev !== "suspend") log(ev);
    updateSummary();
  });
}

$("play").onclick = () => (video.paused ? video.play().catch((e) => log("play() refused: " + e.message)) : video.pause());
$("back").onclick = () => (video.currentTime = Math.max(0, video.currentTime - 10));
$("fwd").onclick = () => (video.currentTime = Math.min(video.duration || 0, video.currentTime + 10));
$("end").onclick = () => { if (video.duration) video.currentTime = video.duration - 60; };
$("speed").onclick = () => {
  const rates = [1, 1.5, 2, 0.75];
  video.playbackRate = rates[(rates.indexOf(video.playbackRate) + 1) % rates.length];
  $("speed").textContent = `Speed ${video.playbackRate}×`;
};
$("seek").addEventListener("input", () => {
  if (video.duration) video.currentTime = ($("seek").value / 1000) * video.duration;
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) { hiddenAt = video.currentTime; wasPlaying = !video.paused; log(`app hidden at ${fmt(hiddenAt)}`); }
  else if (hiddenAt !== null) {
    log(`app visible again at ${fmt(video.currentTime)} (was ${fmt(hiddenAt)}${wasPlaying ? ", playing" : ""})`);
    done.resumed = true;
    updateSummary();
  }
});

(function tick() {
  $("time").textContent = `${fmt(video.currentTime)} / ${fmt(video.duration)}`;
  if (video.duration && document.activeElement !== $("seek")) $("seek").value = (video.currentTime / video.duration) * 1000;
  requestAnimationFrame(tick);
})();

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch((e) => log("service worker: " + e.message));
log(`ready. ${navigator.standalone || matchMedia("(display-mode: standalone)").matches ? "Running as installed app." : "Running in the browser."}`);
updateSummary();
