# Check Video Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A command-line tool that checks video files and folders for missing frames with exactly the Detect Damaged Video plugin's rules.

**Architecture:** `tools/check-video.js` requires the plugin file and reuses its `_test` helpers. Async `spawn` runs ffprobe with the plugin's arguments; a small worker pool checks `-j` files at once; results print as they finish, then a summary.

**Tech Stack:** Node.js 25 (this PC), ffprobe on PATH (`C:\Users\adam\OneDrive\Documents\CLI\ffprobe.exe`), `node:test`.

**Spec:** `docs/superpowers/specs/2026-10-29-check-video-tool-design.md`. Read it first.

---

## Background

- Repo conventions: `CLAUDE.md`, `README.md`. Work on branch `check-video-tool` (already created from `main`). Commit at the end of each task; never push. Commit messages end with a blank line, then `Claude-Session: https://claude.ai/code/session_016ziVwwvkMXfjNotbAoqpyw`.
- Windows dev box, Git Bash: never redirect to `/dev/null`. Unit tests: `node --test tests/*.test.js`.
- The plugin's `_test` exports: `STD, pickFfprobe, pickVideo, parseTimes, findGaps, clock, describeGaps, damagedMessage, countLines, firstErrors, tail`. `tail(text)` keeps the last 20 non-empty lines / 2000 chars. `firstErrors(stderr, n)` rewrites `[h264 @ 0x…] msg` to `h264: msg`.
- The plugin's ffprobe arguments, which the tool must use unchanged:
  - listing: `['-v','error','-select_streams', <index>, '-show_entries','packet=pts_time','-of','csv=p=0','--', <file>]`
  - decode: `['-v','repeat+error','-threads','0','-select_streams', <index>, '-count_frames','-show_entries','stream=nb_read_frames','-of','csv=p=0','--', <file>]`
- Stream probe: `ffprobe -v error -show_entries stream=index,codec_type,r_frame_rate:stream_disposition=attached_pic -of json -- <file>` returns `{ "streams": [ { "index": 0, "codec_type": "video", "r_frame_rate": "27187/1134", "disposition": { "attached_pic": 0 } }, … ] }` (verified on this PC).
- Known damaged file for the real run: `M:/Library/Anishows/Dr. STONE {imdb-tt9679542}/Season 1/Dr. STONE - S01E03 - Weapons of Science ().mkv`. In the Tdarr node the plugin reported: `Damaged video: 1 timing gap (largest 1.29s at 14:53), about 1.3s of video missing, and 1 decode error. The source is missing frames; replace it with a clean copy.` with first decoder error `h264: error while decoding MB 2 67, bytestream -8`.

---

### Task 1: The tool and its unit tests

**Files:**
- Create: `tools/check-video.js`
- Create: `tests/check_video.test.js`

