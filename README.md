# Lecture Karaoke

A web app that plays a lecture video with live karaoke subtitles from its Soniox transcript: the
words turn yellow as they are spoken, with the text just said and the text coming next in gray.
Nothing is rendered, and videos never leave your device. Transcripts can come from your own
private GitHub repository, which also shares word fixes between your devices.

**Open it:** https://tien3991.github.io/lecture-karaoke/ (install it from the browser's menu, or on
iPhone/iPad with Share → Add to Home Screen, to watch full screen and offline).

## Use

1. Pick the lecture video (the original 16:9 file). If its transcript is in your GitHub repository
   or was opened on this device before, it plays right away; otherwise pick its `.json` too. On
   iPhone/iPad pick files with *Choose File* (the Files app).
2. Play. Tap any word, current or gray, to jump to it.

Recent lectures are listed on the start screen with where you stopped. A browser can't reopen a
file by itself, so tapping one opens the file picker (its Recents has the video).

| Control | |
|---|---|
| two-finger tap / swipe | play/pause / back or forward 10 s (on the video and the subtitles) |
| `1×` | playback speed, 0.2× to 4×: type a value, pick a preset, or use the slider |
| `Exact` / `+3 s` | switch between exact timing and the offset set in ⋯ Settings (+ before the voice, to read ahead; − after it) |
| handle between video and subtitles | drag to resize them; portrait and landscape are kept separately (double-click, or ⋯ Settings → Automatic, to reset) |
| `Fix` | tap a word to correct it (synced through GitHub when connected) |
| `⋯` | settings: timing offset, sync fine-tune (±300 ms), layout, GitHub, language, the list of fixes, export |
| keyboard | space play/pause, ←/→ 5 s, ↑/↓ preset speeds, `L` offset, `E` fix, `F` full screen |

The app remembers, per transcript, where you stopped, the sync fine-tune, the language and your
fixes; speed, offset and layout are remembered on the device for every lecture. **Export corrected
transcript** saves a corrected `.json` and a `transcript.txt` in the vertical_video_maker
correction format.

## Transcripts on GitHub

Connect once per device (start screen → *Connect GitHub*, or ⋯ Settings): the repository
(`owner/name`) and a fine-grained token for that repository only, with *Contents: read and write*.
The token stays in that browser.

- `index.json` lists each video: name, size, fingerprint and its transcript file. A video is
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

- `node dev/serve.mjs [--port 8765] [--mock-github DIR] VIDEO JSON ...` serves the app on 127.0.0.1
  plus only the files you list (under `/media/`), with HTTP Range support. Open
  `http://127.0.0.1:8765/?video=/media/<name>&json=/media/<name>` (URL-encoded) to skip the pickers.
  With `--mock-github DIR` it also stands in for GitHub's contents API, serving DIR as the
  repository: open the app with `?api=/mock-github` and connect with the test token `test-token`
  (or `readonly-token`); `POST /mock-github/__offline?on=1` simulates going offline.
- `npm test` checks the subtitle logic, video fingerprints and fix merging against fixtures from the
  pipeline (`dev/make_fixtures.py`; they contain transcripts, so they live outside this repository).
- Releasing: change the version in `app.js`, `sw.js` and the `app-version` meta of `index.html`
  (`npm test` checks they match), then push. Installed apps show a "new version" banner; the page
  and its scripts always come from the same release's cache. Keep element ids that older releases'
  scripts look up, since they can briefly run against a newer page while updating.

Videos, transcripts and fixtures are never committed here (see `.gitignore`).
