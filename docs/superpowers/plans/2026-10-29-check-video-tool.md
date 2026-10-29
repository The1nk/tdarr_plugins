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

- [x] **Step 1: Write the failing tests** in `tests/check_video.test.js` (`node:test`, `node:assert`; it is the file in the repo). Require the tool from `path.join(__dirname, '..', 'tools', 'check-video.js')`. A fake runner `fake(cfg)` returns `async (cmd, args) => …` that records `[cmd, ...args]` and answers by argument: `-version` → status 0, the stream probe (`stream=index,codec_type,r_frame_rate:stream_disposition=attached_pic`), the listing (`packet=pts_time`) and the decode (`-count_frames`), each overridable. Defaults: one video stream at `7016/301`, a steady 24 fps listing (`grid`/`csv` helpers as in `tests/detect_damaged_video.test.js`), decode `{ status: 0, stdout: '144\n', stderr: '' }`. Cases:

  - `oneLine` (splits on \r\n, \r, \n; trims; drops empty lines; joins with ` | `); `capLabel` (`'256 MB'`, `'1000 bytes'`).
  - `parseArgs`: defaults `{ all: false, jobs: 2, timeout: 120, ffprobe: 'ffprobe', paths: [], help: false }`; every option; the errors (`--jobs`/`-j` need a whole number of at least 1, `--timeout needs a whole number of minutes (0 = none)` for `-1`, `x`, `1.5` and a missing value, `--ffprobe needs a path`, `unknown option --bogus`); `--timeout 0`; `--`; `-h`/`--help`.
  - `checkFile`: cover art only → skipped; standard rate → clean in 1 call (`--all` → 2 calls); odd rate steady → clean with the exact listing call; a 4 s hole → `vfr` with the exact decode call; the hole with decode errors → `damaged` with the plugin's text and `firstErrors`; cover art at index 0 → listing uses stream 1; the runner receives `{ timeoutMs: minutes * 60000 }`; every ffprobe failure text (exit, not started, no JSON, signal, too few timestamps, decode); `(timed out after 7 min)`; an overflowed call (`overflow: true`) is `(output cap): ffprobe output exceeded 1000 bytes`, not "not started"; multi-line stderr becomes one line.
  - `collectFiles` (real temp folders): extension filter and sort order, explicit files of any extension, missing path → `not found`, duplicates; paths normalised with `path.resolve` (mixed slashes, relative, case on Windows) and a file given directly and inside a given folder is listed once under its first spelling; a file and a symlink to it are listed once under the first spelling (`t.skip` if file links can't be created); a junction to another folder is followed and a junction back to the parent does not loop (`t.skip` if links can't be created); a folder whose `readdirSync` throws (`t.mock.method`) is a one-line problem and the rest is still collected.
  - `summarise`: the exact lines for damaged + errors + not-found paths (singular/plural), exit codes 1/3/0.
  - `main` (fake runner, captured `out`/`err`): usage and exit 2/0; unknown option; unusable ffprobe (not started, exit) → exit 2, nothing else printed, only the `-version` call; no video files → 2; damaged → `Found 2 video files.`, tab-separated progress lines, summary, Damaged section, exit 1; `Found 1 video file.`; missing path → exit 3 and ` 1 path not found.`; unreadable file → exit 3 with a one-line detail; damaged beats errors; a runner that throws → `ERROR` line; the same file given three ways → 1; concurrency never exceeds `-j` (2 and 1); Ctrl+C (`deps.onInterrupt`/`deps.exit`/`deps.killChildren` stubs) prints `Interrupted.` and one summary, exits 130; a call that ends with status 3221225786 is not reported, whether it comes after the handler ran or before it (then the scan stops and the interrupt routine runs itself); the handler kills the children in `liveChildren` (a `kill` spy).
  - `runTool` (real Node child): status/stdout/stderr and a missing tool; a child killed by `timeoutMs: 200` has `timedOut` and a `signal`; a quick child is not timed out; output beyond `maxBytes: 1000` kills it with `error.message === 'ffprobe output exceeded 1000 bytes'` and `overflow: true` (stdout and stderr); exit status 3221225786 sets `interrupted` (Windows); `liveChildren` holds the child while it runs.

