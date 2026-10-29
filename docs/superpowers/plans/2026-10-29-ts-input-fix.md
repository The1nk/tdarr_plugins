# MPEG-TS Input Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `.ts` inputs get remuxed to MKV and keep their real extension, so the whole flow processes them.

**Architecture:** Two small plugin fixes (Migz Remux's video check, Add Suffix's extension), each with unit tests. The seven already-processed files are converted afterwards by the controller (see the spec), not by this plan's tasks.

**Tech Stack:** Node.js, `node:test`. **Spec:** `docs/superpowers/specs/2026-10-29-ts-input-fix-design.md`.

---

## Background

- Branch `ts-input-fix` (already created from `main`). Commit at the end of each task; never push. Commit messages end with a blank line, then `Claude-Session: https://claude.ai/code/session_016ziVwwvkMXfjNotbAoqpyw`.
- Never redirect to `/dev/null`. Tests: `node --test tests/*.test.js`.
- Test style: see `tests/repair_framerate.test.js` (a `Module._load` hook stubs `'../methods/lib'` as `() => ({ loadDefaultValues: (inputs) => inputs || {} })`, and swaps in fake `fs` / `child_process` through `stubs`). The stub doesn't apply defaults, so pass every input explicitly.

### Task 1: Migz Remux trusts a real video stream

**Files:** Modify `Tdarr_Plugin_MC93_Migz1Remux.js`; create `tests/migz_remux.test.js`; modify `README.md` ("Local copies of community plugins").

- [ ] **Step 1: Failing tests** in `tests/migz_remux.test.js`, calling `plugin(file, {}, { container: 'mkv', force_conform: true }, {})`:
  - `{ container: 'ts', fileMedium: 'audio', ffProbeData: { streams: [{ codec_type: 'video', codec_name: 'h264', disposition: { attached_pic: 0 } }, { codec_type: 'audio', codec_name: 'aac' }] } }` → `processFile` true, `preset` exactly `'-fflags +genpts, -map 0 -c copy -max_muxing_queue_size 9999 -map -0:d '`, `container` `'.mkv'`, infoLog contains `'☒File is ts but requested to be mkv container. Remuxing.'`.
  - `{ container: 'mp3', fileMedium: 'audio', streams: [audio mp3, video mjpeg with disposition.attached_pic 1] }` → `processFile` false, infoLog `'☒File is not a video. \n'`.
  - audio-only `{ container: 'm4a', fileMedium: 'audio', streams: [audio aac] }` → not a video.
  - `{ container: 'mkv', fileMedium: 'video', streams: [video h264] }` → `processFile` false, infoLog contains `'☑File is already in mkv container.'`.
  - `{ container: 'mp4', fileMedium: 'video', streams: [video h264, audio aac] }` → `processFile` true, preset `', -map 0 -c copy -max_muxing_queue_size 9999 -map -0:d '` (no genpts).
  - `ffProbeData` missing with `fileMedium: 'audio'` → not a video (no crash).
- [ ] **Step 2:** run, see the `.ts` case fail with "not a video".
- [ ] **Step 3: Implement.** Replace the video check:

```js
  // Check if file is a video. If it isn't then exit plugin.
  // the1nk: Tdarr labels a file "audio" when its video stream's average frame rate reads 0/0 (seen on some
  // MPEG-TS captures), so also trust a real (non-cover-art) video stream in ffprobe's data.
  const probeStreams = (file.ffProbeData && file.ffProbeData.streams) || [];
  const realVideoStream = probeStreams.find((s) => s.codec_type === 'video'
    && !(s.disposition && s.disposition.attached_pic));
  if (file.fileMedium !== 'video' && !realVideoStream) {
    response.processFile = false;
    response.infoLog += '☒File is not a video. \n';
    return response;
  }
```

  Set `Version: '1.2.1'` and append to `Description`: `'Local copy (the1nk): also treats a file as video when ffprobe finds a video stream that isn\'t cover art, because Tdarr labels a file audio when its video frame rate reads 0/0 (seen on some MPEG-TS captures); remuxing re-derives it. \n\n'`.

  Also replace the container check with this, so a file labelled audio that has a real video stream is remuxed even when the container matches (the other `if`/`else` branches stay as they are):

