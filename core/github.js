// The private transcripts repository through GitHub's contents API (it allows calls from web
// pages; a token is needed because the repository is private). Files are read and written whole.
// A write names the version it replaces (its sha), so a change made meanwhile elsewhere is
// noticed instead of overwritten.
//
// Repository layout (shared with vertical_video_maker):
//   index.json               {"videos": [{key, name, size, fingerprint, transcript, ...}]}
//                            (every field: core/library.js)
//   transcripts/<key>.json   app-ready Soniox transcript
//   fixes/<key>.json         {"fixes": [{start_ms, old, new}]}: word fixes made in the app
//   config/dropbox.json      {"app_key", "refresh_token"}: the Dropbox app folder (core/dropbox.js)
//   .github/workflows/transcribe.yml   the transcription job, started here by dispatch()

export class GitHubError extends Error {
  constructor(kind, message) { super(message); this.kind = kind; }   // kind: offline, token, access, missing, other
}

const enc = (path) => path.split("/").map(encodeURIComponent).join("/");

export function base64FromUtf8(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
export function utf8FromBase64(b64) {
  const bin = atob(b64.replace(/\s/g, ""));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

async function problem(res) {
  let msg = "";
  try { msg = (await res.json()).message || ""; } catch { /* not JSON */ }
  if (res.status === 401) return new GitHubError("token", "GitHub rejected the token (expired or mistyped?).");
  if (res.status === 403 && /rate limit/i.test(msg)) return new GitHubError("other", "GitHub's rate limit was reached; try again in a while.");
  if (res.status === 403) return new GitHubError("access", "The token isn't allowed to do this (it needs Contents: read and write on this repository).");
  if (res.status === 404) return new GitHubError("missing", "Repository not found, or the token can't see it.");
  return new GitHubError("other", `GitHub said ${res.status}${msg ? `: ${msg}` : ""}.`);
}

export class GitHub {
  constructor({ repo, token, api = "https://api.github.com" }) {
    Object.assign(this, { repo, token, api });
  }

  async call(path, { method = "GET", accept = "application/vnd.github+json", etag, body } = {}) {
    const headers = { Authorization: `Bearer ${this.token}`, Accept: accept, "X-GitHub-Api-Version": "2022-11-28" };
    if (etag) headers["If-None-Match"] = etag;
    if (body) headers["Content-Type"] = "application/json";
    try {
      return await fetch(`${this.api}/repos/${this.repo}${path}`,
        { method, headers, body: body && JSON.stringify(body), cache: "no-store" });
    } catch {
      throw new GitHubError("offline", "Can't reach GitHub (offline?).");
    }
  }

  /** The repository's details; fails if the token can't read it. */
  async repoInfo() {
    const res = await this.call("");
    if (!res.ok) throw await problem(res);
    return res.json();
  }

  /** A file's text (any size): {text, etag}, the cached copy when unchanged, or null if missing. */
  async readText(file, cached) {
    const res = await this.call(`/contents/${enc(file)}`, { accept: "application/vnd.github.raw+json", etag: cached?.etag });
    if (res.status === 304 && cached) return cached;
    if (res.status === 404) return null;
    if (!res.ok) throw await problem(res);
    return { text: await res.text(), etag: res.headers.get("ETag") };
  }

  /** A small JSON file (under 1 MB) with the sha needed to write it back: {data, sha} or null. */
  async readJson(file) {
    const res = await this.call(`/contents/${enc(file)}`);
    if (res.status === 404) return null;
    if (!res.ok) throw await problem(res);
    const meta = await res.json();
    return { data: JSON.parse(utf8FromBase64(meta.content)), sha: meta.sha };
  }

  /** Writes a file replacing version `sha` (none for a new file). Returns the new sha, or null
   *  when the file changed meanwhile (re-read it and try again). */
  async write(file, text, sha, message) {
    const res = await this.call(`/contents/${enc(file)}`,
      { method: "PUT", body: { message, content: base64FromUtf8(text), ...(sha ? { sha } : {}) } });
    if (res.status === 409 || res.status === 422) return null;
    if (!res.ok) throw await problem(res);
    return (await res.json()).content.sha;
  }

  /** A JSON file of any size with the sha needed to write it back: {data, sha} or null. It is
   *  read raw (the base64 contents stop at 1 MB, and index.json grows past that); for the raw
   *  media type GitHub's ETag is the file's blob sha, and if it ever isn't, the sha is computed. */
  async readForUpdate(file) {
    const res = await this.call(`/contents/${enc(file)}`, { accept: "application/vnd.github.raw+json" });
    if (res.status === 404) return null;
    if (!res.ok) throw await problem(res);
    const etag = res.headers.get("ETag") || "", bytes = new Uint8Array(await res.arrayBuffer());
    const sha = /^(?:W\/)?"([0-9a-f]{40})"$/.exec(etag)?.[1] ?? await blobSha(bytes);
    return { data: JSON.parse(new TextDecoder().decode(bytes)), sha };
  }

  /** Read-modify-write of a JSON file, retried when another device (or the transcription job)
   *  wrote meanwhile. change(data or null) returns the new data, or undefined to leave the file
   *  alone. */
  async update(file, change, message) {
    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 400 * attempt));
      const cur = await this.readForUpdate(file);
      const next = change(cur ? cur.data : null);
      if (next === undefined) return cur ? cur.data : null;
      if (await this.write(file, JSON.stringify(next, null, 1) + "\n", cur?.sha, message)) return next;
    }
    throw new GitHubError("other", `${file} kept changing on GitHub; try again.`);
  }

  /** Starts the transcription job (the repository's transcribe.yml) for one index entry, or with
   *  an empty item for everything waiting. The token needs Actions: read and write. */
  async dispatch(item = "", workflow = "transcribe.yml") {
    const res = await this.call(`/actions/workflows/${enc(workflow)}/dispatches`,
      { method: "POST", body: { ref: "main", inputs: { item } } });
    if (res.ok) return true;
    const err = await problem(res);
    if (err.kind === "access") err.message = "The token can't start the transcription job: it needs Actions: read and write on this repository.";
    if (err.kind === "missing") err.message = `The transcription job (.github/workflows/${workflow}) isn't in the repository, or the token can't see Actions.`;
    throw err;
  }
}

/** Git's blob sha of a file's bytes, the version a write must name. */
async function blobSha(bytes) {
  const head = new TextEncoder().encode(`blob ${bytes.length}\0`), buf = new Uint8Array(head.length + bytes.length);
  buf.set(head);
  buf.set(bytes, head.length);
  return [...new Uint8Array(await crypto.subtle.digest("SHA-1", buf))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
