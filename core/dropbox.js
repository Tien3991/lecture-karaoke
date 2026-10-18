// Dropbox through its HTTP API, for the app's own folder: the App-folder Dropbox app "Lecture
// Karaoke" (Dropbox/Apps/Lecture Karaoke/, a subfolder per course). The private transcripts
// repository holds config/dropbox.json, {"app_key", "refresh_token"}: a PKCE refresh token, so
// access tokens are made without a client secret, and every device that reaches GitHub reaches
// Dropbox too. Paths are relative to the app folder: "/CS224N/Lecture 12.mp4".
//
//   listing        files/list_folder (recursive), then list_folder/continue page by page; the
//                  cursor it ends with returns only what changed since (changes())
//   streaming      files/get_temporary_link: a plain URL for the <video> element, valid 4 hours
//   byte ranges    files/download with a Range header
//   deleting       files/delete_v2 (Dropbox keeps the file among its deleted files for a while)
//   uploads        upload sessions in 8 MB chunks, retried; the session, offset and hashed blocks
//                  are kept (by the caller, in IndexedDB) after every chunk, so an interrupted
//                  upload continues where it stopped
//   content hash   Dropbox's file hash (4 MB blocks), to recognise a file without downloading it

export class DropboxError extends Error {
  // kind: offline, token, missing, reset, conflict, other; detail: Dropbox's error object
  constructor(kind, message, detail = null) { super(message); this.kind = kind; this.detail = detail; }
}

export const BLOCK = 4 * 1024 * 1024;   // content-hash block
export const CHUNK = 2 * BLOCK;         // upload chunk (whole blocks, so a resumed hash lines up)
export const LINK_MS = 4 * 3600 * 1000; // a temporary link's life

const toHex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (hex) => Uint8Array.from(hex.match(/../g), (x) => parseInt(x, 16));
const sha256 = async (data) => new Uint8Array(await crypto.subtle.digest("SHA-256", data));
function join(parts, length) {
  const out = new Uint8Array(length);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(t); reject(signal.reason); }, { once: true });
});
const backoff = (attempt) => Math.min(16000, 1000 * 2 ** (attempt - 1));

/** JSON for the Dropbox-API-Arg header. Headers carry ASCII only, so other characters are
 *  \u-escaped (Vietnamese file names, for one). */
export const headerJson = (value) => JSON.stringify(value)
  .replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

/** Dropbox's content hash, fed a file's bytes in order: the SHA-256 of each 4 MB block, then the
 *  SHA-256 of those digests one after another. state() and new ContentHasher(state) carry the
 *  finished blocks across an interrupted upload. */
export class ContentHasher {
  constructor(blocks = []) {
    this.blocks = blocks.map(fromHex);   // digests of the finished blocks
    this.tail = [];                      // bytes of the block being filled
    this.tailLength = 0;
  }
  get position() { return this.blocks.length * BLOCK + this.tailLength; }
  state() { return this.blocks.map(toHex); }
  async update(bytes) {
    for (let at = 0; at < bytes.length;) {
      const take = Math.min(BLOCK - this.tailLength, bytes.length - at);
      if (take === BLOCK) this.blocks.push(await sha256(bytes.subarray(at, at + take)));   // a whole block: no copy
      else {
        this.tail.push(bytes.slice(at, at + take));
        this.tailLength += take;
        if (this.tailLength === BLOCK) await this.closeBlock();
      }
      at += take;
    }
  }
  async closeBlock() {
    this.blocks.push(await sha256(join(this.tail, this.tailLength)));
    this.tail = [];
    this.tailLength = 0;
  }
  /** The hash, once every byte has been given. */
  async digest() {
    if (this.tailLength) await this.closeBlock();
    return toHex(await sha256(join(this.blocks, this.blocks.length * 32)));
  }
}

/** The content hash of a whole file read through read(offset, length) -> Uint8Array. */
export async function contentHash(read, size, { onProgress, signal } = {}) {
  const h = new ContentHasher();
  for (let at = 0; at < size; at += CHUNK) {
    signal?.throwIfAborted();
    await h.update(await read(at, Math.min(CHUNK, size - at)));
    onProgress?.(Math.min(at + CHUNK, size), size);
  }
  return h.digest();
}

