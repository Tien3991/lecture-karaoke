// Local test server; never published to GitHub Pages. It serves this app folder plus an explicit
// allow-list of media files (given as arguments) under /media/, with HTTP Range support, which
// Safari needs to play video. It binds to 127.0.0.1 only and refuses anything outside the app
// folder, so nothing else in the parent project folder (such as an API key file) is reachable.
//
// With --mock-github DIR it also stands in for the GitHub contents API under /mock-github, serving
// DIR as the repository (open the app with ?api=/mock-github). Only the test tokens "test-token"
// (read and write) and "readonly-token" are accepted, so no real credentials are ever needed.
// Starting the transcription job (POST .../actions/workflows/transcribe.yml/dispatches) is
// recorded, not run: GET /mock-github/__dispatches lists the calls (DELETE empties the list).
// POST /mock-github/__job {item, status, transcript, error} does the job's part for the index
// entry with key `item`: "ready" (the default) publishes the transcript, a JSON file from the
// media list given by its /media/ path, and deletes the entry's staged audio; "failed" records
// the error. POST /mock-github/__offline?on=1 makes both mocks drop every connection.
//
// With --mock-dropbox DIR it also stands in for Dropbox under /mock-dropbox, serving DIR as the
// app folder (open the app with ?dropbox=/mock-dropbox; the mock repository's config/
// dropbox.json then names the test app key "test-app-key" and refresh token
// "test-refresh-token"): access tokens, list_folder and its continue (paged, with change
// cursors), get_temporary_link (a /mock-dropbox/media/ URL with Range support), get_metadata,
// download with Range, and upload sessions, whose parts go to a scratch folder and are moved into
// DIR when finished. For tests: POST /mock-dropbox/__config {tokenTtl, linkTtl (seconds),
// pageSize}, POST /mock-dropbox/__expire {tokens, links}, POST /mock-dropbox/__fault {call,
// mode: "drop" | "lose-reply", count}, GET /mock-dropbox/__stats.
//
// usage: node dev/serve.mjs [--port 8765] [--mock-github DIR] [--mock-dropbox DIR] FILE...
// Tests import createServer() and listen on a free port.
import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, copyFileSync, createReadStream, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync,
  readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".webmanifest": "application/manifest+json",
  ".png": "image/png", ".woff2": "font/woff2", ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime",
  ".aac": "audio/aac", ".txt": "text/plain; charset=utf-8" };

/** Sends a file, honouring a Range header (Safari needs it to play video). */
function sendFile(req, res, file, extra = {}) {
  let st;
  try { st = statSync(file); if (!st.isFile()) throw new Error(); } catch { return res.writeHead(404).end(); }
  const headers = { "Content-Type": types[path.extname(file).toLowerCase()] || "application/octet-stream", "Accept-Ranges": "bytes",
    "Cache-Control": "no-store", ...extra };
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
}
const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => resolve(Buffer.concat(chunks)));
  req.on("error", reject);
});
const sendJson = (res, status, body, extra = {}) => res.writeHead(status, { "Content-Type": "application/json",
  "Cache-Control": "no-store", ...extra }).end(body === undefined ? "" : JSON.stringify(body));

/** The server: the app, the media allow-list, and the mocks asked for (scratch: where upload
 *  sessions keep their parts; a new temporary folder by default). */
export function createServer({ media = [], mockGithub = null, mockDropbox = null, scratch = null } = {}) {
  const mediaFiles = new Map(media.map((f) => [`/media/${encodeURIComponent(path.basename(f))}`, path.resolve(f)]));
  const shared = { offline: false, dropboxDir: mockDropbox ? path.resolve(mockDropbox) : null };
  const github = mockGithub && githubMock(path.resolve(mockGithub), mediaFiles, shared);
  const dropbox = mockDropbox && dropboxMock(shared.dropboxDir, shared, scratch || mkdtempSync(path.join(os.tmpdir(), "lk-mock-uploads-")));
  return http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (github && url.pathname.startsWith("/mock-github/")) return github(req, res, url);
    if (dropbox && url.pathname.startsWith("/mock-dropbox/")) return dropbox(req, res, url);
    let file = mediaFiles.get(url.pathname);
    if (!file) {
      if (/^\/(dev|tests|\.git|node_modules)(\/|$)/.test(url.pathname)) return res.writeHead(404).end();
      file = path.join(root, decodeURIComponent(url.pathname), url.pathname.endsWith("/") ? "index.html" : "");
      if (file !== root && !file.startsWith(root + path.sep)) return res.writeHead(403).end();
    }
    return sendFile(req, res, file);
  });
}