- [ ] **Step 2: Run them, see them fail** — `node --test tests/check_video.test.js` fails with `Cannot find module …tools/check-video.js`.

- [ ] **Step 3: Write `tools/check-video.js`:**

```js
#!/usr/bin/env node
// Checks video files for missing frames with the Detect Damaged Video plugin's rules.
// Usage: node tools/check-video.js [--all] [-j N] [--timeout MIN] [--ffprobe <path>] <file or folder>...
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const rules = require('../Tdarr_Plugin_the1nk_detect_damaged_video.js')._test;

// The libraries' container filter without disc images, plus the other MPEG-TS extensions.
const EXTENSIONS = ['mkv', 'mp4', 'mov', 'm4v', 'mpg', 'mpeg', 'avi', 'flv', 'webm', 'wmv', 'vob', 'evo',
  'm2ts', 'm2t', 'mts', 'ts'];

const USAGE = [
  'Usage: node tools/check-video.js [--all] [-j N] [--timeout MIN] [--ffprobe <path>] <file or folder>...',
  '  --all          also check the timing of files whose frame rate is standard',
  '  -j, --jobs N   files to check at once (default 2)',
  '  --timeout MIN  give up on one ffprobe call after MIN minutes (default 120, 0 = never)',
  '  --ffprobe P    ffprobe to use (default: ffprobe on PATH)',
].join('\n');

const LABEL = { clean: 'CLEAN', vfr: 'VFR', damaged: 'DAMAGED', error: 'ERROR', skipped: 'SKIPPED' };
const NOT_FOUND = 'not found';
const MAX_BYTES = 256 * 1024 * 1024; // the plugin's maxBuffer
const DEFAULT_TIMEOUT_MIN = 120;
// Windows' exit status for a process ended by Ctrl+C (STATUS_CONTROL_C_EXIT).
const CONTROL_C = 3221225786;

// The ffprobe processes running now, so Ctrl+C can stop them.
const liveChildren = new Set();
const killAll = () => {
  liveChildren.forEach((c) => {
    try {
      c.kill();
    } catch (e) {
      // already gone
    }
  });
};

// Error details are single lines: split on line breaks, trim, drop empty lines, join with " | ".
const oneLine = (text) => String(text).split(/\r\n|\r|\n/).map((s) => s.trim()).filter(Boolean).join(' | ');

const capLabel = (bytes) => (bytes >= 1024 * 1024 ? Math.round(bytes / (1024 * 1024)) + ' MB' : bytes + ' bytes');

// Runs a tool to completion: { status, signal, stdout, stderr, error, timedOut, overflow, interrupted }.
// opts.timeoutMs (0 = none) kills it; opts.maxBytes caps each output stream.
const runTool = (cmd, args, opts) => new Promise((resolve) => {
  const o = Object.assign({ timeoutMs: 0, maxBytes: MAX_BYTES }, opts);
  let stdout = '';
  let stderr = '';
  let outBytes = 0;
  let errBytes = 0;
  let settled = false;
  let timedOut = false;
  let timer = null;
  const finish = (r) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    liveChildren.delete(child);
    resolve(r);
  };
  const child = spawn(cmd, args, { windowsHide: true });
  liveChildren.add(child);
  const overflow = () => {
    child.kill();
    finish({ error: new Error('ffprobe output exceeded ' + capLabel(o.maxBytes)), overflow: true, status: null, signal: null, stdout, stderr });
  };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    if (settled) return;
    outBytes += Buffer.byteLength(d);
    if (outBytes > o.maxBytes) overflow();
    else stdout += d;
  });
  child.stderr.on('data', (d) => {
    if (settled) return;
    errBytes += Buffer.byteLength(d);
    if (errBytes > o.maxBytes) overflow();
    else stderr += d;
  });
  child.on('error', (error) => finish({ error, status: null, signal: null, stdout, stderr }));
  child.on('close', (status, signal) => {
    const r = { status, signal, stdout, stderr };
    if (timedOut) Object.assign(r, { signal: signal || 'SIGTERM', timedOut: true });
    else if (status === CONTROL_C) r.interrupted = true;
    finish(r);
  });
  if (o.timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, o.timeoutMs);
  }
});

const failed = (r) => !!r.error || r.status !== 0;
// "(exit 1): <last lines of the output>"
const why = (r, minutes) => {
  const how = r.timedOut ? 'timed out after ' + minutes + ' min'
    : r.overflow ? 'output cap'
        : r.error ? 'not started' : r.signal ? 'signal ' + r.signal : 'exit ' + r.status;
  return '(' + how + '): ' + rules.tail(r.error ? r.error.message : (r.stderr || r.stdout || 'no output'));
};

// The plugin's checks, on one file: { file, verdict, detail, firstErrors? }.
const checkFile = async (file, opts, run) => {
  const minutes = opts.timeout === undefined ? DEFAULT_TIMEOUT_MIN : opts.timeout;
  const call = (args) => run(opts.ffprobe, args, { timeoutMs: minutes * 60000 });
  const result = (verdict, detail, extra) => Object.assign({ file, verdict,
    detail: verdict === 'error' ? oneLine(detail) : detail }, extra);
  const probe = await call(['-v', 'error', '-show_entries',
    'stream=index,codec_type,r_frame_rate:stream_disposition=attached_pic', '-of', 'json', '--', file]);
  if (failed(probe)) return result('error', 'ffprobe could not read the file ' + why(probe, minutes));
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
  const list = await call(['-v', 'error', '-select_streams', stream, '-show_entries', 'packet=pts_time',
    '-of', 'csv=p=0', '--', file]);
  if (failed(list)) return result('error', 'ffprobe could not list the video timestamps ' + why(list, minutes));
  const times = rules.parseTimes(list.stdout);
  if (times.length < 2) {
    return result('error', 'ffprobe listed too few usable video timestamps (' + times.length + ' found)');
  }
  const g = rules.findGaps(times);
  if (!g.gaps.length) return result('clean', 'frame rate ' + rate + ', steady timing (no gaps)');

  const dec = await call(['-v', 'repeat+error', '-threads', '0', '-select_streams', stream,
    '-count_frames', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', '--', file]);
  if (failed(dec)) return result('error', 'ffprobe could not decode the video ' + why(dec, minutes));
  const errors = rules.countLines(dec.stderr);
  if (errors === 0) {
    return result('vfr', 'frame rate ' + rate + ': ' + rules.describeGaps(g)
      + ', but the video decodes cleanly (variable frame rate on purpose)');
  }
  return result('damaged', rules.damagedMessage(g, errors), { firstErrors: rules.firstErrors(dec.stderr, 5) });
};

const isVideo = (name) => EXTENSIONS.indexOf(path.extname(name).slice(1).toLowerCase()) !== -1;

// Windows paths are case-insensitive.
const keyOf = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);

// Folders already walked (by real path) are skipped, so links that loop can't run forever.
const walk = (dir, files, problems, visited) => {
  let real = dir;
  try {
    real = fs.realpathSync(dir);
  } catch (e) {
    // fall back to the path itself; readdir below reports the real problem
  }
  if (visited.has(keyOf(real))) return;
  visited.add(keyOf(real));
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    problems.push({ file: dir, verdict: 'error', detail: oneLine('could not read the folder: ' + e.message) });
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  entries.forEach((e) => {
    const p = path.join(dir, e.name);
    let isDir = e.isDirectory();
    let isFile = e.isFile();
    if (e.isSymbolicLink()) {
      try {
        const st = fs.statSync(p);
        isDir = st.isDirectory();
        isFile = st.isFile();
      } catch (err) {
        if (isVideo(e.name)) problems.push({ file: p, verdict: 'error', detail: oneLine('could not follow the link: ' + err.message) });
        return;
      }
    }
    if (isDir) walk(p, files, problems, visited);
    else if (isFile && isVideo(e.name)) files.push(p);
  });
};

// Files given explicitly are checked whatever their extension; folders are walked for video files.
// Paths are made absolute, and a file reached twice (or through a link) is listed once (first spelling kept).
const collectFiles = (paths) => {
  const files = [];
  const problems = [];
  const visited = new Set();
  paths.forEach((given) => {
    const p = path.resolve(given);
    let st;
    try {
      st = fs.statSync(p);
    } catch (e) {
      problems.push({ file: p, verdict: 'error', detail: NOT_FOUND });
      return;
    }
    if (st.isDirectory()) walk(p, files, problems, visited);
    else files.push(p);
  });
  const seen = new Set();
  return {
    files: files.filter((f) => {
      let real = path.resolve(f);
      try {
        real = fs.realpathSync(f);
      } catch (e) {
        // keep the resolved path
      }
      const k = keyOf(real);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }),
    problems,
  };
};

const parseArgs = (argv) => {
  const o = { all: false, jobs: 2, timeout: DEFAULT_TIMEOUT_MIN, ffprobe: 'ffprobe', paths: [], help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') o.all = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else if (a === '-j' || a === '--jobs') {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1) return Object.assign(o, { error: a + ' needs a whole number of at least 1' });
      o.jobs = n;
    } else if (a === '--timeout') {
      const raw = argv[++i];
      const n = raw === undefined || raw === '' ? NaN : Number(raw);
      if (!Number.isInteger(n) || n < 0) {
        return Object.assign(o, { error: '--timeout needs a whole number of minutes (0 = none)' });
      }
      o.timeout = n;
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

const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');

// Prints the summary of the results so far and returns the exit code (1 damaged, 3 errors, else 0).
// `checked` is the number of files checked; paths that were not found are listed but not counted.
const summarise = (results, checked, out) => {
  const missing = results.filter((r) => r.verdict === 'error' && r.detail === NOT_FOUND).length;
  const byFile = (a, b) => a.file.localeCompare(b.file);
  const damaged = results.filter((r) => r.verdict === 'damaged').sort(byFile);
  const errors = results.filter((r) => r.verdict === 'error').sort(byFile);
  const count = (v) => results.filter((r) => r.verdict === v).length;
  out('');
  out('Checked ' + plural(checked, 'file') + ': ' + count('clean') + ' clean, ' + count('vfr') + ' deliberate VFR, '
    + damaged.length + ' damaged, ' + plural(errors.length - missing, 'error') + ', ' + count('skipped') + ' skipped.'
    + (missing ? ' ' + plural(missing, 'path') + ' not found.' : ''));
  if (damaged.length) {
    out('');
    out('Damaged:');
    damaged.forEach((r) => {
      out('  ' + r.file);
      out('    ' + r.detail);
      if (r.firstErrors && r.firstErrors.length) {
        out('    First decoder errors:');
        r.firstErrors.forEach((line) => out('      ' + line));
      }
    });
  }
  if (errors.length) {
    out('');
    out('Errors:');
    errors.forEach((r) => out('  ' + r.file + ': ' + r.detail));
  }
  if (damaged.length) return 1;
  return errors.length ? 3 : 0;
};

const main = async (argv, deps) => {
  const d = Object.assign({
    run: runTool,
    out: (s) => process.stdout.write(s + '\n'),
    err: (s) => process.stderr.write(s + '\n'),
    onInterrupt: (fn) => {
      process.once('SIGINT', fn);
      return () => process.removeListener('SIGINT', fn);
    },
    killChildren: killAll,
    exit: (code) => {
      process.exitCode = code;
      process.stdout.write('', () => process.exit(code));
    },
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
  const version = await d.run(o.ffprobe, ['-version'], { timeoutMs: 60000 });
  if (failed(version)) {
    d.err('ffprobe is not usable ' + oneLine(why(version, 1)));
    return 2;
  }
  const { files, problems } = collectFiles(o.paths);
  if (!files.length && !problems.length) {
    d.err('No video files found.');
    return 2;
  }
  d.out('Found ' + plural(files.length, 'video file') + '.');

  const results = problems.slice();
  let next = 0;
  let done = 0;
  let interrupted = false;
  let stopping = false; // a call ended with Ctrl+C's exit status
  const interrupt = () => {
    if (interrupted) return;
    interrupted = true;
    d.killChildren();
    d.out('Interrupted.');
    summarise(results, done, d.out);
    d.exit(130);
  };
  const off = d.onInterrupt(interrupt);
  const worker = async () => {
    while (!interrupted && !stopping && next < files.length) {
      const file = files[next++];
      let hit = false;
      const run = async (cmd, args, ropts) => {
        const res = await d.run(cmd, args, ropts);
        if (res && (res.interrupted || res.status === CONTROL_C)) hit = true;
        return res;
      };
      let r;
      try {
        r = await checkFile(file, o, run);
      } catch (e) {
        r = { file, verdict: 'error', detail: oneLine(e.message) };
      }
      if (hit) stopping = true;
      if (interrupted || hit) return;
      results.push(r);
      done++;
      d.out('[' + done + '/' + files.length + '] ' + LABEL[r.verdict].padEnd(7) + ' ' + r.file + '\t' + r.detail);
    }
  };
  await Promise.all(Array.from({ length: Math.min(o.jobs, files.length) }, worker));
  if (stopping) interrupt();
  if (typeof off === 'function') off();
  if (interrupted) return 130;
  return summarise(results, files.length, d.out);
};

if (require.main === module) {
  // Output piped into something that closed early (e.g. Select-Object -First 1): stop quietly.
  process.stdout.on('error', (e) => process.exit(e && e.code === 'EPIPE' ? 0 : 2));
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((e) => {
    process.stderr.write((e && e.message ? e.message : String(e)) + '\n');
    process.exitCode = 2;
  });
}

module.exports = { EXTENSIONS, liveChildren, killAll, oneLine, capLabel, runTool, checkFile, collectFiles, parseArgs, summarise, main };
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
node tools/check-video.js [--all] [-j N] [--timeout MIN] [--ffprobe <path>] <file or folder>...
```

