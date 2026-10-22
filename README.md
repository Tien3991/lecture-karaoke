# Lecture Karaoke

A web app that plays a lecture video or audio recording with live karaoke subtitles from its
Soniox transcript: the words turn yellow as they are spoken, with the text just said and the text
coming next in gray. Nothing is rendered. Lectures come from your device or stream from your
Dropbox; transcripts come from your own private GitHub repository, which also shares word fixes
between your devices, and a GitHub Actions job there transcribes new lectures.

**Open it:** https://tien3991.github.io/lecture-karaoke/ (install it from the browser's menu, or on
iPhone/iPad with Share → Add to Home Screen, to watch full screen and offline).

## Use

1. Pick the lecture on this device: the original 16:9 MP4 video, or an audio recording (MP3, M4A,
   AAC, WAV, FLAC, Ogg, Opus). The pickers are at the top of the start screen; or tap a lecture in
   the Dropbox library further down. If its transcript is in your GitHub repository or was opened
   on this device before, it plays right away. Otherwise the app offers to get one (below), or pick its `.json`. On
   iPhone/iPad pick files with *Choose File* (the Files app).
2. Play. Tap any word, current or gray, to jump to it.

A recording shows its cover art where the video would be (from the file's ID3 tag, FLAC picture or
MP4 `covr`; Ogg and Opus pictures aren't read), or, without one, bars that move with the sound. On
iPhone and iPad the bars follow the transcript's words instead (the app doesn't route their audio
through Web Audio, where the silent switch or the background could mute it). The lock screen and
media controls show the lecture's name, its Dropbox folder and a recording's cover art.

The three most recent lectures are listed under the pickers with where you stopped. One streamed from Dropbox
streams again; for a file on the device a browser can't reopen it by itself, so tapping one opens
the file picker (its Recents has the video).

The control bar has two rows: by default the progress bar, **Soft**, **Exact**, notes, the lock and
full screen on top, and the other buttons below. ⋯ Settings → *Arrange the buttons* lets you move any button left or right or to
the other row, or hide it (tap a button, then move it); the arrangement is kept on the device. A
button added in a later release appears where the default bar has it.

| Control | |
|---|---|
| `‹` | back to the start screen |
| `−5s` / `+5s` | back / forward 5 seconds |
| `▶︎` | play / pause (tapping the video does too) |
| `−` `1×` `+` | playback speed, 0.2× to 4×: − and + change it by 0.05× (they stay in place, so they can be tapped again); tap the number to type a value or pick a preset. Each Dropbox folder keeps its own speed |
| `Exact` / `+3 s` | switch between exact timing and the offset set in ⋯ Settings (+ before the voice, to read ahead; − after it) |
| `Soft` | switch the highlight between full color and the soft setting in ⋯ Settings (lit while soft) |
| lock | lock the screen against touches while the lecture plays: nothing under it reacts, and the bar dims. A touch shows *Slide to unlock*: slide the lock all the way to the right and let go there (stopping short, or wandering off the track, leaves it locked). The keyboard still works; on the slider, → moves it a quarter at a time |
| `Fix` | tap a word to correct it (synced through GitHub when connected) |
| notes (page icon) | notes on the lecture, below |
| `⋯` | settings: links to the transcript, timing offset, sync fine-tune (±300 ms), layout, highlight, control bar, GitHub, language, the list of fixes, export |
| `⛶` | full screen, where the browser allows it (not iPhone) |
| handle between video and subtitles | drag to resize them; portrait and landscape are kept separately (double-click, or ⋯ Settings → Automatic, to reset) |
| keyboard | space play/pause, ←/→ 5 s, ↑/↓ preset speeds, `−`/`+` 0.05× slower/faster, `L` offset, `H` soft highlight, `E` fix, `N` notes, `F` full screen |

The app remembers, per transcript, where you stopped, the sync fine-tune, the language and your
fixes; speed, offset, layout and highlight are remembered on the device for every lecture. The
speed is kept per Dropbox folder: a lecture opens at the speed last chosen for its folder (a folder
without one, or a file not in Dropbox, at the speed chosen last anywhere).

