// Service worker: keeps the app available offline. Everything, the page included, comes from this
// worker's own cache, so the page and its scripts are always the same release (a page fetched
// fresh next to cached scripts once broke the app after an update). A new release arrives as a new
// worker, which the browser finds by itself on the next visit; the app then shows its
// "new version" banner, and Reload opens the new release.
// VERSION must equal app.js's VERSION and index.html's app-version (npm test checks this); change
// all three with every release: the new cache name is what makes installed apps fetch new files.
const VERSION = "2.0.0";
const CACHE = `lecture-karaoke-${VERSION}`;
const SHELL = ["./", "index.html", "styles.css", "app.js", "core/transcript.js", "core/layout.js", "core/timeline.js",
  "core/mp4.js", "core/corrections.js", "core/store.js", "core/github.js", "core/sync.js", "core/dropbox.js", "core/audio.js",
  "core/library.js", "manifest.webmanifest", "icons/icon-180.png", "icons/icon-192.png",
  "icons/icon-512.png", "fonts/NunitoSans-Bold-latin.woff2", "fonts/NunitoSans-Bold-latin-ext.woff2",
  "fonts/NunitoSans-Bold-vietnamese.woff2", "playback-test.html", "spike.js"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: "reload" })))));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(
    keys.filter((k) => k.startsWith("lecture-karaoke-") && k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  if (req.mode === "navigate") {
    // The app's pages from the cache; any other page from the network (offline: the app).
    event.respondWith(caches.match(req, { ignoreSearch: true }).then((hit) => hit ||
      fetch(req).catch(() => caches.match("index.html"))));
    return;
  }
  event.respondWith(caches.match(req).then((hit) => hit || fetch(req)));
});
