# Lecture Karaoke

A web app that plays a lecture video with live karaoke subtitles from its Soniox transcript: the
words turn yellow as they are spoken, with the text just said and the text coming next in gray.
Nothing is rendered. Videos come from your device or stream from your Dropbox; transcripts come
from your own private GitHub repository, which also shares word fixes between your devices, and
a GitHub Actions job there transcribes new videos.

**Open it:** https://tien3991.github.io/lecture-karaoke/ (install it from the browser's menu, or on
iPhone/iPad with Share → Add to Home Screen, to watch full screen and offline).

## Use

1. Tap a video in the Dropbox library, or pick the lecture video on this device (the original
   16:9 file). If its transcript is in your GitHub repository or was opened on this device before,
   it plays right away. Otherwise the app offers to get one (below), or pick its `.json`. On
   iPhone/iPad pick files with *Choose File* (the Files app).
2. Play. Tap any word, current or gray, to jump to it.

Recent lectures are listed on the start screen with where you stopped. One streamed from Dropbox
streams again; for a file on the device a browser can't reopen it by itself, so tapping one opens
the file picker (its Recents has the video).

The control bar has two rows: by default the progress bar on top, and the buttons below. ⋯
Settings → *Arrange the buttons* lets you move any button left or right or to the other row, or
hide it (tap a button, then move it); the arrangement is kept on the device.

| Control | |
|---|---|
| `‹` | back to the start screen |
| `−5s` / `+5s` | back / forward 5 seconds |
| `▶︎` | play / pause (tapping the video does too) |
| `1×` | playback speed, 0.2× to 4×: type a value, pick a preset, or use the slider |
| `Exact` / `+3 s` | switch between exact timing and the offset set in ⋯ Settings (+ before the voice, to read ahead; − after it) |
| `Fix` | tap a word to correct it (synced through GitHub when connected) |
| `⋯` | settings: timing offset, sync fine-tune (±300 ms), layout, control bar, GitHub, language, the list of fixes, export |
| `⛶` | full screen, where the browser allows it (not iPhone) |
| handle between video and subtitles | drag to resize them; portrait and landscape are kept separately (double-click, or ⋯ Settings → Automatic, to reset) |
| keyboard | space play/pause, ←/→ 5 s, ↑/↓ preset speeds, `L` offset, `E` fix, `F` full screen |

The app remembers, per transcript, where you stopped, the sync fine-tune, the language and your
fixes; speed, offset and layout are remembered on the device for every lecture. **Export corrected
transcript** saves a corrected `.json` and a `transcript.txt` in the vertical_video_maker
correction format.

## Dropbox and transcription

Once GitHub is connected and the repository has `config/dropbox.json` (written by `vvm.py
dropbox-auth`: `{"app_key", "refresh_token"}` of the *Lecture Karaoke* Dropbox app, which sees only
its own folder, Apps/Lecture Karaoke), the start screen lists the videos in that folder, a section
per course subfolder, with search and a badge each: *Ready*, *Transcribing*, *Not transcribed* or
*Failed*. A tap streams the video (a temporary link, renewed before its 4 hours are up, or at once
if the video stops on an expired link, keeping the position). Videos put in Dropbox from any device
are transcribed by the job, `.github/workflows/transcribe.yml` in the repository: on its schedule,
or right away with *Check now*.

A video picked on the device is looked up in Dropbox (same size, confirmed by Dropbox's content
hash, computed once per video and kept), and then:

- **It has a transcript:** it plays; if it isn't in Dropbox, the app offers *Upload to Dropbox*
  (also in ⋯ Settings) so other devices can stream it.
- **It is in Dropbox without a transcript:** *Transcribe* starts the job for it.
- **Neither:** *Upload to Dropbox* sends the video to a course folder (asked, *Uploads* at first),
  where the job transcribes it; *Transcribe only* copies just its audio track out of the MP4 (AAC
  frames in an ADTS stream, about 1 MB a minute, not re-encoded) to `/.staging/<fingerprint>.aac`,
  which the job transcribes and deletes; the video stays on the device.

The video plays meanwhile; the app checks the index every 20 s and the subtitles appear when the
transcript is there. Uploads go in 8 MB pieces through a Dropbox upload session; one interrupted
(closed page, lost connection, *Stop*) continues where it stopped. The page asks before closing
while an upload runs.

Starting the job needs the token to have *Actions: read and write* too; without it the job's next
scheduled run picks the video up. The app adds an entry to `index.json` with `status: "pending"`
and starts the job with `POST …/actions/workflows/transcribe.yml/dispatches` (`{"ref": "main",
"inputs": {"item": "<key>"}}`; an empty item means check everything). Entries have these fields
(shared with vertical_video_maker; `core/library.js`):