**When a lecture ends.** When a lecture from Dropbox ends, a card offers five choices:
- *Back to the folder list*: the start screen, with the lecture's folder open;
- **Next video**: the next lecture in its folder (in the library's order; hidden files are passed over);
- *Keep playing the next videos*: the next one now, and after each lecture that ends, the one after
  it, 5 seconds later;
- *A random video in this folder*: a transcribed one when the folder has any;
- *Keep playing random videos in this folder*: a random one now and after each lecture that ends,
  none twice until all of the folder's have played.

"Keep playing" lasts until you go back to the folder list or close the app; *Stop*, beside the
countdown, ends it sooner. After a folder's last lecture the two next choices are greyed out.
Playing the lecture again closes the card.

**Notes.** The notes button (or `N`) opens a layer over the video and subtitles, which show through
it; the bar still works. Type a note in the box and press Enter (Shift+Enter starts a new line): it
goes to the top of the list under the box, and the earlier notes move down. A note keeps the moment
of the lecture where its typing began; tap its time to go there. Swipe a note left to delete it
(*Undo* in the message brings it back), or right to edit it in place: Enter keeps the change,
Escape doesn't, and a note emptied is deleted. With a keyboard, Tab to a note, then Delete or
Enter. Notes are text only, kept per lecture and on every device (`notes/<key>.json` in the
repository, synced like fixes; made offline, they wait). A lecture still waiting for its transcript
can't have notes yet.

⋯ Settings → *Highlight* sets the color of the words already spoken. There are six colors that
stand out on black (yellow, as in the burned videos, is the default), or pick any other color.
Below the colors are its two looks, each with a sample: *Full color*, and *Soft*, the color mixed
with the white of the words still to come. The slider sets how much color the soft look keeps,
from 20% to 90% (40% at first). A soft highlight still shows where the voice is, without drawing
the eye. The **Soft** button in the bar (or `H`) switches between the two looks, so the highlight
can stand out when you need it and stay quiet when you don't. A recording's bars take the same
color. **Export corrected
transcript** saves a corrected `.json` and a `transcript.txt` in the vertical_video_maker
correction format.

At the top of Settings, *Transcript* has a link to the lecture's transcript with your word fixes as
**Plain text** (`<name>.txt`, one sentence per line) and one as **JSON** (`<name>.json`, with the
word timings). On a phone or tablet a link opens the share sheet (*Save to Files*, *Copy*, other
apps); on a computer it downloads the file.

## Dropbox and transcription

Once GitHub is connected and the repository has `config/dropbox.json` (`{"app_key",
"refresh_token"}` of the *Lecture Karaoke* Dropbox app, which sees only its own folder,
Apps/Lecture Karaoke; approved once on the Mac with `vvm.py dropbox-auth`), the start screen lists,
under the recent lectures, the videos and recordings in that folder, a section
per course subfolder, with search and a badge each: *Ready*, *Transcribing*, *Not transcribed* or
*Failed*. A long name takes two lines. A file not played yet on any device is marked **New**
(`played.json` in the repository; a file counts as played once it starts playing, and each device
adds, the first time, the lectures it played before). Each folder's header has three
buttons: the crossed arrows play a random lecture from the folder (one with a transcript, when it
has any; while searching, one of those found); the arrow down saves the transcripts of the
lectures listed in one ZIP (each as `.txt`, a sentence per line, and `.json`, with word timings,
with the word fixes on GitHub and the device's, plus *All transcripts.txt* with all the text, a
`#` heading per lecture; on a phone **Save ZIP** opens the share sheet); and the pin keeps the
folder at the top of the list on every device (`pinned.json`); pinned folders come first, by name. A tap streams the file (a temporary link, renewed before
its 4 hours are up, or at once if it stops on an expired link, keeping the position). Files put in
Dropbox from any device are transcribed by the job, `.github/workflows/transcribe.yml` in the
repository: on its schedule, or right away with *Check now*.

The job transcribes speech as English unless a folder name says otherwise. A folder whose name
ends in `___` and a two-letter language code sets the language of everything in it, subfolders
too: `Giải tích 1___vn` (or `___vi`) is Vietnamese, `___fr` French. The nearest such folder
wins. New files are transcribed oldest first, and Dropbox counts a rename as a change, so a renamed
folder's files go to the back of the line. The app shows such a folder without its mark (search
ignores it too), and a lecture in a Vietnamese folder starts with Vietnamese line breaks (⋯ →
Language; a language chosen there stays with that transcript).

*Select* hides files from the list or deletes them from Dropbox: tap the files, then **Hide** or
**Delete**. A hidden file stays in Dropbox and leaves the list on every device (`hidden.json` in the
repository); *Undo* in the message puts it back. **Hidden (N)** in the header lists the hidden
files, where *Select* and **Unhide** show them again. **Delete** asks first. Dropbox keeps
deleted files for at least 30 days (restore them from *Deleted files* on dropbox.com). Their
transcripts stay in the repository, so a file put back finds its transcript again, and a deleted
file leaves the recent list too. A file still being transcribed can be deleted, but that
transcription may then fail.

A file picked on the device is looked up in Dropbox (same size, confirmed by Dropbox's content
hash, computed once per file and kept), and then:

- **It has a transcript:** it plays; if it isn't in Dropbox, the app offers *Upload to Dropbox*
  (also in ⋯ Settings) so other devices can stream it.
- **It is in Dropbox without a transcript:** *Transcribe* starts the job for it.
- **Neither:** *Upload to Dropbox* sends the video to a course folder (asked, *Uploads* at first),
  where the job transcribes it; *Transcribe only* copies just its audio track out of the MP4 (AAC
  frames in an ADTS stream, about 1 MB a minute, not re-encoded) to `/.staging/<fingerprint>.aac`,
  which the job transcribes and deletes; the video stays on the device. A recording is offered
  *Upload to Dropbox* only: it is its own audio.

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
| `key`, `name`, `size`, `fingerprint` | the file; `key` is the file name without extension, plus ` (` + `fingerprint[4:12]` + `)` when taken |
| `folder` | its course folder in Dropbox (`""` at the top level, and for audio-only entries) |
| `duration_ms`, `audio_start_ms`, `width`, `height` | from its MP4 index, so the app can stream it without reading the file; a recording has `width` and `height` 0, and one that isn't an MP4 `audio_start_ms` 0 and `duration_ms` `null` until the job (or a device playing it) has read it |
| `dropbox` | `{path, hash}`: where it is in Dropbox (relative to the app folder) and its content hash, or `null` |
| `staged`, `skip_ms` | `"/.staging/<fingerprint>.aac"` for audio-only transcription, and the ms at the start of that audio that the video doesn't play (the audio edit's media time: decoder priming) |
| `transcript` | `"transcripts/<key>.json"` once there |
| `status`, `error` | `ready`, `pending` or `failed` (with the reason) |
| `id`, `words`, `updated` | the Soniox transcription id, the word count, and when the entry changed |

## Transcripts on GitHub

Connect once per device (start screen → *Connect GitHub*, or ⋯ Settings): the repository
(`owner/name`) and a fine-grained token for that repository only, with *Contents: read and write*
(and *Actions: read and write* to start transcriptions). The token stays in that browser.

- `index.json` lists each lecture (fields above). It is read raw and written with the sha from the
  ETag, so it keeps working past the contents API's 1 MB limit. A file is recognised by its
  fingerprint, the same whatever the file is called, else by name after asking: for an MP4 (videos,
  and M4A/M4B recordings) `fp1-` + SHA-256 of its size and its MP4 index, the `moov` box (about
  1-3 MB to read); for other audio files, which have no such index, `fa1-` + Dropbox's content hash
  of the whole file (read once, and kept per file name, size and date).
- `transcripts/<key>.json` holds the transcript; vertical_video_maker publishes there (`vvm.py
  publish`, and automatically after transcribing), and so does the app for a transcript picked by
  hand.
- `fixes/<key>.json` holds word fixes made in the app, `{"fixes": [{start_ms, old, new}]}`. Each
  device sends its changes and merges them with what is there, so fixes from several devices are
  all kept; offline changes wait and sync later. The pipeline applies them when it renders.
- `notes/<key>.json` holds the notes on a lecture, `{"video", "notes": [{id, at_ms, text, created,
  updated, deleted?}]}` (`at_ms`: the moment of the video). Each change made on a device is the
  note's new state, merged with what is there: of two changes to one note the later wins, and a
  deleted note stays as a marker, so an older copy can't bring it back.
- `hidden.json` holds the files hidden from the library, `{"version": 1, "files": {<Dropbox content
  hash>: {name, path, hidden}}}`. Known by content, a file moved or renamed in Dropbox stays
  hidden. `played.json` is the same for the files played on any device (`played`: the first time),
  and `pinned.json` lists the pinned folders, `{"version": 1, "folders": {<folder in lower case>:
  {folder, pinned}}}`. The transcription job reads none of these.
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
  to a temporary folder), listing, links, deleting, resumed uploads, library matching, dispatch and
  an `index.json` past 1 MB; and `core/media.js`, telling files apart and finding cover art (ID3
  2.2-2.4, FLAC, WAV, MP4 `covr`), also in files made by ffmpeg. The audio copy is checked by decoding with ffmpeg (`FFMPEG`, `FFPROBE`;
  a lecture video in the parent folder, or `LECTURE12`); those tests are skipped without them, as
  are the MP4 reader and fingerprint checks when the fixtures' videos aren't at their paths.
- Releasing: change the version in `app.js`, `sw.js` and the `app-version` meta of `index.html`
  (`npm test` checks they match), then push. Installed apps show a "new version" banner; the page
  and its scripts always come from the same release's cache. Keep element ids that older releases'
  scripts look up, since they can briefly run against a newer page while updating.

Videos, recordings, transcripts and fixtures are never committed here (see `.gitignore`).