// ---------------------------------------------------------------- stand-in for GitHub's contents API
const blobSha = (buf) => createHash("sha1").update(`blob ${buf.length}\0`).update(buf).digest("hex");
function githubMock(dir, mediaFiles, shared) {
  const dispatches = [];
  return (req, res, url) => {
    const json = (status, body, extra) => sendJson(res, status, body, extra);
    if (url.pathname === "/mock-github/__offline" && req.method === "POST") {
      shared.offline = url.searchParams.get("on") === "1";
      return json(200, { offline: shared.offline });
    }
    if (url.pathname === "/mock-github/__dispatches") {
      if (req.method === "DELETE") dispatches.length = 0;
      return json(200, dispatches);
    }
    if (url.pathname === "/mock-github/__job" && req.method === "POST") return readBody(req).then((b) => finishJob(JSON.parse(b.toString("utf8") || "{}")));
    if (shared.offline) return req.socket.destroy();
    const auth = req.headers.authorization || "";
    if (auth !== "Bearer test-token" && auth !== "Bearer readonly-token") return json(401, { message: "Bad credentials" });
    const wf = /^\/mock-github\/repos\/[^/]+\/[^/]+\/actions\/workflows\/([^/]+)\/dispatches$/.exec(url.pathname);
    if (wf && req.method === "POST") {
      if (auth === "Bearer readonly-token") return json(403, { message: "Resource not accessible by personal access token" });
      if (decodeURIComponent(wf[1]) !== "transcribe.yml") return json(404, { message: "Not Found" });
      return readBody(req).then((b) => {
        const body = JSON.parse(b.toString("utf8") || "{}");
        if (body.ref !== "main") return json(422, { message: `No ref found for: ${body.ref}` });
        if (typeof body.inputs?.item !== "string") return json(422, { message: "Required input 'item' not provided" });
        dispatches.push({ workflow: decodeURIComponent(wf[1]), ref: body.ref, inputs: body.inputs, at: new Date().toISOString() });
        res.writeHead(204).end();
      });
    }
    const m = /^\/mock-github\/repos\/([^/]+)\/([^/]+)(?:\/contents\/(.+))?$/.exec(url.pathname);
    if (!m) return json(404, { message: "Not Found" });
    if (!m[3]) return json(200, { full_name: `${m[1]}/${m[2]}`, private: true });
    const rel = decodeURIComponent(m[3]), file = path.join(dir, rel);
    if (!file.startsWith(dir + path.sep)) return json(404, { message: "Not Found" });
    let buf = null;
    try { buf = readFileSync(file); } catch { /* missing */ }
    if (req.method === "GET") {
      if (!buf) return json(404, { message: "Not Found" });
      const sha = blobSha(buf), etag = `"${sha}"`;
      if ((req.headers.accept || "").includes("raw")) {
        if (req.headers["if-none-match"] === etag) return res.writeHead(304, { ETag: etag }).end();
        return res.writeHead(200, { "Content-Type": "application/vnd.github.raw+json; charset=utf-8", ETag: etag, "Cache-Control": "no-store" }).end(buf);
      }
      const small = buf.length <= 1024 * 1024;   // like GitHub: no content past 1 MB
      return json(200, { type: "file", name: path.basename(rel), path: rel, sha, size: buf.length,
        encoding: small ? "base64" : "none", content: small ? buf.toString("base64").replace(/.{60}/g, "$&\n") : "" }, { ETag: etag });
    }
    if (req.method === "PUT") {
      if (auth === "Bearer readonly-token") return json(403, { message: "Resource not accessible by personal access token" });
      return readBody(req).then((b) => {
        const body = JSON.parse(b.toString("utf8"));
        try { buf = readFileSync(file); } catch { buf = null; }   // as it is now, after the upload arrived
        if (buf && !body.sha) return json(422, { message: "Invalid request.\n\n\"sha\" wasn't supplied." });
        if (buf && body.sha !== blobSha(buf)) return json(409, { message: `${rel} does not match ${body.sha}` });
        const data = Buffer.from(body.content, "base64");
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, data);
        json(buf ? 200 : 201, { content: { path: rel, sha: blobSha(data), size: data.length }, commit: { message: body.message } });
      });
    }
    return json(405, { message: "Method not allowed" });

    // The transcription job's result, as the real job would commit it.
    function finishJob({ item, status = "ready", transcript, error }) {
      const indexFile = path.join(dir, "index.json"), index = JSON.parse(readFileSync(indexFile, "utf8"));
      const entry = (index.videos || []).find((v) => v.key === item);
      if (!entry) return json(404, { message: `No index entry ${item}` });
      const updated = new Date().toISOString().replace(/\.\d+Z$/, "+00:00");
      if (status === "ready") {
        const src = mediaFiles.get(transcript);
        if (!src) return json(400, { message: "transcript must be the /media/ path of a JSON file given on the command line" });
        const data = JSON.parse(readFileSync(src, "utf8")), rel = `transcripts/${entry.key}.json`;
        mkdirSync(path.join(dir, "transcripts"), { recursive: true });
        writeFileSync(path.join(dir, rel), JSON.stringify({ ...data, video: entry.name, video_size: entry.size,
          video_fingerprint: entry.fingerprint, duration_ms: entry.duration_ms }));
        if (entry.staged && shared.dropboxDir) rmSync(path.join(shared.dropboxDir, entry.staged), { force: true });
        Object.assign(entry, { transcript: rel, status: "ready", error: null, staged: null, id: data.id ?? null,
          words: (data.tokens || []).length, updated });
      } else {
        Object.assign(entry, { status: "failed", error: error || "The mock job failed.", updated });
      }
      writeFileSync(indexFile, JSON.stringify(index, null, 1) + "\n");
      return json(200, entry);
    }
  };
}