- [ ] **Step 1: Write the failing tests** in `tests/check_video.test.js` (`node:test`, `node:assert`). Require the tool from `path.join(__dirname, '..', 'tools', 'check-video.js')`. Write a fake runner `fake(cfg)` returning `async (cmd, args) => …` that records `[cmd, ...args]` and answers by argument: `args.includes('stream=index,codec_type,r_frame_rate:stream_disposition=attached_pic')` → the stream probe result, `args.includes('packet=pts_time')` → the listing result, `args.includes('-count_frames')` → the decode result. Defaults: streams `[{ index: 0, codec_type: 'video', r_frame_rate: '7016/301', disposition: { attached_pic: 0 } }]`, a steady 24 fps listing, decode `{ status: 0, stdout: '144\n', stderr: '' }`. Use the same `grid`/`csv` helpers as `tests/detect_damaged_video.test.js` (24 fps at 1 ms: `Math.round((n / 24) * 1000) / 1000`). The tests, with exact expectations:

  `parseArgs`:
  - `[]` → `{ all: false, jobs: 2, ffprobe: 'ffprobe', paths: [], help: false }` (no `error` key).
  - `['--all', '-j', '4', '--ffprobe', 'C:\\ff\\ffprobe.exe', 'a', 'b']` → all true, jobs 4, that ffprobe, paths `['a','b']`.
  - `['--jobs', '0']` and `['-j', 'x']` → `error` is `'--jobs needs a whole number of at least 1'` / `'-j needs a whole number of at least 1'`.
  - `['--ffprobe']` → error `'--ffprobe needs a path'`. `['--bogus']` → error `'unknown option --bogus'`.
  - `['--', '-odd.mkv']` → paths `['-odd.mkv']`. `['-h']` and `['--help']` → help true.

  `checkFile(file, opts, run)` with `opts = { all: false, ffprobe: 'ffprobe' }`, file `'/v/a.mkv'`:
  - only cover art → `{ file, verdict: 'skipped', detail: 'no video stream' }`, 1 call.
  - rate `24000/1001` → verdict `clean`, detail `'standard frame rate 24000/1001'`, 1 call; with `all: true` → 2 calls (listing made), detail `'frame rate 24000/1001, steady timing (no gaps)'`.
  - odd rate, steady → `clean`, detail `'frame rate 7016/301, steady timing (no gaps)'`, 2 calls; the listing call equals `['ffprobe','-v','error','-select_streams','0','-show_entries','packet=pts_time','-of','csv=p=0','--','/v/a.mkv']`.
  - listing with a 4 s hole (`grid(0,120)` + `grid(216,240)`), clean decode → verdict `vfr`, detail `'frame rate 7016/301: 1 timing gap (largest 4.04s at 00:04), about 4.0s of video missing, but the video decodes cleanly (variable frame rate on purpose)'`; the decode call equals `['ffprobe','-v','repeat+error','-threads','0','-select_streams','0','-count_frames','-show_entries','stream=nb_read_frames','-of','csv=p=0','--','/v/a.mkv']`.
  - same hole, decode stderr `'[h264 @ 0x1] Missing reference picture, default is 0\n[h264 @ 0x1] mmco: unref short failure\n'` → verdict `damaged`, detail `'Damaged video: 1 timing gap (largest 4.04s at 00:04), about 4.0s of video missing, and 2 decode errors. The source is missing frames; replace it with a clean copy.'`, `firstErrors` `['h264: Missing reference picture, default is 0', 'h264: mmco: unref short failure']`.
  - cover art at index 0 then video at index 1 → the listing call uses `'-select_streams', '1'`.
  - stream probe `{ status: 1, stdout: '', stderr: 'Invalid data found when processing input\n' }` → `error`, detail `'ffprobe could not read the file (exit 1): Invalid data found when processing input'`.
  - stream probe `{ error: new Error('spawn ffprobe ENOENT'), status: null, signal: null, stdout: '', stderr: '' }` → detail `'ffprobe could not read the file (not started): spawn ffprobe ENOENT'`.
  - stream probe stdout `'not json'` with status 0 → `error`, detail `'ffprobe returned no JSON'`.
  - listing `{ status: null, signal: 'SIGKILL', stdout: '', stderr: '' }` → detail `'ffprobe could not list the video timestamps (signal SIGKILL): no output'`.
  - listing `'N/A\n'` → `error`, detail `'ffprobe listed too few usable video timestamps (0 found)'`.
  - decode `{ status: 1, stdout: '', stderr: 'boom' }` → detail `'ffprobe could not decode the video (exit 1): boom'`.

  `collectFiles(paths)` with a real temp folder (`fs.mkdtempSync(path.join(os.tmpdir(), 'cv-'))`, removed in `after`): create `show/S1/E1.MKV`, `show/S1/E2.mp4`, `show/S1/E2.nfo`, `show/E3.m2t`, `show/cover.jpg`, and `loose.txt`.
  - `collectFiles([show])` → files exactly `[show/E3.m2t, show/S1/E1.MKV, show/S1/E2.mp4]` (sorted by name within each folder, folders walked in name order), problems `[]`.
  - `collectFiles([loose.txt])` → files `[loose.txt]` (explicit files are checked whatever the extension).
  - `collectFiles([missing])` → files `[]`, problems `[{ file: missing, verdict: 'error', detail: 'not found' }]`.
  - The same file given twice is listed once.

  `main(argv, deps)` with `deps = { run, out, err }` capturing lines into arrays:
  - `[]` → returns 2, `err` got the usage text (starts with `'Usage: node tools/check-video.js'`).
  - `['--help']` → returns 0, usage on `out`.
  - `['--bogus']` → returns 2, `err` has `'unknown option --bogus'` then the usage.
  - a temp folder with only `notes.nfo` → returns 2, `err` has `'No video files found.'`.
  - a temp folder with `a.mkv` (fake: steady) and `b.mkv` (fake: damaged as above; branch on the file path, the last argument) → returns 1. `out` has two progress lines matching `/^\[[12]\/2\] (CLEAN|DAMAGED) +.*[ab]\.mkv - /`, then `''`, then `'Checked 2 files: 1 clean, 0 deliberate VFR, 1 damaged, 0 errors, 0 skipped.'`, then `''`, `'Damaged:'`, `'  ' + b.mkv`, `'    Damaged video: …'` (the exact detail), `'    First decoder errors:'`, `'      h264: Missing reference picture, default is 0'`, `'      h264: mmco: unref short failure'`.
  - all clean → returns 0 and no `Damaged:` section.
  - a missing path plus a clean file → returns 1; the summary counts 1 error; an `'Errors:'` section lists `'  <missing>: not found'`.
  - concurrency: 5 files, `-j 2`, a run stub that waits 20 ms per call and tracks how many checks are in flight → the maximum is exactly 2; with `-j 1` it is 1.

  `runTool` with the real Node binary: `runTool(process.execPath, ['-e', 'process.stdout.write("hi");process.stderr.write("e");process.exit(3)'])` → `status 3`, `stdout 'hi'`, `stderr 'e'`; `runTool('no-such-tool-xyz', [])` → `error` set, `status null`.