| Field | |
|---|---|
| `key`, `name`, `size`, `fingerprint` | the video; `key` is the file name without extension, plus ` (` + `fingerprint[4:12]` + `)` when taken |
| `folder` | its course folder in Dropbox (`""` at the top level, and for audio-only entries) |
| `duration_ms`, `audio_start_ms`, `width`, `height` | from its MP4 index, so the app can stream it without reading the file |
| `dropbox` | `{path, hash}`: where it is in Dropbox (relative to the app folder) and its content hash, or `null` |
| `staged`, `skip_ms` | `"/.staging/<fingerprint>.aac"` for audio-only transcription, and the ms at the start of that audio that the video doesn't play (the audio edit's media time: decoder priming) |
| `transcript` | `"transcripts/<key>.json"` once there |
| `status`, `error` | `ready`, `pending` or `failed` (with the reason) |
| `id`, `words`, `updated` | the Soniox transcription id, the word count, and when the entry changed |

## Transcripts on GitHub

Connect once per device (start screen → *Connect GitHub*, or ⋯ Settings): the repository
(`owner/name`) and a fine-grained token for that repository only, with *Contents: read and write*
(and *Actions: read and write* to start transcriptions). The token stays in that browser.

- `index.json` lists each video (fields above). It is read raw and written with the sha from the
  ETag, so it keeps working past the contents API's 1 MB limit. A video is
  recognised by its fingerprint (SHA-256 of its size and its MP4 index, the `moov` box: about 1-3 MB
  to read, the same whatever the file is called), else by name after asking.
- `transcripts/<key>.json` holds the transcript; vertical_video_maker publishes there (`vvm.py
  publish`, and automatically after transcribing), and so does the app for a transcript picked by
  hand.
- `fixes/<key>.json` holds word fixes made in the app, `{"fixes": [{start_ms, old, new}]}`. Each
  device sends its changes and merges them with what is there, so fixes from several devices are
  all kept; offline changes wait and sync later. The pipeline applies them when it renders.
- Transcripts and the index are kept on the device too, so opened lectures work offline.

A transcript is either the transcript JSON from the Soniox API (`GET
/v1/transcriptions/{id}/transcript`: an object with `tokens`, each with `text`, `start_ms`,
`end_ms`) or the app-ready JSON that vertical_video_maker exports, with its corrections applied.

Subtitles follow the pipeline's rules: sentences split at natural breaks into pieces of up to four
lines, a piece shown from its first word until the next piece or 1.5 s after its last word, and up
to three gray lines before and after. On Apple devices the text is Avenir Next Bold, as in the
burned videos; elsewhere it is Nunito Sans Bold (SIL Open Font License, `fonts/OFL.txt`).

## Development

Plain HTML, CSS and ES modules; no build step.

- `node dev/serve.mjs [--port 8765] [--mock-github DIR] [--mock-dropbox DIR] VIDEO JSON ...` serves
  the app on 127.0.0.1 plus only the files you list (under `/media/`), with HTTP Range support. Open
  `http://127.0.0.1:8765/?video=/media/<name>&json=/media/<name>` (URL-encoded) to skip the pickers,
  or `?pick=/media/<name>` to act as if that video had been picked on the device.
  - `--mock-github DIR` stands in for GitHub (contents API, and workflow dispatches, which it
    records), serving DIR as the repository: open the app with `?api=/mock-github` and connect with
    the test token `test-token` (or `readonly-token`, which can't write or dispatch).
  - `--mock-dropbox DIR` stands in for Dropbox (token refresh, listing with cursors, temporary
    links, ranged downloads, upload sessions), serving DIR as the app folder: add `&dropbox=/mock-dropbox`,
    and put `{"app_key": "test-app-key", "refresh_token": "test-refresh-token"}` in the mock
    repository's `config/dropbox.json`.
  - Test controls: `POST /mock-github/__job {"item", "status", "transcript": "/media/<json>",
    "error"}` plays the job (writes the transcript and marks the entry ready, or failed);
    `GET /mock-github/__dispatches`; `POST /mock-dropbox/__expire {"links": true, "tokens": true}`,
    `__fault {"call", "mode", "count"}` (drop a call, or lose its reply), `__config {"linkTtl",
    "tokenTtl", "pageSize"}`, `GET /mock-dropbox/__stats`; `POST /mock-github/__offline?on=1` takes
    both offline.
  - `?poll=` and `?linkAge=` (seconds) shorten the 20 s index check and the link's renewal age.
- `npm test` checks the subtitle logic, video fingerprints and fix merging against fixtures from the
  pipeline (`dev/make_fixtures.py`; they contain transcripts, so they live outside this repository),
  and the Dropbox side against the mocks: content hashes (Dropbox's published example, downloaded
  to a temporary folder), listing, links, resumed uploads, library matching, dispatch and an
  `index.json` past 1 MB. The audio copy is checked by decoding with ffmpeg (`FFMPEG`, `FFPROBE`;
  a lecture video in the parent folder, or `LECTURE12`); those tests are skipped without them.
- Releasing: change the version in `app.js`, `sw.js` and the `app-version` meta of `index.html`
  (`npm test` checks they match), then push. Installed apps show a "new version" banner; the page
  and its scripts always come from the same release's cache. Keep element ids that older releases'
  scripts look up, since they can briefly run against a newer page while updating.

Videos, transcripts and fixtures are never committed here (see `.gitignore`).