Folders are searched recursively for library video files (`mkv mp4 mov m4v mpg mpeg avi flv webm wmv vob evo m2ts m2t mts ts`); files named directly are checked whatever their extension. Links are followed (loops are detected), and a file given more than once is checked once. The tool prints `Found N video files.`, then one line per file as it finishes, `[i/n] LABEL   path<TAB>detail` (a tab, not " - ", separates the path from the detail, because library names contain " - "), then a summary line, then the damaged files (with the first decoder errors) and any errors again. Error details are always one line. Paths that do not exist are listed under Errors and counted separately (` 1 path not found.`). Press Ctrl+C to stop: it prints `Interrupted.` and the summary so far.

| Verdict | Meaning |
|---------|---------|
| `CLEAN` | standard frame rate, or steady timing |
| `VFR` | timing gaps, but the video decodes cleanly: variable frame rate on purpose |
| `DAMAGED` | timing gaps and decoder errors: frames are missing; replace the file |
| `ERROR` | ffprobe couldn't read, list or decode the file, or timed out, or the output was too large |
| `SKIPPED` | no video stream |

| Option | Default | Description |
|--------|---------|-------------|
| `--all` | off | also check the timing of files whose frame rate is standard (the plugin skips them; slower, but finds damage the plugin can't) |
| `-j`, `--jobs` | `2` | files checked at once; every check reads the whole file, so a big library over the network takes hours |
| `--timeout` | `120` | minutes after which one ffprobe call is given up on and the file is reported as an error (`0` = never) |
| `--ffprobe` | `ffprobe` on PATH | the ffprobe to use; it is tried with `-version` first, and the tool stops with exit code `2` if it does not run |

Exit code: `0` if nothing is damaged and nothing failed; `1` if any file is damaged; `3` if there were errors (including paths not found) but nothing is damaged; `2` for a usage error, when no video files were found, or when ffprobe does not run; `130` after Ctrl+C.

---
```

  (Keep one `---` between sections; check the surrounding separators.) In `## Tests`, mention that the unit tests include `tests/check_video.test.js`.
- [ ] **Step 4:** `node --test tests/*.test.js` (fail 0). Commit `README.md`: "Document the check-video tool" + trailer.
