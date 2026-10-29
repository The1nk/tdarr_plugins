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
node tools/check-video.js [--all] [-j N] [--timeout MIN] [--ffprobe <path>] <file or folder>...
```

- **Shared rules.** It requires `../Tdarr_Plugin_the1nk_detect_damaged_video.js` and uses its `_test`
  helpers (`STD`, `pickVideo`, `parseTimes`, `findGaps`, `describeGaps`, `damagedMessage`, `countLines`,
  `firstErrors`, `tail`), so the gap rule, the verdicts, and the damaged and error texts match the plugin.
  The wording of the clean and VFR details is the tool's own. The ffprobe arguments
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
  m2t mts ts` (case-insensitive). Every path is made absolute with `path.resolve`. A file reached more than
  once (given twice, with different slashes or case on Windows, or given and also inside a given folder) is
  checked once, under its first spelling. Files are de-duplicated by real path (`fs.realpathSync.native`, one system call per file, lower-cased on
  Windows; the walk's visited-folder set uses it too), so a file and a link to it are checked once. The walk follows symbolic links and junctions (a link is
  `stat`ed and treated as a folder or file by its target) and remembers the real path of every folder it
  has walked, so links that loop or overlap are not walked twice. A folder that can't be read, or a link
  to a video that can't be followed, is reported as an error. Paths that don't exist are listed under
  Errors, but are not counted as files or as errors in the summary.
- **ffprobe check:** before anything else (after the usage checks) it runs `<ffprobe> -version`. If that
  fails it prints `ffprobe is not usable (not started|signal X|exit N|timed out after 1 min): …` (one
  line) to stderr and exits 2, instead of reporting every file as an error.
- **Concurrency:** `-j N` (default 2) files at once, using async `spawn` (each check reads the whole
  file, often over a network share).
- **Timeout:** `--timeout MIN` (default 120, 0 = never; a whole number from 0 to 35791, because
  `setTimeout` fires at once beyond 2^31-1 ms; `runTool` also treats any larger `timeoutMs` as no timer) kills one ffprobe call that runs
  longer; the file is reported as an error `(timed out after N min)` and the scan goes on.
- **Output cap:** each of an ffprobe call's output streams is capped at 256 MB (the plugin's
  `maxBuffer`). Beyond that the call is killed and the file is an error `(output cap): ffprobe output exceeded 256 MB`.
- **Output:** `Found N file(s) to check.` after the folders are walked (explicitly named files of any extension are counted too); then one line per file as it
  finishes, `[i/n] LABEL   path<TAB>detail` (label padded to 7; a tab, not " - ", separates path and
  detail because library names contain " - "); then a summary
  `Checked N file(s): C clean, V deliberate VFR, D damaged, E error(s), S skipped.`, with
  ` M path(s) not found.` appended when M > 0; then the damaged files (message and first decoder errors)
  and the errors (including not-found paths) listed again. Error details are always a single line: the
  tool's `oneLine` splits on line breaks, trims, drops empty lines and joins with ` | `.
- **Exit code:** 0 if nothing is damaged and there are no errors; 1 if any file is damaged; 3 if there
  were errors (including paths not found) but nothing is damaged; 2 for usage errors, when no video
  files were found, or when ffprobe is unusable; 130 after Ctrl+C.
- **Ctrl+C:** on SIGINT during the checks it kills the ffprobe processes still running, prints
  `Interrupted.` and the summary of the results so far (same format), then exits 130. In a console
  Ctrl+C also reaches ffprobe, which on Windows exits with status 3221225786 (`STATUS_CONTROL_C_EXIT`),
  and on POSIX it ends with SIGINT: such a call is treated as an interrupt, not as an error. Its file is
  not recorded or printed, no new file is started, and if node's own SIGINT handler has not run yet the same interrupt routine runs
  at once (it kills the other workers' ffprobes, prints the summary, exits 130; it runs only once). The
  SIGINT listener is removed in a `finally`.
- **Robustness:** if stdout is closed early (EPIPE, e.g. piped into `head`) it exits quietly with code 0 (so the exit code means nothing then); an
  unexpected exception prints its message to stderr and exits 2.
- **ffprobe:** `--ffprobe <path>`, default `ffprobe` on PATH; a value starting with `-` is rejected
  (`--ffprobe needs a path`).

## Testing

- Unit tests `tests/check_video.test.js` (`node --test`), with the tool runner stubbed: every verdict,
  `--all`, ffprobe failures (not started, exit, signal), stream selection past cover art, folder walking
  with real temp folders (extension filter, case, nested folders, explicit files of any extension),
  argument parsing (including `--timeout`), summary text (singular and plural) and exit codes, `oneLine`,
  path normalisation and de-duplication, links and loops (real temp folders and junctions), a folder that
  can't be read, a runner that throws, the ffprobe check, timeouts and the output cap (real child
  processes), the output-cap and Ctrl+C-status error texts, links to files, Ctrl+C (including a call that
  ends with Ctrl+C's exit status, and killing the tracked children), and that concurrency never exceeds `-j`.
- A real run on this PC: Dr. STONE S01E03 must be reported damaged with the same message as the plugin
  gave in the Tdarr node; a clean library episode must be reported clean.

## Documentation

README: a "Tools" section with usage, verdicts, options and exit codes; the Tests section lists the new
test file.
