// Dropbox and the transcription job, against the stand-ins in dev/serve.mjs (test tokens only):
// Dropbox's content hash (on its published example file, downloaded once to a temporary folder),
// the client's token renewal, paged listing and change cursor, byte ranges and temporary links,
// resumable uploads, the library's matching of Dropbox files to index entries, starting the job,
// and index.json updates past 1 MB.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "../dev/serve.mjs";
import { BLOCK, CHUNK, ContentHasher, Dropbox, contentHash } from "../core/dropbox.js";
import { GitHub } from "../core/github.js";
import { changedEntry, entryStatus, groupByFolder, indexEntry, keyFor, mergeLibrary, searchLibrary, withEntry } from "../core/library.js";

/** Dropbox's content hash computed with node:crypto, to check the browser code against. */
function reference(buf) {
  const blocks = [];
  for (let at = 0; at < buf.length; at += BLOCK) blocks.push(createHash("sha256").update(buf.subarray(at, at + BLOCK)).digest());
  return createHash("sha256").update(Buffer.concat(blocks)).digest("hex");
}
const reader = (buf) => async (offset, length) => new Uint8Array(buf.buffer, buf.byteOffset + offset, Math.max(0, Math.min(length, buf.length - offset)));
const source = (buf) => ({ size: buf.length, read: reader(buf) });
const fp = (seed) => `fp1-${createHash("sha256").update(String(seed)).digest("hex")}`;
/** What IndexedDB does for the app: keeps a copy of each value. */
function memoryStore() {
  const m = new Map();
  return { m, get: async (k) => structuredClone(m.get(k)), put: async (k, v) => void m.set(k, structuredClone(v)), delete: async (k) => void m.delete(k) };
}

let server, origin, base, repo, box;
before(async () => {
  base = mkdtempSync(path.join(os.tmpdir(), "lk-dropbox-test-"));
  repo = path.join(base, "repo");
  box = path.join(base, "dropbox");
  for (const d of [repo, box, path.join(base, "scratch")]) mkdirSync(d);
  server = createServer({ mockGithub: repo, mockDropbox: box, scratch: path.join(base, "scratch") });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  rmSync(base, { recursive: true, force: true });
});
const post = (route, body) => fetch(`${origin}${route}`, { method: "POST", body: JSON.stringify(body ?? {}) }).then((r) => r.json());
const stats = () => fetch(`${origin}/mock-dropbox/__stats`).then((r) => r.json());
const dropbox = () => new Dropbox({ appKey: "test-app-key", refreshToken: "test-refresh-token",
  api: `${origin}/mock-dropbox`, content: `${origin}/mock-dropbox/content` });
const put = (rel, buf) => { const f = path.join(box, rel); mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, buf); return buf; };

const MILKY_WAY = { url: "https://www.dropbox.com/static/images/developers/milky-way-nasa.jpg", size: 9711423,
  hash: "485291fa0ee50c016982abbfa943957bcd231aae0492ccbaa22c58e3997b35e0" };
