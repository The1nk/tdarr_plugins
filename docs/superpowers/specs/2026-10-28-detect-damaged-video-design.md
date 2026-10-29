# Detect Damaged Video — Design

Date: 2026-10-28

## Problem

Some downloads arrive with frames cut out of the video stream. The Space King season 1 MP4s are the
example: every episode has 2–5 s holes in its video timestamps (the player freezes on the last frame),
a frame rate that only makes sense as 24 fps with holes in it (`7016/301` = 23.309 fps), and hundreds
to thousands of H.264 decode errors ("Missing reference picture"), because the frames that later
frames reference are gone.

Today these files go through the flows silently. `Tdarr_Plugin_the1nk_repair_framerate` sees the odd
rate, decides it is not a near-miss, logs that, and skips. The damaged file then replaces the original
and nobody is told.

There is a second, quieter risk. A file with only a few dropped frames can average out *inside* the
near-miss window (e.g. 24 fps missing 1 frame in 600 ≈ 23.96 fps). Repair Frame Rate would then force
every frame onto an even 24 fps grid. That closes the holes by sliding video earlier, so it drifts
out of sync with the audio, and the current verification (duration within 1 s, same packet count)
does not catch it.

## Goals

- A damaged file fails its Tdarr job with a clear message saying what is wrong and where, before any
  work is done on it. The original is left untouched.
- Files that are variable-frame-rate *on purpose* (a still scene stored as one frame held for
  several seconds, common in fansub anime) are not flagged.
- Repair Frame Rate never "repairs" a file whose timing has gaps.
- Repair Frame Rate's existing behaviour on near-miss files with steady timing is unchanged.

## Non-goals

- Fixing damaged files. The missing frames cannot be recovered; the source has to be replaced.
- Catching damage cut cleanly at keyframe boundaries (no decode errors). Timestamps alone cannot tell
  that apart from deliberate VFR.
- Checking files whose frame rate is already standard.

## How damage is recognised

Two signals, both required:

1. **Timing gaps.** List the video stream's packet timestamps (`pts_time`) with ffprobe, drop
   packets without one, sort ascending (B-frames arrive out of display order). The *normal interval*
   is the most common interval between neighbours, rounded to the millisecond. A *gap* is any interval
   of at least **1.5×** the normal interval. 1.5× rather than 2× because millisecond timebases make a
   24 fps file alternate 41/42 ms, so one missing frame shows as 83 ms, only 1.98× the 42 ms mode.
   For each gap record its start (relative to the first packet, so it matches the player clock), its
   length, and its *excess* (length minus the normal interval). Total missing time = sum of excesses.
2. **Decode errors.** Decode the same video stream once with ffprobe:
   `ffprobe -v repeat+error -threads 0 -select_streams <index> -count_frames -show_entries stream=nb_read_frames -of csv=p=0 -- <file>`.
   Every non-empty stderr line counts as one error (`repeat+` keeps ffmpeg from folding repeats into "Last message repeated N times"). `-threads 0` decodes on all cores: measured in the Tdarr node, 3 runs each at `-threads 1` and `-threads 0` gave the same counts (0 errors for the variable-rate file, 3 for the damaged one), while single-threaded ffprobe took 334 s on a 24-minute 1080p episode and threading cut a 180 s window from 45 s to 16 s. A deliberately held frame decodes cleanly; frames
   cut from the bitstream do not. Not `ffmpeg … -f null -`: its null muxer prints "non monotonically
   increasing dts" for every few frames of a variable-rate MKV (58 lines on a clean test file), which
   would flag good files. ffprobe has no muxer, exits 0 on decode errors, and printed 0 lines for the
   clean variable-rate file and 3 decoder errors for the damaged one (measured in the Tdarr node).

| Gaps | Decode errors | Verdict |
|------|---------------|---------|
| none | (not run) | fine |
| ≥ 1 | 0 | deliberate VFR — fine for the detector, but Repair Frame Rate must not touch it |
| ≥ 1 | ≥ 1 | **damaged** |

The decode only runs when gaps were found, so normal files cost one timestamp listing (which reads, but does not decode, the whole file), and only if
their rate is non-standard. The decode reads and decodes the whole file, which can take several minutes on long or 4K files.