- [ ] **Step 2: Run them, see them fail** — `node --test tests/check_video.test.js` fails with `Cannot find module …tools/check-video.js`.

- [ ] **Step 3: Write `tools/check-video.js`:**

```js
#!/usr/bin/env node
// Checks video files for missing frames with the Detect Damaged Video plugin's rules.
// Usage: node tools/check-video.js [--all] [-j N] [--ffprobe <path>] <file or folder>...
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const rules = require('../Tdarr_Plugin_the1nk_detect_damaged_video.js')._test;

// The libraries' container filter without disc images, plus the other MPEG-TS extensions.
const EXTENSIONS = ['mkv', 'mp4', 'mov', 'm4v', 'mpg', 'mpeg', 'avi', 'flv', 'webm', 'wmv', 'vob', 'evo',
  'm2ts', 'm2t', 'mts', 'ts'];

const USAGE = [
  'Usage: node tools/check-video.js [--all] [-j N] [--ffprobe <path>] <file or folder>...',
  '  --all          also check the timing of files whose frame rate is standard',
  '  -j, --jobs N   files to check at once (default 2)',
  '  --ffprobe P    ffprobe to use (default: ffprobe on PATH)',
].join('\n');

const LABEL = { clean: 'CLEAN', vfr: 'VFR', damaged: 'DAMAGED', error: 'ERROR', skipped: 'SKIPPED' };

// Runs a tool to completion: { status, signal, stdout, stderr, error }.
const runTool = (cmd, args) => new Promise((resolve) => {
  let stdout = '';
  let stderr = '';
  const child = spawn(cmd, args, { windowsHide: true });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  child.on('error', (error) => resolve({ error, status: null, signal: null, stdout, stderr }));
  child.on('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
});

const failed = (r) => !!r.error || r.status !== 0;
// "(exit 1): <last lines of the output>"
const why = (r) => '(' + (r.error ? 'not started' : r.signal ? 'signal ' + r.signal : 'exit ' + r.status) + '): '
  + rules.tail(r.error ? r.error.message : (r.stderr || r.stdout || 'no output'));

// The plugin's checks, on one file: { file, verdict, detail, firstErrors? }.
const checkFile = async (file, opts, run) => {
  const result = (verdict, detail, extra) => Object.assign({ file, verdict, detail }, extra);
  const probe = await run(opts.ffprobe, ['-v', 'error', '-show_entries',
    'stream=index,codec_type,r_frame_rate:stream_disposition=attached_pic', '-of', 'json', '--', file]);
  if (failed(probe)) return result('error', 'ffprobe could not read the file ' + why(probe));
  let streams;
  try {
    streams = JSON.parse(probe.stdout).streams || [];
  } catch (e) {
    return result('error', 'ffprobe returned no JSON');
  }
  const video = rules.pickVideo(streams);
  if (!video) return result('skipped', 'no video stream');
  const rate = video.r_frame_rate || 'unknown';
  if (rules.STD.indexOf(rate) !== -1 && !opts.all) return result('clean', 'standard frame rate ' + rate);

  const stream = String(video.index);
  const list = await run(opts.ffprobe, ['-v', 'error', '-select_streams', stream, '-show_entries', 'packet=pts_time',
    '-of', 'csv=p=0', '--', file]);
  if (failed(list)) return result('error', 'ffprobe could not list the video timestamps ' + why(list));
  const times = rules.parseTimes(list.stdout);
  if (times.length < 2) {
    return result('error', 'ffprobe listed too few usable video timestamps (' + times.length + ' found)');
  }
  const g = rules.findGaps(times);
  if (!g.gaps.length) return result('clean', 'frame rate ' + rate + ', steady timing (no gaps)');

  const dec = await run(opts.ffprobe, ['-v', 'repeat+error', '-threads', '0', '-select_streams', stream,
    '-count_frames', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', '--', file]);
  if (failed(dec)) return result('error', 'ffprobe could not decode the video ' + why(dec));
  const errors = rules.countLines(dec.stderr);
  if (errors === 0) {
    return result('vfr', 'frame rate ' + rate + ': ' + rules.describeGaps(g)
      + ', but the video decodes cleanly (variable frame rate on purpose)');
  }
  return result('damaged', rules.damagedMessage(g, errors), { firstErrors: rules.firstErrors(dec.stderr, 5) });
};

const isVideo = (name) => EXTENSIONS.indexOf(path.extname(name).slice(1).toLowerCase()) !== -1;

const walk = (dir, files, problems) => {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    problems.push({ file: dir, verdict: 'error', detail: 'could not read the folder: ' + e.message });
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  entries.forEach((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, files, problems);
    else if (e.isFile() && isVideo(e.name)) files.push(p);
  });
};

// Files given explicitly are checked whatever their extension; folders are walked for video files.
const collectFiles = (paths) => {
  const files = [];
  const problems = [];
  paths.forEach((p) => {
    let st;
    try {
      st = fs.statSync(p);
    } catch (e) {
      problems.push({ file: p, verdict: 'error', detail: 'not found' });
      return;
    }
    if (st.isDirectory()) walk(p, files, problems);
    else files.push(p);
  });
  return { files: Array.from(new Set(files)), problems };
};

const parseArgs = (argv) => {
  const o = { all: false, jobs: 2, ffprobe: 'ffprobe', paths: [], help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') o.all = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else if (a === '-j' || a === '--jobs') {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1) return Object.assign(o, { error: a + ' needs a whole number of at least 1' });
      o.jobs = n;
    } else if (a === '--ffprobe') {
      if (argv[i + 1] === undefined) return Object.assign(o, { error: '--ffprobe needs a path' });
      o.ffprobe = argv[++i];
    } else if (a === '--') {
      o.paths.push(...argv.slice(i + 1));
      break;
    } else if (a.startsWith('-')) return Object.assign(o, { error: 'unknown option ' + a });
    else o.paths.push(a);
  }
  return o;
};

const main = async (argv, deps) => {
  const d = Object.assign({
    run: runTool,
    out: (s) => process.stdout.write(s + '\n'),
    err: (s) => process.stderr.write(s + '\n'),
  }, deps);
  const o = parseArgs(argv);
  if (o.help) {
    d.out(USAGE);
    return 0;
  }
  if (o.error || !o.paths.length) {
    if (o.error) d.err(o.error);
    d.err(USAGE);
    return 2;
  }
  const { files, problems } = collectFiles(o.paths);
  if (!files.length && !problems.length) {
    d.err('No video files found.');
    return 2;
  }

  const results = problems.slice();
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < files.length) {
      const file = files[next++];
      let r;
      try {
        r = await checkFile(file, o, d.run);
      } catch (e) {
        r = { file, verdict: 'error', detail: e.message };
      }
      results.push(r);
      done++;
      d.out('[' + done + '/' + files.length + '] ' + LABEL[r.verdict].padEnd(7) + ' ' + r.file + ' - ' + r.detail);
    }
  };
  await Promise.all(Array.from({ length: Math.min(o.jobs, files.length) }, worker));

  const byFile = (a, b) => a.file.localeCompare(b.file);
  const count = (v) => results.filter((r) => r.verdict === v).length;
  const damaged = results.filter((r) => r.verdict === 'damaged').sort(byFile);
  const errors = results.filter((r) => r.verdict === 'error').sort(byFile);
  d.out('');
  d.out('Checked ' + files.length + ' ' + (files.length === 1 ? 'file' : 'files') + ': ' + count('clean') + ' clean, '
    + count('vfr') + ' deliberate VFR, ' + damaged.length + ' damaged, ' + errors.length + ' errors, '
    + count('skipped') + ' skipped.');
  if (damaged.length) {
    d.out('');
    d.out('Damaged:');
    damaged.forEach((r) => {
      d.out('  ' + r.file);
      d.out('    ' + r.detail);
      if (r.firstErrors.length) {
        d.out('    First decoder errors:');
        r.firstErrors.forEach((line) => d.out('      ' + line));
      }
    });
  }
  if (errors.length) {
    d.out('');
    d.out('Errors:');
    errors.forEach((r) => d.out('  ' + r.file + ': ' + r.detail));
  }
  return damaged.length || errors.length ? 1 : 0;
};

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}

module.exports = { EXTENSIONS, runTool, checkFile, collectFiles, parseArgs, main };
```