/** Dropbox's example file, downloaded once to the system's temporary folder (never the repository). */
async function milkyWay() {
  const file = path.join(os.tmpdir(), "lecture-karaoke-tests", "milky-way-nasa.jpg");
  if (existsSync(file) && statSync(file).size === MILKY_WAY.size) return readFileSync(file);
  try {
    const res = await fetch(MILKY_WAY.url, { signal: AbortSignal.timeout(60000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, buf);
    return buf;
  } catch {
    return null;
  }
}

test("content hash: Dropbox's example file, any block edges, and a hash resumed from its saved state", async (t) => {
  for (const size of [0, 1, BLOCK - 1, BLOCK, BLOCK + 1, 2 * BLOCK + 5, 3 * CHUNK]) {
    const buf = randomBytes(size);
    assert.equal(await contentHash(reader(buf), size), reference(buf), `${size} bytes`);
  }
  const buf = randomBytes(2 * CHUNK + 777), h = new ContentHasher();
  for (let at = 0; at < buf.length; at += 1000003) await h.update(new Uint8Array(buf.subarray(at, at + 1000003)));
  assert.equal(await h.digest(), reference(buf), "fed in odd pieces");
  const first = new ContentHasher();
  await first.update(new Uint8Array(buf.subarray(0, CHUNK)));
  const resumed = new ContentHasher(first.state());
  await resumed.update(new Uint8Array(buf.subarray(CHUNK)));
  assert.equal(await resumed.digest(), reference(buf), "carried across an interruption");
  const milky = await milkyWay();
  if (!milky) return t.skip("couldn't download Dropbox's example file");
  assert.equal(milky.length, MILKY_WAY.size);
  assert.equal(await contentHash(reader(milky), milky.length), MILKY_WAY.hash, "Dropbox's published value");
});

test("Dropbox client: token renewal, paged listing, change cursor, byte ranges, temporary links", async () => {
  const files = { "/CS224N/Lecture 1.mp4": put("CS224N/Lecture 1.mp4", randomBytes(5000)),
    "/CS224N/Lecture 2.mp4": put("CS224N/Lecture 2.mp4", randomBytes(6000)),
    "/Khoá học/Tiếng Việt.mp4": put("Khoá học/Tiếng Việt.mp4", randomBytes(BLOCK + 10)),
    "/Top.mp4": put("Top.mp4", randomBytes(100)), "/.staging/fp1-x.aac": put(".staging/fp1-x.aac", randomBytes(50)) };
  await post("/mock-dropbox/__config", { pageSize: 2 });
  const dbx = dropbox(), calls0 = (await stats()).calls;
  const { entries, cursor } = await dbx.list();
  const listed = entries.filter((e) => e[".tag"] === "file");
  assert.deepEqual(listed.map((e) => e.path_display).sort(), Object.keys(files).sort());
  for (const e of listed) assert.equal(e.content_hash, reference(files[e.path_display]), e.path_display);
  assert.ok(((await stats()).calls["2/files/list_folder/continue"] ?? 0) - (calls0["2/files/list_folder/continue"] ?? 0) >= 3, "listed in pages");

  put("CS224N/Lecture 3.mp4", randomBytes(10));
  unlinkSync(path.join(box, "Top.mp4"));
  const changed = await dbx.changes(cursor);
  assert.deepEqual(changed.entries.map((e) => [e[".tag"], e.path_display]).sort(),
    [["deleted", "/Top.mp4"], ["file", "/CS224N/Lecture 3.mp4"]]);
  assert.deepEqual((await dbx.changes(changed.cursor)).entries, [], "nothing new since");
  await assert.rejects(dbx.changes("not-a-cursor"), { kind: "reset" });

  const tokens = (await stats()).tokens;
  await post("/mock-dropbox/__expire", { tokens: true });
  assert.equal((await dbx.metadata("/CS224N/Lecture 1.mp4")).size, 5000, "an expired token is renewed and the call repeated");
  assert.equal((await stats()).tokens, tokens + 1);
  await assert.rejects(new Dropbox({ appKey: "test-app-key", refreshToken: "revoked", api: `${origin}/mock-dropbox` }).list(), { kind: "token" });

  const viet = files["/Khoá học/Tiếng Việt.mp4"];
  assert.deepEqual(Buffer.from(await dbx.download("/Khoá học/Tiếng Việt.mp4", BLOCK - 5, BLOCK + 4)), viet.subarray(BLOCK - 5, BLOCK + 5),
    "a range of a file with a Vietnamese name (escaped in the Dropbox-API-Arg header)");
  const { link, expires } = await dbx.temporaryLink("/CS224N/Lecture 2.mp4");
  assert.ok(Math.abs(expires - Date.now() - 4 * 3600 * 1000) < 60000, "valid 4 hours");
  const part = await fetch(link, { headers: { Range: "bytes=100-199" } });
  assert.equal(part.status, 206);
  assert.deepEqual(Buffer.from(await part.arrayBuffer()), files["/CS224N/Lecture 2.mp4"].subarray(100, 200));
  await post("/mock-dropbox/__expire", { links: true });
  assert.equal((await fetch(link, { headers: { Range: "bytes=0-9" } })).status, 410, "an expired link stops working");
  await assert.rejects(dbx.temporaryLink("/nowhere.mp4"), { kind: "missing" });
  await post("/mock-dropbox/__config", { pageSize: 2000 });
});

test("uploads: 8 MB chunks, resumed after an interruption and through lost replies, content hash checked", async () => {
  const dbx = dropbox(), saved = memoryStore(), src = randomBytes(2 * CHUNK + 12345);
  // interrupted after the first chunk: what Dropbox has is remembered
  const stop = new AbortController(), progress = [];
  await assert.rejects(dbx.upload(source(src), "/Uploads/Big lecture.mp4", { key: "fp:video", saved, signal: stop.signal,
    onProgress: (done) => { progress.push(done); stop.abort(); } }), { name: "AbortError" });
  assert.deepEqual(progress, [CHUNK]);
  const kept = await saved.get("fp:video");
  assert.equal(kept.offset, CHUNK);
  assert.equal(kept.blocks.length, CHUNK / BLOCK, "the hashed blocks are kept too");
  // resumed, and the reply to its next chunk is lost: Dropbox has that chunk, says where it is
  // (incorrect_offset), and the upload goes on from there
  const before = (await stats()).received;
  await post("/mock-dropbox/__fault", { call: "append", mode: "lose-reply", count: 1 });
  const done = await dbx.upload(source(src), "/Uploads/Big lecture.mp4", { key: "fp:video", saved });
  assert.equal(done.hash, reference(src));
  assert.equal(done.metadata.content_hash, done.hash);
  assert.equal(done.metadata.path_display, "/Uploads/Big lecture.mp4");
  assert.ok(readFileSync(path.join(box, "Uploads/Big lecture.mp4")).equals(src));
  assert.equal((await stats()).received - before, src.length - CHUNK + CHUNK,
    "the first chunk wasn't sent again; only the chunk whose reply was lost was");
  assert.equal(await saved.get("fp:video"), undefined, "a finished upload is forgotten");

  // the reply to the commit is lost: the file is found in place, with its hash
  const small = randomBytes(3 * 1024 * 1024);
  await post("/mock-dropbox/__fault", { call: "finish", mode: "lose-reply", count: 1 });
  const s = await dbx.upload(source(small), "/Uploads/Small.mp4", { key: "fp:small", saved });
  assert.equal(s.metadata.path_display, "/Uploads/Small.mp4");
  assert.equal(s.hash, reference(small));
  // a dropped connection is retried; the same file again isn't duplicated, another one is renamed
  await post("/mock-dropbox/__fault", { call: "start", mode: "drop", count: 1 });
  assert.equal((await dbx.upload(source(small), "/Uploads/Small.mp4")).metadata.path_display, "/Uploads/Small.mp4");
  assert.equal((await dbx.upload(source(randomBytes(10)), "/Uploads/Small.mp4")).metadata.path_display, "/Uploads/Small (1).mp4");
  // staged audio replaces an earlier attempt's
  const audio = randomBytes(1000);
  await dbx.upload(source(randomBytes(500)), "/.staging/fp1-y.aac", { mode: "overwrite" });
  assert.equal((await dbx.upload(source(audio), "/.staging/fp1-y.aac", { mode: "overwrite" })).metadata.path_display, "/.staging/fp1-y.aac");
  assert.ok(readFileSync(path.join(box, ".staging/fp1-y.aac")).equals(audio));
  // a session Dropbox no longer knows (they expire after a week) starts again from the beginning
  await saved.put("fp:old", { path: "/Uploads/Old.mp4", size: src.length, sessionId: "session-gone", offset: CHUNK, blocks: kept.blocks });
  assert.equal((await dbx.upload(source(src), "/Uploads/Old.mp4", { key: "fp:old", saved })).hash, reference(src));
  assert.ok(readFileSync(path.join(box, "Uploads/Old.mp4")).equals(src));
});

test("library: Dropbox files matched to index entries by content hash, then by name and size", () => {
  const file = (p, size, hash) => ({ ".tag": "file", name: p.split("/").pop(), path_lower: p.toLowerCase(), path_display: p, size, content_hash: hash });
  const files = [
    file("/CS224N/Lecture 12.mp4", 100, "h12"),     // its entry knows its hash
    file("/CS224N/Lecture 2.mp4", 200, "h2"),       // entry made before Dropbox: by name and size
    file("/CS224N/Lecture 10.mp4", 300, "h10"),     // no entry: not transcribed yet
    file("/Talks/Renamed.mp4", 100, "h12"),         // the same file again, elsewhere
    file("/Top.mp4", 400, "htop"),                  // uploaded from the app, being transcribed
    file("/Talks/Failed.mp4", 500, "hf"),
    file("/Talks/Same name.mp4", 600, "hnew"),      // name and size of an entry that has another file's hash
    file("/Khoá học/Tiếng Việt.MP4", 650, "hv"),
    file("/.staging/fp1-abc.aac", 50, "hs"),        // staged audio isn't a video of the library
    file("/CS224N/slides.pdf", 70, "hp"),
    { ".tag": "folder", name: "CS224N", path_lower: "/cs224n", path_display: "/CS224N" },
  ];
  const videos = [
    indexEntry({ key: "Lecture 12", name: "Stanford Lecture 12.mp4", size: 100, fingerprint: fp(12),
      dropbox: { path: "/CS224N/Lecture 12.mp4", hash: "h12" }, transcript: "transcripts/Lecture 12.json" }),
    { key: "Lecture 2", name: "Lecture 2.mp4", size: 200, fingerprint: fp(2), transcript: "transcripts/Lecture 2.json" },
    indexEntry({ key: "Top", name: "Top.mp4", size: 400, fingerprint: fp("top"), dropbox: { path: "/Top.mp4", hash: "htop" } }),
    indexEntry({ key: "Failed", name: "Failed.mp4", size: 500, fingerprint: fp("f"), dropbox: { path: "/Talks/Failed.mp4", hash: "hf" },
      status: "failed", error: "Soniox said no" }),
    indexEntry({ key: "Same name", name: "Same name.mp4", size: 600, fingerprint: fp("sn"), dropbox: { path: "/Old/Same name.mp4", hash: "hold" },
      transcript: "transcripts/Same name.json" }),
    indexEntry({ key: "Local", name: "Local.mp4", size: 700, fingerprint: fp("l"), staged: `/.staging/${fp("l")}.aac`, skip_ms: 23 }),
  ];
  const lib = mergeLibrary(files, videos);
  assert.deepEqual(lib.map((i) => [i.path, i.entry?.key ?? null, i.status]), [
    ["/Top.mp4", "Top", "pending"],
    ["/CS224N/Lecture 2.mp4", "Lecture 2", "ready"],
    ["/CS224N/Lecture 10.mp4", null, null],
    ["/CS224N/Lecture 12.mp4", "Lecture 12", "ready"],
    ["/Khoá học/Tiếng Việt.MP4", null, null],
    ["/Talks/Failed.mp4", "Failed", "failed"],
    ["/Talks/Renamed.mp4", "Lecture 12", "ready"],
    ["/Talks/Same name.mp4", null, null],
  ]);
  assert.deepEqual(lib[3], { name: "Lecture 12.mp4", path: "/CS224N/Lecture 12.mp4", folder: "CS224N", size: 100, hash: "h12",
    entry: videos[0], status: "ready" });
  assert.deepEqual(groupByFolder(lib).map((g) => [g.folder, g.items.length]), [["", 1], ["CS224N", 3], ["Khoá học", 1], ["Talks", 3]]);
  assert.deepEqual(searchLibrary(lib, "lecture 1").map((i) => i.name), ["Lecture 10.mp4", "Lecture 12.mp4"]);
  assert.deepEqual(searchLibrary(lib, "tieng VIET").map((i) => i.name), ["Tiếng Việt.MP4"], "case and accents ignored");
  assert.equal(searchLibrary(lib, "  ").length, lib.length);

  assert.equal(keyFor("Stanford Lecture 12.mp4", fp(12), videos), "Lecture 12", "a video keeps its key");
  assert.equal(keyFor("Top.mp4", fp("other"), videos), `Top (${fp("other").slice(4, 12)})`, "a taken key gets part of the fingerprint");
  assert.equal(keyFor("New one.mov", fp("n"), videos), "New one");
  assert.deepEqual([entryStatus(null), entryStatus({ transcript: "t.json", status: "pending" }), entryStatus({ status: "failed" }),
    entryStatus({ status: "pending" }), entryStatus({ transcript: null })], [null, "ready", "failed", "pending", "pending"]);
  const entry = indexEntry({ key: "K", name: "K.mp4", size: 1, fingerprint: fp("k"), staged: "/.staging/k.aac", skip_ms: 23 });
  assert.deepEqual(Object.keys(entry), ["key", "name", "folder", "size", "fingerprint", "duration_ms", "audio_start_ms", "width", "height",
    "dropbox", "staged", "skip_ms", "transcript", "status", "error", "id", "words", "updated"], "the shared field order");
  assert.equal(entry.status, "pending");
  assert.match(entry.updated, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+00:00$/);
  const next = withEntry({ version: 1, videos }, { ...videos[1], name: "A first.mp4", transcript: null });
  assert.equal(next.videos.length, videos.length, "replaced, by fingerprint");
  assert.equal(next.videos[0].name, "A first.mp4", "sorted by name");
  const old = { key: "Old", name: "Old.mp4", size: 2, fingerprint: fp("old"), transcript: "transcripts/Old.json", later: "kept" };
  const moved = changedEntry(old, { folder: "CS224N", dropbox: { path: "/CS224N/Old.mp4", hash: "h" } });
  assert.deepEqual(Object.keys(moved).slice(0, 18), Object.keys(entry), "an old entry gets every shared field, in order");
  assert.equal(moved.later, "kept", "fields the app doesn't know are kept");
  assert.deepEqual([moved.folder, moved.dropbox.path, moved.status, moved.transcript], ["CS224N", "/CS224N/Old.mp4", "ready", "transcripts/Old.json"]);
});

test("dispatch: starts transcribe.yml on main with the item; a token without Actions access is refused", async () => {
  await fetch(`${origin}/mock-github/__dispatches`, { method: "DELETE" });
  const gh = new GitHub({ repo: "Tien3991/lecture-transcripts", token: "test-token", api: `${origin}/mock-github` });
  assert.equal(await gh.dispatch("Lecture 12"), true);
  assert.equal(await gh.dispatch(), true, "an empty item checks everything");
  const calls = await (await fetch(`${origin}/mock-github/__dispatches`)).json();
  assert.deepEqual(calls.map((c) => [c.workflow, c.ref, c.inputs]),
    [["transcribe.yml", "main", { item: "Lecture 12" }], ["transcribe.yml", "main", { item: "" }]]);
  const readonly = new GitHub({ repo: "Tien3991/lecture-transcripts", token: "readonly-token", api: `${origin}/mock-github` });
  await assert.rejects(readonly.dispatch("Lecture 12"), { kind: "access", message: /Actions: read and write/ });
  await assert.rejects(gh.dispatch("Lecture 12", "missing.yml"), { kind: "missing" });
});

test("index.json past 1 MB: read raw with the sha from the ETag, written back, retried after another write", async () => {
  const file = path.join(repo, "index.json");
  const videos = Array.from({ length: 3000 }, (_, i) => indexEntry({ key: `Lecture ${i}`, name: `Lecture ${i}.mp4`, size: 3e8 + i,
    fingerprint: fp(i), duration_ms: 3.6e6, audio_start_ms: 33, width: 1920, height: 1080, dropbox: { path: `/C/Lecture ${i}.mp4`, hash: fp(-i).slice(4) },
    transcript: `transcripts/Lecture ${i}.json`, id: `id-${i}`, words: 9000 }));
  writeFileSync(file, JSON.stringify({ version: 1, videos }, null, 1) + "\n");
  assert.ok(statSync(file).size > 1024 * 1024, "over 1 MB");
  const gh = new GitHub({ repo: "Tien3991/lecture-transcripts", token: "test-token", api: `${origin}/mock-github` });
  const plain = await (await fetch(`${origin}/mock-github/repos/Tien3991/lecture-transcripts/contents/index.json`,
    { headers: { Authorization: "Bearer test-token" } })).json();
  assert.equal(plain.content, "", "past 1 MB the contents API sends no content, so it has to be read raw");
  const mine = indexEntry({ key: "New", name: "New.mp4", size: 5, fingerprint: fp("new") });
  let attempts = 0;
  const out = await gh.update("index.json", (cur) => {
    if (attempts++ === 0) {   // another device (or the job) writes first
      const other = JSON.parse(readFileSync(file, "utf8"));
      writeFileSync(file, JSON.stringify(withEntry(other, indexEntry({ key: "Other", name: "Other.mp4", size: 6, fingerprint: fp("other") })), null, 1) + "\n");
    }
    return withEntry(cur, mine);
  }, "Transcribe New.mp4");
  assert.equal(attempts, 2, "re-read and retried after the conflicting write");
  const disk = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(disk, out);
  assert.equal(disk.videos.length, 3002);
  assert.ok(disk.videos.some((v) => v.key === "Other") && disk.videos.some((v) => v.key === "New"), "both writes kept");
});
