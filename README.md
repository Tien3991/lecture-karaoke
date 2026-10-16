# Lecture Karaoke

A web app that plays a lecture video with live karaoke subtitles from its Soniox transcript: the
words turn yellow as they are spoken, with the text just said and the text coming next in gray.
Nothing is rendered or uploaded: the video and transcript stay on your device.

**Open it:** https://tien3991.github.io/lecture-karaoke/ (install it from the browser's menu, or on
iPhone/iPad with Share → Add to Home Screen, to watch full screen and offline).

## Use

1. Pick the lecture video (the original 16:9 file) and its transcript `.json`, or drop both on the
   page. On iPhone/iPad pick them with *Choose File* (the Files app).
2. Play. Tap any word, current or gray, to jump to it.

| Control | |
|---|---|
| `1×` | playback speed, 0.5× to 2× (remembered) |
| `Exact` / `3 s ahead` | show subtitles with the voice, or ahead of it (any lead in ⋯ Settings) |
| `Fix` | tap a word to correct it; fixes are kept on the device |
| `⋯` | settings: lead, sync fine-tune (±300 ms), language, the list of fixes, export |
| keyboard | space play/pause, ←/→ 5 s, ↑/↓ speed, `L` lead, `E` fix, `F` full screen |

The app remembers, per transcript, where you stopped, your settings and your fixes. **Export
corrected transcript** saves a corrected `.json` (open it here next time) and a `transcript.txt` in
the vertical_video_maker correction format.

## Transcripts

Either the transcript JSON from the Soniox API (`GET /v1/transcriptions/{id}/transcript`: an object
with `tokens`, each with `text`, `start_ms`, `end_ms`), or the app-ready JSON that the
vertical_video_maker pipeline exports (`vvm.py export-json`), which has its corrections applied.

Subtitles follow the pipeline's rules: sentences split at natural breaks into pieces of up to four
lines, a piece shown from its first word until the next piece or 1.5 s after its last word, and up
to three gray lines before and after. On Apple devices the text is Avenir Next Bold, as in the
burned videos; elsewhere it is Nunito Sans Bold (SIL Open Font License, `fonts/OFL.txt`).

## Development

Plain HTML, CSS and ES modules; no build step.

- `node dev/serve.mjs [--port 8765] VIDEO JSON ...` serves the app on 127.0.0.1 plus only the
  files you list (under `/media/`), with HTTP Range support. Open
  `http://127.0.0.1:8765/?video=/media/<name>&json=/media/<name>` (URL-encoded) to skip the pickers.
- `npm test` checks the subtitle logic against fixtures from the pipeline
  (`dev/make_fixtures.py`; they contain transcripts, so they live outside this repository).
- Releasing: change `VERSION` in both `app.js` and `sw.js`, then push. Installed apps show a
  "new version" banner.

Videos, transcripts and fixtures are never committed (see `.gitignore`).