async function problem(res) {
  const text = await res.text().catch(() => "");
  let body = null;
  try { body = JSON.parse(text); } catch { /* Dropbox answers 400s in plain text */ }
  const summary = body?.error_summary || (body ? "" : text.slice(0, 200));
  if (res.status === 401) return new DropboxError("token", "Dropbox refused the app's access (revoked?); authorize it again with vvm.py dropbox-auth.", body?.error);
  if (res.status === 409) {
    const kind = /^reset/.test(summary) ? "reset" : /not_found/.test(summary) ? "missing" : "conflict";
    return new DropboxError(kind, `Dropbox: ${summary.replace(/\/\.*$/, "").replaceAll("/", ": ")}`, body?.error);
  }
  if (res.status === 429) return new DropboxError("other", "Dropbox is busy; try again in a minute.");
  return new DropboxError("other", `Dropbox said ${res.status}${summary ? `: ${summary}` : ""}.`, body?.error);
}
/** An upload session's own error, whether it came from append_v2 or (wrapped) from finish. */
const sessionError = (err) => {
  const d = err instanceof DropboxError ? err.detail : null;
  return d?.[".tag"] === "lookup_failed" ? d.lookup_failed : d;
};

export class Dropbox {
  constructor({ appKey, refreshToken, api = "https://api.dropboxapi.com", content = "https://content.dropboxapi.com" }) {
    Object.assign(this, { appKey, refreshToken, api, content });
    this.access = null;     // {token, expires}
    this.renewing = null;
  }

