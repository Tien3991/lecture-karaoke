// Service worker: keeps the app shell available offline. Pages are fetched network-first so an
// installed (Home Screen) app picks up new versions; other files come from the cache first.
// Keep VERSION equal to app.js's VERSION and change both with every release: a new cache name is
// what makes installed apps fetch the new files.
const VERSION = "1.0.0";
const CACHE = `lecture-karaoke-${VERSION}`;
const SHELL = ["./", "index.html", "styles.css", "app.js", "core/transcript.js", "core/layout.js", "core/timeline.js",
  "core/mp4.js", "core/corrections.js", "core/store.js", "manifest.webmanifest", "icons/icon-180.png", "icons/icon-192.png",
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
    event.respondWith(fetch(req).then((res) => {
      if (res.ok) {
        const copy = res.clone();   // clone now: the page consumes the body
        caches.open(CACHE).then((c) => c.put(req, copy));
      }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match("index.html"))));
    return;
  }
  event.respondWith(caches.match(req).then((hit) => hit || fetch(req)));
});
