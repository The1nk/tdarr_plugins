# Check Video Tool — Design

Date: 2026-10-29

## Problem

Detect Damaged Video only checks files as Tdarr processes them. Files already in the library were never
checked, and the earlier ad-hoc PowerShell checks had flaws: `ffmpeg -f null` reports false errors on
variable-rate MKVs, single-threaded decoding is slow, and their rules weren't the plugin's.

## Goal

A command-line tool, run on the Windows PC, that checks video files and folders with exactly the plugin's
rules and lists the damaged ones.

## Design

`tools/check-video.js`, run with Node:

```
node tools/check-video.js [--all] [-j N] [--ffprobe <path>] <file or folder>...
```

- **Shared rules.** It requires `../Tdarr_Plugin_the1nk_detect_damaged_video.js` and uses its `_test`
  helpers (`STD`, `pickVideo`, `parseTimes`, `findGaps`, `describeGaps`, `damagedMessage`, `countLines`,
  `firstErrors`, `tail`), so the gap rule, verdicts and messages match the plugin. The ffprobe arguments
  for the listing and the decode are the plugin's (`-v error … packet=pts_time`;
  `-v repeat+error -threads 0 … -count_frames`).
- **Per file:** one ffprobe call reads the streams (`stream=index,codec_type,r_frame_rate` and
  `stream_disposition=attached_pic`, JSON). Then:
  - no video stream (only cover art or none) → **skipped**;
  - standard rate → **clean** (unless `--all`, which checks the timing of standard-rate files too);
  - timestamps listed; fewer than 2 usable → **error**;
  - no gaps → **clean** (steady timing);
  - gaps, decode with 0 errors → **vfr** (deliberate variable frame rate);
  - gaps and decode errors → **damaged**, with the plugin's message and up to 5 first decoder errors;
  - any ffprobe failure → **error**, with the status and the trimmed output (`tail`).
- **Inputs:** files are checked whatever their extension; folders are walked recursively and only files
  with a library video extension are checked: `mkv mp4 mov m4v mpg mpeg avi flv webm wmv vob evo m2ts
  m2t mts ts` (case-insensitive). Paths that don't exist are reported as errors.
- **Concurrency:** `-j N` (default 2) files at once, using async `spawn` (each check reads the whole
  file, often over a network share).
- **Output:** one line per file as it finishes, `[i/n] VERDICT  path — detail`; then a summary with
  counts per verdict, and the damaged files (message and first decoder errors) and errors listed again.
- **Exit code:** 0 if nothing damaged and no errors; 1 if any file is damaged or errored; 2 for usage
  errors or when no video files were found.
- **ffprobe:** `--ffprobe <path>`, default `ffprobe` on PATH.

## Testing

- Unit tests `tests/check_video.test.js` (`node --test`), with the tool runner stubbed: every verdict,
  `--all`, ffprobe failures (not started, exit, signal), stream selection past cover art, folder walking
  with real temp folders (extension filter, case, nested folders, explicit files of any extension),
  argument parsing, summary text and exit codes, and that concurrency never exceeds `-j`.
- A real run on this PC: Dr. STONE S01E03 must be reported damaged with the same message as the plugin
  gave in the Tdarr node; a clean library episode must be reported clean.

## Documentation

README: a "Tools" section with usage, verdicts, options and exit codes; the Tests section lists the new
test file.