// ---------------------------------------------------------------- stand-in for Dropbox
function dropboxMock(dir, shared, scratch) {
  const config = { tokenTtl: 14400, linkTtl: 14400, pageSize: 2000 };
  const tokens = new Map(), links = new Map(), sessions = new Map(), snapshots = new Map(), hashes = new Map();
  const fault = { call: null, mode: null, count: 0 };
  const stats = { calls: {}, received: 0, tokens: 0 };
  let serial = 0;
  const iso = (d) => d.toISOString().replace(/\.\d+Z$/, "Z");

  /** Dropbox's content hash of a file on disk (cached while it is unchanged). */
  function contentHash(file, st) {
    const c = hashes.get(file);
    if (c && c.size === st.size && c.mtimeMs === st.mtimeMs) return c.hash;
    const fd = openSync(file, "r"), buf = Buffer.alloc(4 * 1024 * 1024), blocks = [];
    try {
      for (let pos = 0; ;) {
        let n = 0;
        while (n < buf.length) { const got = readSync(fd, buf, n, buf.length - n, pos + n); if (!got) break; n += got; }
        if (!n) break;
        blocks.push(createHash("sha256").update(buf.subarray(0, n)).digest());
        pos += n;
        if (n < buf.length) break;
      }
    } finally { closeSync(fd); }
    const hash = createHash("sha256").update(Buffer.concat(blocks)).digest("hex");
    hashes.set(file, { size: st.size, mtimeMs: st.mtimeMs, hash });
    return hash;
  }
  /** Every entry under the app folder: {rel ("/A/b.mp4"), full, st}, folders first in each. */
  function walk() {
    const out = [];
    const visit = (rel) => {
      for (const name of readdirSync(path.join(dir, rel)).sort()) {
        if (name === ".DS_Store") continue;
        const r = `${rel}/${name}`, full = path.join(dir, r);
        let st;
        try { st = statSync(full); } catch { continue; }   // follows symlinks
        if (st.isDirectory()) { out.push({ rel: r, full, st }); visit(r); } else if (st.isFile()) out.push({ rel: r, full, st });
      }
    };
    visit("");
    return out;
  }
  const meta = ({ rel, full, st }) => (st.isDirectory()
    ? { ".tag": "folder", name: path.basename(rel), id: `id:${createHash("sha1").update(rel.toLowerCase()).digest("hex").slice(0, 16)}`,
      path_lower: rel.toLowerCase(), path_display: rel }
    : { ".tag": "file", name: path.basename(rel), id: `id:${createHash("sha1").update(rel.toLowerCase()).digest("hex").slice(0, 16)}`,
      client_modified: iso(st.mtime), server_modified: iso(st.mtime), rev: `015${Math.floor(st.mtimeMs).toString(16)}`,
      size: st.size, path_lower: rel.toLowerCase(), path_display: rel, is_downloadable: true, content_hash: contentHash(full, st) });
  const find = (p) => walk().find((e) => e.rel.toLowerCase() === String(p).toLowerCase() && e.st.isFile());
  const inside = (p) => { const f = path.join(dir, p); return f.startsWith(dir + path.sep) ? f : null; };
  const conflict = (summary, error) => ({ status: 409, body: { error_summary: summary, error } });
  const notFound = { status: 409, body: { error_summary: "path/not_found/..", error: { ".tag": "path", path: { ".tag": "not_found" } } } };

  // Listings: a snapshot remembers what was listed, so continue can page through it and then
  // report what changed since.
  function snapshot(entries, pending, limit) {
    const id = `s${++serial}`, state = new Map(entries.map((e) => [e.path_lower, e]));
    snapshots.set(id, { state, pending, limit });
    return page(id, 0);
  }
  function page(id, pos) {
    const s = snapshots.get(id), n = Math.max(1, Math.min(s.limit || 2000, config.pageSize));
    const cursor = Buffer.from(JSON.stringify({ id, pos: pos + n })).toString("base64url");
    return { status: 200, body: { entries: s.pending.slice(pos, pos + n), cursor, has_more: pos + n < s.pending.length } };
  }
  const listed = () => walk().map(meta);
  const rpc = {
    "files/list_folder": ({ path: p = "", recursive = false, limit }) => {
      const prefix = p ? `${p.toLowerCase()}/` : "/";
      const all = listed().filter((e) => e.path_lower.startsWith(prefix) && (recursive || !e.path_lower.slice(prefix.length).includes("/")));
      return snapshot(all, all, limit);
    },
    "files/list_folder/continue": ({ cursor }) => {
      let c = null;
      try { c = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); } catch { /* not ours */ }
      const s = c && snapshots.get(c.id);
      if (!s) return conflict("reset/..", { ".tag": "reset" });
      if (c.pos < s.pending.length) return page(c.id, c.pos);
      const now = listed(), changes = [];
      const nowMap = new Map(now.map((e) => [e.path_lower, e]));
      for (const [lower, e] of s.state) if (!nowMap.has(lower)) changes.push({ ".tag": "deleted", name: e.name, path_lower: lower, path_display: e.path_display });
      for (const e of now) { const was = s.state.get(e.path_lower); if (!was || was.rev !== e.rev || was.size !== e.size) changes.push(e); }
      return snapshot(now, changes, s.limit);
    },
    "files/get_metadata": ({ path: p }) => { const f = find(p); return f ? { status: 200, body: meta(f) } : notFound; },
    "files/get_temporary_link": ({ path: p }, req) => {
      const f = find(p);
      if (!f) return notFound;
      const id = randomBytes(9).toString("hex");
      links.set(id, { file: f.full, expires: Date.now() + config.linkTtl * 1000 });
      return { status: 200, body: { metadata: meta(f), link: `http://${req.headers.host}/mock-dropbox/media/${id}/${encodeURIComponent(path.basename(f.rel))}` } };
    },
  };

  const lookupError = (finish, error) => (finish ? { ".tag": "lookup_failed", lookup_failed: error } : error);
  const sessionCheck = (finish, cursor) => {
    const s = sessions.get(cursor?.session_id);
    if (!s) return conflict(`${finish ? "lookup_failed/" : ""}not_found/`, lookupError(finish, { ".tag": "not_found" }));
    if (cursor.offset !== s.length) {
      return conflict(`${finish ? "lookup_failed/" : ""}incorrect_offset/..`, lookupError(finish, { ".tag": "incorrect_offset", correct_offset: s.length }));
    }
    return null;
  };
  function commitUpload(s, commit) {
    const mode = typeof commit.mode === "string" ? commit.mode : commit.mode?.[".tag"] || "add";
    let target = inside(commit.path);
    if (!target) return conflict("path/malformed_path/", { ".tag": "path", path: { ".tag": "malformed_path" } });
    const there = find(commit.path);
    if (there && mode !== "overwrite") {
      const same = !commit.strict_conflict && contentHash(s.file, statSync(s.file)) === contentHash(there.full, there.st);
      if (same) { rmSync(s.file); return { status: 200, body: meta(there) }; }
      if (!commit.autorename) return conflict("path/conflict/file/..", { ".tag": "path", path: { ".tag": "conflict", conflict: { ".tag": "file" } } });
      const ext = path.extname(commit.path), stem = commit.path.slice(0, commit.path.length - ext.length);
      let k = 1;
      while (find(`${stem} (${k})${ext}`)) k++;
      target = inside(`${stem} (${k})${ext}`);
    }
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(s.file, target);
    rmSync(s.file);
    const rel = `/${path.relative(dir, target).split(path.sep).join("/")}`;
    return { status: 200, body: meta({ rel, full: target, st: statSync(target) }) };
  }
  function upload(call, arg, body) {
    stats.received += body.length;
    if (call === "start") {
      const id = `session-${++serial}-${randomBytes(4).toString("hex")}`, file = path.join(scratch, id);
      writeFileSync(file, body);
      sessions.set(id, { file, length: body.length });
      return { status: 200, body: { session_id: id } };
    }
    const finish = call === "finish", bad = sessionCheck(finish, arg.cursor);
    if (bad) return bad;
    const s = sessions.get(arg.cursor.session_id);
    writeFileSync(s.file, body, { flag: "a" });
    s.length += body.length;
    if (!finish) return { status: 200, body: null };
    sessions.delete(arg.cursor.session_id);
    return commitUpload(s, arg.commit || {});
  }

  return (req, res, url) => {
    const json = (status, body, extra) => sendJson(res, status, body, extra);
    const route = url.pathname.slice("/mock-dropbox/".length);
    if (route === "__offline" && req.method === "POST") { shared.offline = url.searchParams.get("on") === "1"; return json(200, { offline: shared.offline }); }
    if (route === "__stats") return json(200, { ...stats, sessions: sessions.size, links: links.size });
    if (route === "__config" && req.method === "POST") return readBody(req).then((b) => json(200, Object.assign(config, JSON.parse(b.toString("utf8") || "{}"))));
    if (route === "__expire" && req.method === "POST") {
      return readBody(req).then((b) => {
        const what = JSON.parse(b.toString("utf8") || "{}");
        if (what.tokens) tokens.clear();
        if (what.links) for (const l of links.values()) l.expires = 0;
        json(200, { tokens: tokens.size, links: links.size });
      });
    }
    if (route === "__fault" && req.method === "POST") return readBody(req).then((b) => json(200, Object.assign(fault, JSON.parse(b.toString("utf8") || "{}"))));
    if (shared.offline) return req.socket.destroy();
    const call = route.startsWith("media/") ? "media" : route;
    stats.calls[call] = (stats.calls[call] || 0) + 1;

    const media = /^media\/([0-9a-f]+)\//.exec(route);
    if (media) {
      const link = links.get(media[1]);
      if (!link || Date.now() > link.expires) return res.writeHead(410, { "Content-Type": "text/plain" }).end("This link has expired.");
      return sendFile(req, res, link.file);
    }
    if (route === "oauth2/token" && req.method === "POST") {
      return readBody(req).then((b) => {
        const f = new URLSearchParams(b.toString("utf8"));
        if (f.get("grant_type") !== "refresh_token" || f.get("refresh_token") !== "test-refresh-token" || f.get("client_id") !== "test-app-key") {
          return json(400, { error: "invalid_grant", error_description: "refresh token is invalid or revoked" });
        }
        const token = `test-access-${++serial}`;
        tokens.set(token, Date.now() + config.tokenTtl * 1000);
        stats.tokens++;
        json(200, { access_token: token, token_type: "bearer", expires_in: config.tokenTtl });
      });
    }
    const token = (req.headers.authorization || "").replace(/^Bearer /, "");
    if (!tokens.has(token) || Date.now() > tokens.get(token)) {
      const tag = tokens.has(token) ? "expired_access_token" : "invalid_access_token";
      return json(401, { error_summary: `${tag}/`, error: { ".tag": tag } });
    }
    let arg = {};
    try { arg = JSON.parse(req.headers["dropbox-api-arg"] || url.searchParams.get("arg") || "{}"); } catch { return res.writeHead(400).end("Error in call: Dropbox-API-Arg isn't JSON"); }
    if (route === "content/2/files/download") {
      const f = find(arg.path);
      if (!f) return json(notFound.status, notFound.body);
      return sendFile(req, res, f.full, { "Dropbox-API-Result": JSON.stringify(meta(f)).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`) });
    }
    const up = /^content\/2\/files\/upload_session\/(start|append_v2|finish)$/.exec(route);
    if (up && req.method === "POST") {
      const step = up[1] === "append_v2" ? "append" : up[1];
      const faulty = fault.count > 0 && (fault.call === step || fault.call === "any");
      if (faulty) fault.count--;
      if (faulty && fault.mode === "drop") return req.socket.destroy();
      return readBody(req).then((body) => {
        const out = upload(step, arg, body);
        if (faulty && fault.mode === "lose-reply") return req.socket.destroy();
        json(out.status, out.body);
      });
    }
    const handler = rpc[route.replace(/^2\//, "")];
    if (!handler || req.method !== "POST" || !route.startsWith("2/")) return json(404, { error_summary: "unknown endpoint" });
    return readBody(req).then((b) => {
      let body;
      try { body = JSON.parse(b.toString("utf8") || "null") ?? {}; } catch { return res.writeHead(400).end("Error in call: the body isn't JSON"); }
      const out = handler(body, req);
      json(out.status, out.body);
    });
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const option = (name) => { const at = args.indexOf(name); return at >= 0 ? args.splice(at, 2)[1] : null; };
  const port = Number(option("--port") || 8765);
  const mockGithub = option("--mock-github"), mockDropbox = option("--mock-dropbox");
  for (const d of [mockGithub, mockDropbox]) if (d && !existsSync(d)) mkdirSync(d, { recursive: true });
  createServer({ media: args, mockGithub, mockDropbox }).listen(port, "127.0.0.1", () => console.log(
    `serving ${root} and ${args.length} media file(s) at http://127.0.0.1:${port}/` +
    (mockGithub ? `; mock GitHub repository ${path.resolve(mockGithub)} at /mock-github` : "") +
    (mockDropbox ? `; mock Dropbox folder ${path.resolve(mockDropbox)} at /mock-dropbox` : "")));
}