  /** An access token from the refresh token, kept until shortly before it expires. */
  async accessToken(renew = false) {
    if (!renew && this.access && Date.now() < this.access.expires) return this.access.token;
    this.renewing ??= (async () => {
      let res;
      try {
        res = await fetch(`${this.api}/oauth2/token`, { method: "POST", cache: "no-store",
          body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: this.refreshToken, client_id: this.appKey }) });
      } catch {
        throw new DropboxError("offline", "Can't reach Dropbox (offline?).");
      }
      if (res.status === 400 || res.status === 401) {
        throw new DropboxError("token", "Dropbox refused the app's access (revoked?); authorize it again with vvm.py dropbox-auth.");
      }
      if (!res.ok) throw await problem(res);
      const got = await res.json(), life = Number(got.expires_in) || 14400;
      this.access = { token: got.access_token, expires: Date.now() + (life - Math.min(300, life / 10)) * 1000 };
      return this.access.token;
    })().finally(() => { this.renewing = null; });
    return this.renewing;
  }

  /** One request with the access token (renewed and repeated once if it has expired). When
   *  Dropbox is busy (429, 5xx) or the connection drops, it is repeated after a pause, `tries`
   *  times in all. Failures become DropboxError, with Dropbox's error object as detail. */
  async call(url, { arg, json, body, range, tries = 3, signal } = {}) {
    let renewed = false;
    for (let attempt = 1; ; attempt++) {
      const headers = { Authorization: `Bearer ${await this.accessToken()}` };
      if (arg !== undefined) headers["Dropbox-API-Arg"] = headerJson(arg);
      if (json !== undefined) headers["Content-Type"] = "application/json";
      else if (body !== undefined) headers["Content-Type"] = "application/octet-stream";
      if (range) headers.Range = range;
      let res;
      try {
        res = await fetch(url, { method: "POST", headers, body: json !== undefined ? JSON.stringify(json) : body, signal, cache: "no-store" });
      } catch (err) {
        if (signal?.aborted) throw signal.reason ?? err;
        if (attempt < tries) { await sleep(backoff(attempt), signal); continue; }
        throw new DropboxError("offline", "Can't reach Dropbox (offline?).");
      }
      if (res.ok) return res;
      if (res.status === 401 && !renewed) {
        renewed = true;
        attempt--;
        await this.accessToken(true);
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < tries) {
        await sleep(Number(res.headers.get("Retry-After")) * 1000 || backoff(attempt), signal);
        continue;
      }
      throw await problem(res);
    }
  }
  async rpc(endpoint, args, opts) {
    return (await this.call(`${this.api}/2/${endpoint}`, { json: args, ...opts })).json();
  }
  async upCall(endpoint, arg, bytes, opts) {
    const text = await (await this.call(`${this.content}/2/${endpoint}`, { arg, body: bytes, tries: 6, ...opts })).text();
    return text ? JSON.parse(text) : null;
  }

  /** Every entry under path (by default the whole app folder), page by page: {entries, cursor}.
   *  The cursor then gives later changes (changes()). */
  async list(path = "", { recursive = true, limit = 2000 } = {}) {
    let page = await this.rpc("files/list_folder", { path, recursive, include_deleted: false, limit });
    const entries = [...page.entries];
    while (page.has_more) {
      page = await this.rpc("files/list_folder/continue", { cursor: page.cursor });
      entries.push(...page.entries);
    }
    return { entries, cursor: page.cursor };
  }
  /** What changed since a cursor: {entries, cursor}; removed files and folders come as
   *  {".tag": "deleted"}. A cursor Dropbox no longer accepts throws kind "reset": list again. */
  async changes(cursor) {
    const entries = [];
    let page;
    do {
      page = await this.rpc("files/list_folder/continue", { cursor });
      entries.push(...page.entries);
      cursor = page.cursor;
    } while (page.has_more);
    return { entries, cursor };
  }

  /** A URL that streams the file (with Range support) for about 4 hours: {link, expires}. */
  async temporaryLink(path) {
    const asked = Date.now();
    const got = await this.rpc("files/get_temporary_link", { path });
    return { link: got.link, metadata: got.metadata, expires: asked + LINK_MS };
  }

  /** Bytes start..end (inclusive) of a file. */
  async download(path, start, end, opts) {
    const res = await this.call(`${this.content}/2/files/download`, { arg: { path }, range: `bytes=${start}-${end}`, ...opts });
    const bytes = new Uint8Array(await res.arrayBuffer());
    return res.status === 200 && bytes.length > end - start + 1 ? bytes.slice(start, end + 1) : bytes;   // the range was ignored
  }

  async metadata(path) { return this.rpc("files/get_metadata", { path }); }

  /** Deletes a file (or folder): its metadata, or null if it was already gone. Dropbox keeps it
   *  among the deleted files on dropbox.com, where it can be restored. */
  async remove(path) {
    try {
      return (await this.rpc("files/delete_v2", { path })).metadata;
    } catch (err) {
      if (err.kind === "missing") return null;
      throw err;
    }
  }

  /**
   * Uploads source ({size, read(offset, length) -> Uint8Array}) to path in 8 MB chunks through an
   * upload session, computing Dropbox's content hash on the way. With saved ({get, put, delete},
   * by key), the session, the offset Dropbox has and the hashed blocks are kept after every
   * chunk: called again after an interruption, it continues where it stopped. mode "add" keeps
   * a different file already at path (the new one is renamed; an identical one is just
   * reported), "overwrite" replaces it. Returns {metadata, hash}, the hash checked against
   * Dropbox's. onProgress(bytes Dropbox has, size).
   */
  async upload(source, path, { key = null, saved = null, mode = "add", onProgress, signal } = {}) {
    const size = source.size, commit = { path, mode, autorename: mode === "add", mute: false, strict_conflict: false };
    let s = key && saved ? await saved.get(key) : null;
    if (!s?.sessionId || s.path !== path || s.size !== size) s = { path, size, sessionId: null, offset: 0, blocks: [] };
    let hasher = new ContentHasher(s.blocks);
    const keep = () => (key && saved ? saved.put(key, { ...s, blocks: hasher.state(), updated: Date.now() }) : null);
    const finished = async (metadata, hash) => {
      if (key && saved) await saved.delete(key);
      if (metadata.content_hash && metadata.content_hash !== hash) throw new DropboxError("other", "The upload arrived damaged; try again.");
      return { metadata, hash };
    };
    if (s.offset) onProgress?.(s.offset, size);
    for (;;) {
      signal?.throwIfAborted();
      if (!s.sessionId) { s.offset = 0; hasher = new ContentHasher(); }
      // Bytes Dropbox has that weren't hashed here (a resumed upload, or a reply that was lost):
      // hash them from the file. If Dropbox has fewer than were hashed, go back to its offset.
      if (hasher.position > s.offset) hasher = new ContentHasher(hasher.state().slice(0, Math.floor(s.offset / BLOCK)));
      while (hasher.position < s.offset) {
        const n = Math.min(CHUNK - (hasher.position % CHUNK), s.offset - hasher.position);
        await hasher.update(await source.read(hasher.position, n));
      }
      const n = Math.min(CHUNK, size - s.offset);
      const bytes = n ? await source.read(s.offset, n) : new Uint8Array(0);
      const cursor = { session_id: s.sessionId, offset: s.offset }, last = s.sessionId && s.offset + n === size;
      try {
        if (!s.sessionId) {
          s.sessionId = (await this.upCall("files/upload_session/start", { close: false }, bytes, { signal })).session_id;
        } else if (!last) {
          await this.upCall("files/upload_session/append_v2", { cursor, close: false }, bytes, { signal });
        } else {   // the last bytes and the commit in one call
          const metadata = await this.upCall("files/upload_session/finish", { cursor, commit }, bytes, { signal });
          await hasher.update(bytes);
          onProgress?.(size, size);
          return finished(metadata, await hasher.digest());
        }
      } catch (err) {
        const why = sessionError(err)?.[".tag"];
        if (why === "incorrect_offset") {
          s.offset = sessionError(err).correct_offset;
          await keep();
          continue;
        }
        if (why === "not_found" || why === "closed") {
          if (last) {   // the commit may have happened with its reply lost
            await hasher.update(bytes);
            const hash = await hasher.digest(), there = await this.metadata(path).catch(() => null);
            if (there?.content_hash === hash) return finished(there, hash);
          }
          s.sessionId = null;   // the session expired (they last a week): start again
          await keep();
          continue;
        }
        throw err;
      }
      await hasher.update(bytes);
      s.offset += n;
      await keep();
      onProgress?.(s.offset, size);
    }
  }
}