- [ ] **Step 4: Run the tests** — `node --test tests/*.test.js`: fail 0.
- [ ] **Step 5: Commit** `tools/check-video.js` and `tests/check_video.test.js`: "Add a tool that checks video files for missing frames" + trailer.

---

### Task 2: Real files and the README

**Files:** Modify `README.md`.

- [ ] **Step 1: Real run on the damaged file.** `node tools/check-video.js "M:/Library/Anishows/Dr. STONE {imdb-tt9679542}/Season 1/Dr. STONE - S01E03 - Weapons of Science ().mkv"` (several minutes: it reads and decodes the whole episode over the network). Expected: one `DAMAGED` line, the summary `Checked 1 file: 0 clean, 0 deliberate VFR, 1 damaged, 0 errors, 0 skipped.`, the Damaged section with the same message the plugin gave in the node (Background) and `h264: error while decoding MB 2 67, bytestream -8`, exit code 1. If the message differs from the node's (this PC's ffprobe is a different build), report it rather than changing code.
- [ ] **Step 2: Real run on a clean episode and a folder.** `node tools/check-video.js "M:/Library/Anishows/Dr. STONE {imdb-tt9679542}/Season 1/Dr. STONE - S01E01 - Stone World ().mkv"` (or any other episode in that folder) — expect `CLEAN` (or `VFR`) and exit 0; then `node tools/check-video.js -j 2 "M:/Library/OtherVideos/Space King/Season 1"` — expect the seven re-downloaded episodes `CLEAN` (standard rate) and exit 0. Report the outputs.
- [ ] **Step 3: README.** Add a `## Tools` section just before `## Deployment`:

```markdown
## Tools

### `tools/check-video.js`

Checks video files that are already in the library (or anywhere else) for missing frames, with exactly the rules of [Detect Damaged Video](#tdarr_plugin_the1nk_detect_damaged_video): it loads that plugin and runs the same ffprobe checks. Run it on any PC with Node.js and ffprobe:

```bash
node tools/check-video.js [--all] [-j N] [--ffprobe <path>] <file or folder>...
```

Folders are searched recursively for library video files (`mkv mp4 mov m4v mpg mpeg avi flv webm wmv vob evo m2ts m2t mts ts`); files named directly are checked whatever their extension. Each file gets one line as it finishes, then a summary lists the damaged files (with the first decoder errors) and any errors again.

| Verdict | Meaning |
|---------|---------|
| `CLEAN` | standard frame rate, or steady timing |
| `VFR` | timing gaps, but the video decodes cleanly: variable frame rate on purpose |
| `DAMAGED` | timing gaps and decoder errors: frames are missing; replace the file |
| `ERROR` | ffprobe couldn't read the file, or the path doesn't exist |
| `SKIPPED` | no video stream |

| Option | Default | Description |
|--------|---------|-------------|
| `--all` | off | also check the timing of files whose frame rate is standard (the plugin skips them; slower, but finds damage the plugin can't) |
| `-j`, `--jobs` | `2` | files checked at once; every check reads the whole file, so a big library over the network takes hours |
| `--ffprobe` | `ffprobe` on PATH | the ffprobe to use |

Exit code: `0` if nothing is damaged and nothing failed, `1` if any file is damaged or failed, `2` for a usage error or when no video files were found.

---
```

  (Keep one `---` between sections; check the surrounding separators.) In `## Tests`, mention that the unit tests include `tests/check_video.test.js`.
- [ ] **Step 4:** `node --test tests/*.test.js` (fail 0). Commit `README.md`: "Document the check-video tool" + trailer.
