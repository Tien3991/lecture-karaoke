// Local test server; never published to GitHub Pages. It serves this app folder plus an explicit
// allow-list of media files (given as arguments) under /media/, with HTTP Range support, which
// Safari needs to play video. It binds to 127.0.0.1 only and refuses anything outside the app
// folder, so nothing else in the parent project folder (such as an API key file) is reachable.
//
// usage: node dev/serve.mjs [--port 8765] FILE...
import http from "node:http";
import { createReadStream, statSync } from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const args = process.argv.slice(2);
const portAt = args.indexOf("--port");
const port = portAt >= 0 ? Number(args.splice(portAt, 2)[1]) : 8765;
const media = new Map(args.map((f) => [`/media/${encodeURIComponent(path.basename(f))}`, path.resolve(f)]));
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".webmanifest": "application/manifest+json",
  ".png": "image/png", ".woff2": "font/woff2", ".mp4": "video/mp4", ".txt": "text/plain; charset=utf-8" };

http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  let file = media.get(url.pathname);
  if (!file) {
    if (/^\/(dev|tests|\.git|node_modules)(\/|$)/.test(url.pathname)) return res.writeHead(404).end();
    file = path.join(root, decodeURIComponent(url.pathname), url.pathname.endsWith("/") ? "index.html" : "");
    if (file !== root && !file.startsWith(root + path.sep)) return res.writeHead(403).end();
  }
  let st;
  try { st = statSync(file); if (!st.isFile()) throw new Error(); } catch { return res.writeHead(404).end(); }
  const headers = { "Content-Type": types[path.extname(file)] || "application/octet-stream", "Accept-Ranges": "bytes",
    "Cache-Control": "no-store" };
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
  if (m && (m[1] || m[2])) {
    const start = m[1] ? Number(m[1]) : Math.max(0, st.size - Number(m[2]));
    const end = m[1] && m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1;
    if (start > end) return res.writeHead(416, { "Content-Range": `bytes */${st.size}` }).end();
    res.writeHead(206, { ...headers, "Content-Range": `bytes ${start}-${end}/${st.size}`, "Content-Length": end - start + 1 });
    return req.method === "HEAD" ? res.end() : createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, "Content-Length": st.size });
  return req.method === "HEAD" ? res.end() : createReadStream(file).pipe(res);
}).listen(port, "127.0.0.1", () => console.log(`serving ${root} and ${media.size} media file(s) at http://127.0.0.1:${port}/`));