```js
  if (file.fileMedium !== 'video' && file.container === inputs.container) {
    response.infoLog += `☒Tdarr labels this file audio (its video frame rate reads ${realVideoStream.avg_frame_rate || 'unknown'}). Remuxing so later steps see a video. \n`;
    convert = true;
    genpts = '-fflags +genpts';
  } else if (file.container !== inputs.container) {
    // ...existing "Remuxing." branch
```

  Extra tests: an `.mkv` labelled audio with a video stream at `avg_frame_rate: '0/0'` is remuxed (preset `'-fflags +genpts, -map 0 -c copy -max_muxing_queue_size 9999 -map -0:d '`, container `.mkv`, the new log line); an `.mkv` labelled video is still "already in mkv"; a real-format TS record (audio stream first, h264 `0/0` video later) is remuxed.
- [ ] **Step 4: README.** In "Local copies of community plugins", change "These are unmodified community plugins" to say they are community plugins kept in `Local`, unmodified except where noted, and add to the Migz Remux row: "**Modified (v1.2.1):** also remuxes files Tdarr labels audio when ffprobe finds a real video stream, even if the container already matches (Tdarr labels a file audio when its video frame rate reads `0/0`, seen on some MPEG-TS captures); the remux re-derives the rate".
- [ ] **Step 5:** `node --test tests/*.test.js` (fail 0). Commit the plugin, the test and README: "Remux MPEG-TS files that Tdarr labels audio".

### Task 2: Add Suffix keeps the real extension

**Files:** Modify `Tdarr_Plugin_the1nk_add_suffix_to_filename.js`; create `tests/add_suffix.test.js`.

- [ ] **Step 1: Failing tests** with a stubbed `fs` (`renameSync` records `[from, to]`), calling `plugin(file, {}, { suffix: ' (Tdarr)' }, {})`. Build expected paths with `path.join` / `path.dirname` so they hold on Windows too.
  - `file = { _id: '/temp/w/Space King - S01E02 - House of a Thousand Furries.ts', fileNameWithoutExtension: 'Space King - S01E02 - House of a Thousand Furries', meta: { Directory: '/temp/w', FileTypeExtension: 'm2t' } }` → new `_id` the literal `'/temp/w/Space King - S01E02 - House of a Thousand Furries (Tdarr).ts'`, one rename from the old to the new path, `updateDB` true, infoLog contains `'extension is .ts'`.
  - an `.mkv` with `FileTypeExtension: 'mkv'` → ends `' (Tdarr).mkv'`.
  - `fileNameWithoutExtension: 'Good Boy (2025) {imdb-tt35521922} ()'`, `_id` `'/m/Good Boy (2025) {imdb-tt35521922} ().mkv'` → `path.join('/m', 'Good Boy (2025) {imdb-tt35521922} (Tdarr).mkv')`.
  - already suffixed (`fileNameWithoutExtension` ends with `' (Tdarr)'`) → no rename, `updateDB` false.
- [ ] **Step 2:** run, see the `.ts` case fail (`.m2t`).
- [ ] **Step 3: Implement.** Require `path` next to `fs`, replace the `FileTypeExtension` log line with `response.infoLog += 'extension is ' + path.extname(fileNameOld) + '\r\n';`, and build the name as:

```js
      // Folder and extension from the file's own (POSIX) path: ExifTool's FileTypeExtension calls MPEG-TS "m2t".
      file._id = path.posix.join(path.posix.dirname(fileNameOld),
        cleanName + (' ' + inputs.suffix).replace('  ', ' ') + path.posix.extname(fileNameOld));
```

  Use `path.posix.extname` in the `extension is` log line, and replace the `file.meta.Directory` log line with `'directory is ' + path.posix.dirname(fileNameOld)`, so a record without `meta` is still renamed. Tests assert literal POSIX strings and add: `Mr. Robot - S01E01.mkv` → `Mr. Robot - S01E01 (Tdarr).mkv`; `UPPER.MKV` → `UPPER (Tdarr).MKV`; a record without `meta` is renamed.

  Set `Version: "1.01"` and `Description: \`Adds a suffix to the filename, keeping the file's own extension\``.
- [ ] **Step 4:** `node --test tests/*.test.js` (fail 0). Commit: "Keep the real extension when adding the filename suffix".
