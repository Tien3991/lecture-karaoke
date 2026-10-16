#!/usr/bin/env python3
"""Dump test fixtures for the JavaScript port from the vertical_video_maker pipeline.

For every video it records the pipeline's words, every width the pipeline measured (words and
context-line variants), and the resulting subtitle events, so the JS layout can be checked for an
exact match. The fixtures contain transcripts, so they are written OUTSIDE this repository.

usage: python3 dev/make_fixtures.py [--project DIR] [--dest DIR]
"""
import argparse
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path.home() / ".claude/skills/vertical_video_maker/scripts"))
sys.argv = sys.argv[:1] + sys.argv[1:]
import vvm  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser()
    # Default: the folder that holds this repository, the videos and their pipeline outputs.
    here = pathlib.Path(__file__).resolve().parents[2]
    ap.add_argument("--project", default=str(here))
    ap.add_argument("--dest", default=str(here / "app_test_fixtures"))
    a = ap.parse_args()
    project, dest = pathlib.Path(a.project), pathlib.Path(a.dest)
    dest.mkdir(parents=True, exist_ok=True)
    index = []
    for video in sorted(project.glob("*.mp4")):
        out = project / "output" if video.stem.endswith("Lecture 1 - I") else project / "vertical" / video.stem
        ns = argparse.Namespace(video=str(video), out=str(out), key_file=None, context=None,
                                language=None, sync_offset_ms=None, fill=None)
        vvm.configure(ns)
        probe = vvm.probe_source(verbose=False)
        words, data, _, changes = vvm.load_words(lambda *x: None)
        groups, _ = vvm.merge_short(vvm.split_sentences(words))
        cal = vvm.calibrate("".join(sorted({ch for w in words for ch in w.text if ord(ch) > 127})))
        m = vvm.Measure(cal)
        pieces = []
        for gi, g in enumerate(groups):
            parts = vvm.split_group(g, m)
            pieces += [vvm.make_piece(p, m, gi, k, len(parts)) for k, p in enumerate(parts)]
        ctx_scale = round(cal["fontsize"] * vvm.CONTEXT_SCALE) / cal["fontsize"]
        flat, pos, context = [w for p in pieces for w in p.words], 0, []
        for p in pieces:
            start, pos = pos, pos + len(p.words)
            context.append((vvm.context_fill(flat, start, pos, "before", m, ctx_scale),
                            vvm.context_fill(flat, start, pos, "after", m, ctx_scale)))
        duration_ms = int(probe["duration"] * 1000)
        shift_ms = round((probe["audio_start"] - probe["start_time"]) * 1000)
        events = {}
        for version, lead in vvm.VERSIONS.items():
            evs, _, _ = vvm.build_events(pieces, lead, duration_ms, shift_ms)
            for e in evs:
                e["prev_lines"], e["next_lines"] = context[e["piece"]]
            events[version] = evs
        on_disk = json.loads(vvm.events_path("exact").read_text())
        if on_disk != events["exact"]:
            sys.exit(f"recomputed events differ from the rendered ones: {video.stem}")
        fixture = {
            "video": str(video), "raw_json": str(vvm.RAW_JSON),
            "app_json": str(project / "app_transcripts" / f"{video.stem}.json"),
            "words_tsv": str(vvm.WORDS_TSV), "corrected": bool(changes),
            "words": [[w.text, w.start, w.end] for w in words],
            "duration_ms": duration_ms, "shift_ms": shift_ms,
            "audio_start": probe["audio_start"], "file_start": probe["start_time"],
            "video_start": probe["video_start"], "width": probe["width"], "height": probe["height"],
            "fit_w": vvm.FIT_W, "space": m.space, "ctx_scale": ctx_scale, "font": cal["font"],
            "widths": m.cache, "events": events,
        }
        (dest / f"{video.stem}.json").write_text(json.dumps(fixture, ensure_ascii=False))
        index.append(video.stem)
        print(f"{video.stem}: {len(words)} words, {len(pieces)} pieces, {len(m.cache)} widths")
    (dest / "index.json").write_text(json.dumps(index, indent=1, ensure_ascii=False))


if __name__ == "__main__":
    main()
