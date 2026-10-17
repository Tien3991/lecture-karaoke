// Local test server; never published to GitHub Pages. It serves this app folder plus an explicit
// allow-list of media files (given as arguments) under /media/, with HTTP Range support, which
// Safari needs to play video. It binds to 127.0.0.1 only and refuses anything outside the app
// folder, so nothing else in the parent project folder (such as an API key file) is reachable.
//
// With --mock-github DIR it also stands in for the GitHub contents API under /mock-github, serving
// DIR as the repository (open the app with ?api=/mock-github). Only the test tokens "test-token"
// (read and write) and "readonly-token" are accepted, so no real credentials are ever needed.
// POST /mock-github/__offline?on=1 makes it drop every API connection, as if offline.
//
// usage: node dev/serve.mjs [--port 8765] [--mock-github DIR] FILE...
import http from "node:http";
import { createHash } from "node:crypto";
import { createReadStream, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const args = process.argv.slice(2);
const option = (name) => { const at = args.indexOf(name); return at >= 0 ? args.splice(at, 2)[1] : null; };
const port = Number(option("--port") || 8765);
const mockArg = option("--mock-github"), mockDir = mockArg ? path.resolve(mockArg) : null;
const media = new Map(args.map((f) => [`/media/${encodeURIComponent(path.basename(f))}`, path.resolve(f)]));
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".webmanifest": "application/manifest+json",
  ".png": "image/png", ".woff2": "font/woff2", ".mp4": "video/mp4", ".txt": "text/plain; charset=utf-8" };

http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (mockDir && url.pathname.startsWith("/mock-github/")) return mockGitHub(req, res, url);
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
}).listen(port, "127.0.0.1", () => console.log(`serving ${root} and ${media.size} media file(s) at http://127.0.0.1:${port}/` +
  (mockDir ? `; mock GitHub repository ${mockDir} at /mock-github` : "")));

// ---------------------------------------------------------------- stand-in for GitHub's contents API
let offline = false;
const blobSha = (buf) => createHash("sha1").update(`blob ${buf.length}\0`).update(buf).digest("hex");
function mockGitHub(req, res, url) {
  const json = (status, body, extra = {}) => res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...extra })
    .end(JSON.stringify(body));
  if (url.pathname === "/mock-github/__offline" && req.method === "POST") {
    offline = url.searchParams.get("on") === "1";
    return json(200, { offline });
  }
  if (offline) return req.socket.destroy();
  const auth = req.headers.authorization || "";
  if (auth !== "Bearer test-token" && auth !== "Bearer readonly-token") return json(401, { message: "Bad credentials" });
  const m = /^\/mock-github\/repos\/([^/]+)\/([^/]+)(?:\/contents\/(.+))?$/.exec(url.pathname);
  if (!m) return json(404, { message: "Not Found" });
  if (!m[3]) return json(200, { full_name: `${m[1]}/${m[2]}`, private: true });
  const rel = decodeURIComponent(m[3]), file = path.join(mockDir, rel);
  if (!file.startsWith(mockDir + path.sep)) return json(404, { message: "Not Found" });
  let buf = null;
  try { buf = readFileSync(file); } catch { /* missing */ }
  if (req.method === "GET") {
    if (!buf) return json(404, { message: "Not Found" });
    const sha = blobSha(buf), etag = `"${sha}"`;
    if ((req.headers.accept || "").includes("raw")) {
      if (req.headers["if-none-match"] === etag) return res.writeHead(304, { ETag: etag }).end();
      return res.writeHead(200, { "Content-Type": "application/vnd.github.raw+json; charset=utf-8", ETag: etag, "Cache-Control": "no-store" }).end(buf);
    }
    const small = buf.length <= 1024 * 1024;
    return json(200, { type: "file", name: path.basename(rel), path: rel, sha, size: buf.length,
      encoding: small ? "base64" : "none", content: small ? buf.toString("base64").replace(/.{60}/g, "$&\n") : "" }, { ETag: etag });
  }
  if (req.method === "PUT") {
    if (auth === "Bearer readonly-token") return json(403, { message: "Resource not accessible by personal access token" });
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (buf && !body.sha) return json(422, { message: "Invalid request.\n\n\"sha\" wasn't supplied." });
      if (buf && body.sha !== blobSha(buf)) return json(409, { message: `${rel} does not match ${body.sha}` });
      const data = Buffer.from(body.content, "base64");
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, data);
      json(buf ? 200 : 201, { content: { path: rel, sha: blobSha(data), size: data.length }, commit: { message: body.message } });
    });
    return;
  }
  return json(405, { message: "Method not allowed" });
}