## Components

### 1. New plugin: `Tdarr_Plugin_the1nk_detect_damaged_video.js` (v1.00)

- `Stage: 'Pre-processing'`, `Type: 'Video'`, `Operation: 'Transcode'` (it sits in a "Run Classic
  Transcode Plugin" node like the rest of the flow; it never sets `processFile`), no inputs,
  `// tdarrSkipTest` (runs external tools).
- Works on any container (ffprobe and ffmpeg read them all).
- Steps:
  1. Pick the video stream: first `codec_type === 'video'` that is not `attached_pic`. None → log,
     continue.
  2. `r_frame_rate` is one of the standard rates (same list as Repair Frame Rate:
     `24000/1001, 24/1, 25/1, 30000/1001, 30/1, 50/1, 60000/1001, 60/1, 24000/1000`) → log, continue.
  3. Timestamp listing → gaps. No gaps → log "timing is steady", continue.
  4. Decode → error count. Zero → log that the gaps decode cleanly (deliberate VFR), continue.
  5. Otherwise set `response.error`, which fails the job (Tdarr's classic-plugin runner throws
     `Plugin … failed: <error>`; Convert Unsupported Subtitles does the same). The message also goes
     to the info log, followed by `First decoder errors:` and up to 5 stderr lines, each on its own line
     indented by two spaces, with the `[h264 @ 0x55d1ffc77a00] ` context rewritten to `h264: ` and each
     line cut to 200 characters. The error also carries the first line:
     `Damaged video: 7 timing gaps (largest 4.17s at 04:00), about 8.7s of video missing, and 202 decode errors. The source is missing frames; replace it with a clean copy. First error: h264: reference picture missing during reorder`
     Position format `mm:ss`, or `h:mm:ss` from one hour. Missing time has one decimal, or two below
     1 s (`about 0.04s`).
- Tools: only ffprobe, found the same way as Convert Unsupported Subtitles (bundled ffprobe, then one
  next to an absolute `ffmpegPath`, then PATH).
- If ffprobe cannot run or exits non-zero, the job **fails** with `Detect damaged video: <reason>`.
  The check is only reached for non-standard-rate files, and passing them unchecked would defeat it.
- The gap analysis and verdict are pure functions, exported as `module.exports._test` like Convert
  Unsupported Subtitles.

### 2. Change: `Tdarr_Plugin_the1nk_repair_framerate.js` (v1.01 → v1.02)

- The `cacheFilePath` check (the plugin only works in a flow) comes before any probing. After deciding a
  file is a near-miss and before running mkvmerge, list the video timestamps and run
  the same gap analysis. The verification gate probes the same video stream as the gap check, not `v:0`. Any gap → log
  `Near-miss rate 23185/967, but found 1 timing gap (largest 0.08s at 00:02), about 0.04s of video missing. Forcing a constant rate would desync audio. Skipping.`
  and return without repairing. No gaps → repair exactly as today.
- No decode here; any gap is enough to make the repair unsafe, deliberate or not.
- The gap-analysis function is duplicated from the new plugin, because every plugin file must stand
  alone (`push.ps1` copies single `.js` files and plugins only `require('../methods/lib')`). Unit
  tests run both copies against the same cases so they cannot drift.
- An ffprobe failure here goes through the existing `catch`: logged, original untouched, flow
  continues (unchanged behaviour for tool failures in this plugin).
- Description and README updated; `_test` exports added.

### 3. Flows

In all five `flow*.json` files and their gitignored `flow*.local.json` copies, add a "Run Classic
Transcode Plugin: Tdarr_Plugin_the1nk_detect_damaged_video" node between Processed Tag Filter and
Convert Unsupported Subtitles, the same way Convert Unsupported Subtitles was added in `60f274a`
(new node, edges re-pointed, later nodes shifted down 100 px). Both outputs lead to Convert
Unsupported Subtitles.

It goes first because a later H265 CPU Transcode re-encode would keep the gaps but produce a clean
stream, hiding the decode errors, and failing early wastes no work.

## Error handling summary

| Situation | Detect Damaged Video | Repair Frame Rate |
|-----------|---------------------|-------------------|
| Standard rate | continue | skip (unchanged) |
| Non-standard, steady timing | continue | near-miss → repair; far-off → skip (unchanged) |
| Gaps, clean decode | continue (logged as deliberate VFR) | skip with gap message |
| Gaps + decode errors | **fail job** | (not reached in the flows) |
| Fewer than 2 usable timestamps | **fail job** | skip (timing can't be checked) |
| Tool missing / fails | **fail job** | log, original untouched (unchanged) |

## Testing

- **Unit tests** (`node --test tests/*.test.js`, stubbed `../methods/lib` and `child_process` as in
  `tests/convert_unsupported_subs.test.js`):
  - `tests/detect_damaged_video.test.js`: gap analysis (steady 24 fps with 41/42 ms jitter → no gaps;
    a single dropped frame → 1 gap; the E02 pattern → 7 gaps, largest 4.17 s at 04:00; unsorted
    input; packets without `pts_time`; fewer than 2 packets), position formatting, the verdict table,
    exact error text, tool-failure paths, standard-rate and no-video short-circuits, decode not run
    when there are no gaps.
  - `tests/repair_framerate.test.js`: the gap guard (gappy near-miss → skip, no mkvmerge call;
    steady near-miss → mkvmerge runs), and the shared gap cases run against both plugins' copies.
- **Integration test** `tests/container/detect_damaged_video.itest.js`, run inside the `tdarr-node`
  container like the existing one, with real Tdarr `methods/lib`, ffmpeg, ffprobe and mkvtoolnix. It
  builds its own fixtures under `/tmp/itest` with `tdarr-ffmpeg`, so it needs no media. x264 runs
  with `-threads 1`, which only pins the encoded bytes as a precaution; Detect decodes with `-threads 0`
  and the error counts do not depend on threading (see above). The expected gap and error values were measured on ffmpeg 7.1.4-Jellyfin and
  need re-measuring if Tdarr's ffmpeg changes; the test logs the ffmpeg version line at the start. The gappy
  files go through MP4 first, which gives them an odd frame rate (`72/5`) like the real downloads:
  - *clean*: 10 s of `testsrc2` at 24 fps, H.264 → `24/1` → detector skips (standard rate).
  - *steady*: `testsrc2` at `72/5` → odd rate, no gaps → detector continues.
  - *deliberate VFR*: frames 120–215 removed by the `select` filter before encoding
    (`-fps_mode passthrough`) → one 4.04 s gap, clean decode → detector continues and logs VFR;
    Repair Frame Rate run on it with `max_delta_fps: 10` (so `72/5` counts as a near-miss of
    `24000/1001`) → skips with the gap message and writes no output.
  - *near-miss (positive control)*: `testsrc2` at `24000/1001` relabelled by
    `mkvmerge --default-duration 0:23185/967p` → `r_frame_rate` `23185/967`, no gaps → detector
    continues ("steady"); Repair Frame Rate with `max_delta_fps: 0.05` really repairs it with the real
    mkvmerge: no error, `Near-miss frame rate 23185/967` and `Verified:` in the log, output file with
    `r_frame_rate` `24000/1001`.
  - *damaged*: the clean encode (`-g 240`) stream-copied through the `noise` bitstream filter
    dropping packets 120–215 → 2 gaps (largest 4.00 s at 00:05), 3 decode errors → detector fails
    with the exact damaged message plus ` First error: h264: reference picture missing during reorder`.
  - Optional argument: a real file under `/media`; if given, it must be reported as damaged (useful
    for the current Space King E02 until it is replaced).
- The test cleans its work files on success and keeps them (printing `FAILED. Work files kept for
  inspection in …`, exit 1) on failure, like the existing integration test.
- README "Tests" section gains the stage/run/clean-up commands for the new integration test.

## Documentation

README: flow diagram gets the new node; a new ordering rule ("Detect Damaged Video goes first…");
a plugin section for Detect Damaged Video (what it checks, the verdict table, the error message, that
the source must be replaced); Repair Frame Rate's section gets the gap guard and v1.02.
