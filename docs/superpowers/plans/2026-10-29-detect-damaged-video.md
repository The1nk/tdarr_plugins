# Detect Damaged Video Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fail a Tdarr job when the source video is missing frames (timing gaps plus decode errors), and stop Repair Frame Rate from forcing a constant rate onto files whose timing has gaps.

**Architecture:** A new flow plugin, `Tdarr_Plugin_the1nk_detect_damaged_video`, runs first after the filters in all five flows. For files with a non-standard frame rate it lists the video packet timestamps with ffprobe, finds gaps (≥ 1.5× the normal frame interval) and, only if there are gaps, decodes the video once with ffprobe and counts decoder errors. Gaps plus errors set `response.error`, which fails the job. `Tdarr_Plugin_the1nk_repair_framerate` gets a copy of the gap code and skips near-miss files that have gaps.

**Tech Stack:** Node.js (Tdarr classic plugin API), ffprobe 7.1.4 (Tdarr's bundled copy), `tdarr-ffmpeg` (integration fixtures only), `node:test`.

**Spec:** `docs/superpowers/specs/2026-10-28-detect-damaged-video-design.md`. Read it first.

---

## Background (read this first)

- Repo conventions: `CLAUDE.md` and `README.md`. Plugins are single standalone `.js` files in the repo root; they may only `require` Node built-ins and `'../methods/lib'`. `push.ps1` copies only root `*.js`, so `tests/` is never deployed. Work on branch `detect-damaged-video` (already created and checked out). Commit at the end of each task; never push. Every commit message ends with a blank line and then `Claude-Session: https://claude.ai/code/session_016ziVwwvkMXfjNotbAoqpyw`.
- Windows dev box, Git Bash: **never redirect to `/dev/null`** (it creates a file named `NUL`). Run unit tests with `node --test tests/*.test.js` (Node 25 rejects `node --test tests/`).
- How flows run classic plugins (Tdarr node, `FlowHelpers/1.0.0/classicPlugins.js`): `otherArguments` = `{ handbrakePath, ffmpegPath, mkvpropeditPath, originalLibraryFile, nodeHardwareType, pluginCycle, workerType, version, platform_arch_isdocker, cacheFilePath, job }`. If the result has `error`, the runner throws `Plugin <path> failed: <error>` and the job fails. `ffmpegPath` is `tdarr-ffmpeg` on this node; the bundled ffprobe is `/app/Tdarr_Node/assets/app/ffmpeg/linux_x64/ffprobe`.
- Measured facts this plan relies on (Tdarr node, ffprobe/ffmpeg 7.1.4-Jellyfin):
  - `ffprobe -v error -select_streams <i> -count_frames -show_entries stream=nb_read_frames -of csv=p=0 -- <file>` decodes every frame, exits 0 even when the decoder reports errors, and prints one stderr line per decoder error. `ffmpeg -i f -f null -` is NOT usable: its null muxer prints "non monotonically increasing dts" lines for clean variable-rate MKVs.
  - Fixture results (stable across runs; `-threads 1` only pins the encoded bytes, as a precaution, because the decode error count does not depend on decoder or encoder threading; measured on ffmpeg 7.1.4-Jellyfin): `clean.mkv` rate `24/1`; `steady.mkv` rate `72/5`, no gaps; `vfr.mkv` rate `72/5`, one 4042 ms gap after 4.958 s, 0 decode errors; `damaged.mkv` rate `72/5`, gaps of 83 ms at 4.917 s and 4000 ms at 5.000 s, 3 decode errors. `near.mkv` (x264 at 24000/1001, remuxed by `mkvmerge --default-duration 0:23185/967p`) reads as `23185/967`, has steady timing, and repairs to `24000/1001` with 240 packets.
  - Flow JSON files use CRLF line endings except the final `}`, which ends with a bare `\n`. `JSON.stringify(obj, null, 2).replace(/\n/g, '\r\n') + '\n'` reproduces all ten files byte for byte.
- The gap code (`parseTimes`, `findGaps`, `clock`, `plural`, `describeGaps`) must be **identical text** in both plugin files (each plugin stands alone). Tests compare the two copies' behaviour.

## File Structure

- Create `Tdarr_Plugin_the1nk_detect_damaged_video.js`: the new plugin. Exports `details`, `plugin`, `_test`.
- Create `tests/detect_damaged_video.test.js`: unit tests for the new plugin (stubbed `child_process`/`fs`).
- Modify `Tdarr_Plugin_the1nk_repair_framerate.js`: gap code, guard, v1.02, `_test` export.
- Create `tests/repair_framerate.test.js`: unit tests for the guard and the shared-code parity check.
- Create `tests/container/detect_damaged_video.itest.js`: integration test, runs in the `tdarr-node` container.
- Modify `flowMovies.json`, `flowAnimovies.json`, `flowShows.json`, `flowAnishows.json`, `flowOtherVideos.json` and their gitignored `*.local.json` twins: insert the new node.
- Modify `README.md`: flow diagram, ordering rules, plugin docs, tests.

---

### Task 1: Gap analysis helpers (new plugin, pure functions)

**Files:**
- Create: `tests/detect_damaged_video.test.js`
- Create: `Tdarr_Plugin_the1nk_detect_damaged_video.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/detect_damaged_video.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const path = require('path');

// The plugin does require('../methods/lib') (Tdarr's runtime). Stub it for local runs.
// Tests that drive the plugin end to end also swap in fake 'fs' / 'child_process' via `stubs`.
let stubs = null;
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '../methods/lib') {
    return () => ({ loadDefaultValues: (inputs) => inputs || {} });
  }
  if (stubs && Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
  return origLoad.call(this, request, parent, isMain);
};

const pluginModule = require(path.join(__dirname, '..', 'Tdarr_Plugin_the1nk_detect_damaged_video.js'));
const {
  parseTimes, findGaps, clock, describeGaps, damagedMessage, countLines, pickFfprobe, pickVideo,
} = pluginModule._test;

// 24 fps timestamps at a 1 ms timebase (41/42 ms steps, like Matroska), frames [from, to).
const grid = (from, to) => {
  const t = [];
  for (let n = from; n < to; n++) t.push(Math.round((n / 24) * 1000) / 1000);
  return t;
};

test('parseTimes: sorts, drops packets without a timestamp, takes the first CSV field', () => {
  assert.deepStrictEqual(parseTimes('0.083000\r\n0.000000\r\nN/A\r\n0.042000,\r\n\r\n'), [0, 0.042, 0.083]);
  assert.deepStrictEqual(parseTimes(''), []);
  assert.deepStrictEqual(parseTimes(undefined), []);
  assert.deepStrictEqual(parseTimes('nan\ninf\nInfinity\n-Infinity\nN/A\n0.5\n'), [0.5]);
  assert.deepStrictEqual(parseTimes('0.042\n-0.042\n0\n'), [-0.042, 0, 0.042]);
});

test('findGaps: steady 24 fps with 41/42 ms steps has no gaps', () => {
  assert.deepStrictEqual(findGaps(grid(0, 240)), { normal: 0.042, gaps: [], missing: 0 });
});

test('findGaps: one dropped frame (83 ms, under 2x the 42 ms mode) is a gap', () => {
  const times = grid(0, 50).concat(grid(51, 100));
  assert.deepStrictEqual(findGaps(times), { normal: 0.042, gaps: [{ at: 2.042, length: 0.083 }], missing: 0.041 });
});

test('findGaps: a 4 s hole', () => {
  const times = grid(0, 120).concat(grid(216, 240));
  assert.deepStrictEqual(findGaps(times), { normal: 0.042, gaps: [{ at: 4.958, length: 4.042 }], missing: 4 });
});

test('findGaps: positions are measured from the first frame', () => {
  const times = grid(0, 120).concat(grid(216, 240)).map((t) => Math.round((t + 10) * 1000) / 1000);
  const g = findGaps(times);
  assert.strictEqual(g.gaps.length, 1);
  assert.ok(Math.abs(g.gaps[0].at - 4.958) < 1e-9, String(g.gaps[0].at));
});

test('findGaps: too few frames, duplicate timestamps, and ties', () => {
  assert.deepStrictEqual(findGaps([]), { normal: 0, gaps: [], missing: 0 });
  assert.deepStrictEqual(findGaps([1.5]), { normal: 0, gaps: [], missing: 0 });
  // Zero-length intervals never become the normal interval.
  assert.deepStrictEqual(findGaps([0, 0, 0.042, 0.084, 0.084, 0.126]), { normal: 0.042, gaps: [], missing: 0 });
  // 40 and 50 ms twice each: the shorter one wins, and 50 < 1.5 x 40 is not a gap.
  assert.deepStrictEqual(findGaps([0, 0.04, 0.08, 0.13, 0.18]), { normal: 0.04, gaps: [], missing: 0 });
});

test('findGaps: an interval of exactly 1.5x normal is a gap', () => {
  assert.deepStrictEqual(findGaps([0, 0.04, 0.08, 0.12, 0.18]),
    { normal: 0.04, gaps: [{ at: 0.12, length: 0.06 }], missing: 0.02 });
});

test('findGaps: missing time is summed over all gaps', () => {
  const g = findGaps(grid(0, 50).concat(grid(51, 120), grid(216, 240)));
  assert.strictEqual(g.gaps.length, 2);
  assert.ok(Math.abs(g.missing - 4.041) < 1e-9, String(g.missing));
});

test('clock: mm:ss under an hour, h:mm:ss from one hour, seconds rounded down', () => {
  assert.strictEqual(clock(0), '00:00');
  assert.strictEqual(clock(50.98), '00:50');
  assert.strictEqual(clock(75), '01:15');
  assert.strictEqual(clock(3725.9), '1:02:05');
  assert.strictEqual(clock(3600), '1:00:00');
});

test('describeGaps: count, largest (first one on a tie), missing time', () => {
  assert.strictEqual(describeGaps(findGaps(grid(0, 50).concat(grid(51, 100)))),
    '1 timing gap (largest 0.08s at 00:02), about 0.04s of video missing');
  assert.strictEqual(describeGaps({ gaps: [{ at: 10, length: 2 }, { at: 20, length: 2 }], missing: 3.916 }),
    '2 timing gaps (largest 2.00s at 00:10), about 3.9s of video missing');
  assert.strictEqual(describeGaps({ gaps: [{ at: 10, length: 2 }], missing: 0.996 }),
    '1 timing gap (largest 2.00s at 00:10), about 1.0s of video missing');
});

// The gaps measured in the old Space King S01E02 (first frame at 0.021 s).
const e02 = {
  gaps: [[24.40, 0.08], [24.48, 0.5], [50.90, 0.08], [50.98, 4.0], [240.65, 0.08], [240.73, 0.08], [240.81, 4.17]]
    .map(([at, length]) => ({ at: at - 0.021, length })),
  missing: 8.696,
};

test('damagedMessage: the exact job error', () => {
  assert.strictEqual(damagedMessage(e02, 202),
    'Damaged video: 7 timing gaps (largest 4.17s at 04:00), about 8.7s of video missing, and 202 decode errors. '
    + 'The source is missing frames; replace it with a clean copy.');
  assert.match(damagedMessage(e02, 1), /, and 1 decode error\. /);
});

test('countLines: one per non-empty stderr line', () => {
  assert.strictEqual(countLines('[h264 @ 0x1] Missing reference picture, default is 0\r\n\n[h264 @ 0x1] mmco: unref short failure\n'), 2);
  assert.strictEqual(countLines(''), 0);
  assert.strictEqual(countLines(undefined), 0);
});

test('pickFfprobe: bundled, then next to an absolute ffmpegPath, then PATH', () => {
  const P = path.posix;
  const bundled = '/app/Tdarr_Node/assets/app/ffmpeg/linux_x64/ffprobe';
  assert.strictEqual(pickFfprobe('tdarr-ffmpeg', (p) => p === bundled, P), bundled);
  assert.strictEqual(pickFfprobe('/usr/lib/jellyfin-ffmpeg/ffmpeg', (p) => p === '/usr/lib/jellyfin-ffmpeg/ffprobe', P), '/usr/lib/jellyfin-ffmpeg/ffprobe');
  assert.strictEqual(pickFfprobe('C:\\ff\\ffmpeg.exe', (p) => p === 'C:\\ff\\ffprobe.exe', path.win32), 'C:\\ff\\ffprobe.exe');
  assert.strictEqual(pickFfprobe('tdarr-ffmpeg', () => false, P), 'ffprobe');
  assert.strictEqual(pickFfprobe(undefined, () => false, P), 'ffprobe');
});

test('pickVideo: first video stream that is not cover art', () => {
  const streams = [
    { index: 0, codec_type: 'video', disposition: { attached_pic: 1 } },
    { index: 1, codec_type: 'audio' },
    { index: 2, codec_type: 'video', disposition: { attached_pic: 0 } },
  ];
  assert.strictEqual(pickVideo(streams).index, 2);
  assert.strictEqual(pickVideo([streams[0], streams[1]]), undefined);
  assert.strictEqual(pickVideo(undefined), undefined);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/detect_damaged_video.test.js`
Expected: FAIL with `Cannot find module '…Tdarr_Plugin_the1nk_detect_damaged_video.js'`.

- [ ] **Step 3: Write the helpers**

Create `Tdarr_Plugin_the1nk_detect_damaged_video.js`:

```js
/* eslint-disable */

// tdarrSkipTest
const details = () => {
  return {
    id: "Tdarr_Plugin_the1nk_detect_damaged_video",
    Stage: "Pre-processing",
    Name: "Detect damaged video",
    Type: "Video",
    Operation: "Transcode",
    Description: `Fails the job when the video stream is missing frames, so a damaged download never replaces the library file. Only files whose video frame rate is not a standard one are checked (frames lost from a 24 fps file give odd rates like 7016/301). Their video timestamps are listed with ffprobe, and an interval of at least 1.5x the normal frame interval counts as a gap. If there are gaps, the video is decoded once: frames cut out of the stream leave decoder errors ("Missing reference picture"), while a file made variable-frame-rate on purpose (a still scene stored as one long frame) decodes cleanly and is let through. Gaps plus decoder errors fail the job with the number of gaps, the largest one and where it is, the time missing and the error count. The file is only read, never changed. Decoding reads the whole file, so on a file with gaps this step can take a few minutes.`,
    Version: "1.00",
    Tags: "pre-processing,ffprobe,video only",
    Inputs: [],
  };
};

var path = require('path');

// Rates a display can actually lock to (the same list as Repair Frame Rate).
var STD = ['24000/1001', '24/1', '25/1', '30000/1001', '30/1', '50/1', '60000/1001', '60/1', '24000/1000'];
// Tdarr's bundled ffprobe (not on PATH in the Tdarr container).
var BUNDLED_FFPROBE = '/app/Tdarr_Node/assets/app/ffmpeg/linux_x64/ffprobe';

// The bundled ffprobe, then one next to an absolute ffmpegPath, then PATH.
// pathOps defaults to Node's path module (tests pass path.posix / path.win32).
var pickFfprobe = function (ffmpegPath, exists, pathOps) {
  var p = pathOps || path;
  var candidates = [BUNDLED_FFPROBE];
  if (ffmpegPath && p.isAbsolute(ffmpegPath)) {
    candidates.push(p.join(p.dirname(ffmpegPath), 'ffprobe' + p.extname(ffmpegPath)));
  }
  candidates.push('ffprobe');
  return candidates.find(function (c) { return !p.isAbsolute(c) || exists(c); });
};

// First video stream that isn't cover art.
var pickVideo = function (streams) {
  return (streams || []).find(function (s) {
    return s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic);
  });
};

// --- Gaps in the frame timing. Keep identical to the copy in Tdarr_Plugin_the1nk_repair_framerate.js. ---

// ffprobe "packet=pts_time" CSV -> timestamps in seconds, ascending (B-frames arrive out of display
// order). Packets without a timestamp (N/A) are dropped.
var parseTimes = function (csv) {
  return String(csv || '').split(/\r?\n/)
    .map(function (line) { return line.split(',')[0].trim(); })
    .filter(function (v) { return v !== ''; })
    .map(Number)
    .filter(Number.isFinite)
    .sort(function (a, b) { return a - b; });
};

// normal: the most common interval between frames, to the millisecond (ties go to the shorter interval:
// the keys are integers, so they are visited in ascending order and only a strictly higher count replaces the pick).
// A gap is an interval of at least 1.5x normal: millisecond timebases make 24 fps alternate 41/42 ms,
// so one lost frame shows as 83 ms, only 1.98x the 42 ms mode.
// Each gap: at (seconds from the first frame, like a player clock) and length (seconds).
// missing: seconds of video lost (each gap minus one normal interval).
var findGaps = function (times) {
  var counts = {};
  var deltas = [];
  for (var i = 1; i < times.length; i++) {
    var ms = Math.round((times[i] - times[i - 1]) * 1000);
    deltas.push(ms);
    if (ms > 0) counts[ms] = (counts[ms] || 0) + 1;
  }
  var normal = 0;
  var best = 0;
  Object.keys(counts).forEach(function (k) {
    var ms = Number(k);
    if (counts[k] > best) { best = counts[k]; normal = ms; }
  });
  var gaps = [];
  var missingMs = 0;
  if (normal > 0) {
    deltas.forEach(function (ms, j) {
      if (ms >= normal * 1.5) {
        gaps.push({ at: times[j] - times[0], length: ms / 1000 });
        missingMs += ms - normal;
      }
    });
  }
  return { normal: normal / 1000, gaps: gaps, missing: missingMs / 1000 };
};

// 75 -> "01:15", 3725 -> "1:02:05"
var clock = function (seconds) {
  var t = Math.floor(seconds);
  var h = Math.floor(t / 3600);
  var m = Math.floor((t % 3600) / 60);
  var s = t % 60;
  var two = function (n) { return (n < 10 ? '0' : '') + n; };
  return (h ? h + ':' : '') + two(m) + ':' + two(s);
};

var plural = function (n, one, many) { return n + ' ' + (n === 1 ? one : many); };

// "7 timing gaps (largest 4.17s at 04:00), about 8.7s of video missing"
var describeGaps = function (g) {
  var largest = g.gaps.reduce(function (a, b) { return b.length > a.length ? b : a; });
  return plural(g.gaps.length, 'timing gap', 'timing gaps') + ' (largest ' + largest.length.toFixed(2) + 's at '
    + clock(largest.at) + '), about ' + g.missing.toFixed(g.missing < 0.995 ? 2 : 1) + 's of video missing';
};

// --- end of the shared gap code ---

var damagedMessage = function (g, decodeErrors) {
  return 'Damaged video: ' + describeGaps(g) + ', and ' + plural(decodeErrors, 'decode error', 'decode errors')
    + '. The source is missing frames; replace it with a clean copy.';
};

// ffprobe -v error prints one line per decoder error.
var countLines = function (text) {
  return String(text || '').split(/\r?\n/).filter(function (line) { return line.trim() !== ''; }).length;
};

module.exports.details = details;
// Pure helpers, exported for tests/detect_damaged_video.test.js. Tdarr only uses details and plugin.
module.exports._test = {
  STD: STD,
  pickFfprobe: pickFfprobe,
  pickVideo: pickVideo,
  parseTimes: parseTimes,
  findGaps: findGaps,
  clock: clock,
  describeGaps: describeGaps,
  damagedMessage: damagedMessage,
  countLines: countLines,
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/detect_damaged_video.test.js`
Expected: all tests PASS (`# fail 0`).

- [ ] **Step 5: Commit**

```bash
git add Tdarr_Plugin_the1nk_detect_damaged_video.js tests/detect_damaged_video.test.js
git commit -F - <<'EOF'
Add gap analysis for the Detect Damaged Video plugin

Claude-Session: https://claude.ai/code/session_016ziVwwvkMXfjNotbAoqpyw
EOF
```

---

### Task 2: The plugin itself (new plugin, end to end)

**Files:**
- Modify: `Tdarr_Plugin_the1nk_detect_damaged_video.js` (add `plugin`, export it)
- Modify: `tests/detect_damaged_video.test.js` (append)

- [ ] **Step 1: Write the failing tests**

First add `tail` to the destructured import at the top of the test file (`..., countLines, tail, pickFfprobe, pickVideo,`) and this test after the `countLines` test:

```js
test('tail: short text is unchanged; long text keeps the last 20 lines and 2000 characters', () => {
  assert.strictEqual(tail('a\nb\n'), 'a\nb');
  const lines = Array.from({ length: 25 }, (_, n) => 'line ' + (n + 1));
  assert.strictEqual(tail(lines.join('\n')), '(5 earlier lines left out) ' + lines.slice(5).join('\n'));
  assert.strictEqual(tail('x'.repeat(3000) + 'y'.repeat(2000)), 'y'.repeat(2000));
});
```

Then append to `tests/detect_damaged_video.test.js`:

```js
// --- plugin(), with ffprobe stubbed ---

const csv = (times) => times.map((t) => t.toFixed(6)).join('\n') + '\n';
const steady = csv(grid(0, 240));
const holed = csv(grid(0, 120).concat(grid(216, 240)));
const LIST_ARGS = ['-v', 'error', '-select_streams', '0', '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', '--', '/m/a.mkv'];
const DECODE_ARGS = ['-v', 'repeat+error', '-select_streams', '0', '-count_frames', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', '--', '/m/a.mkv'];

const run = (cfg) => {
  const c = Object.assign({
    streams: [{ index: 0, codec_type: 'video', r_frame_rate: '7016/301' }, { index: 1, codec_type: 'audio' }],
    listing: { status: 0, stdout: steady, stderr: '' },
    decode: { status: 0, stdout: '144\n', stderr: '' },
  }, cfg);
  const calls = [];
  stubs = {
    fs: { existsSync: () => false },
    child_process: {
      spawnSync: (cmd, args) => {
        calls.push([cmd].concat(args));
        if (args.includes('packet=pts_time')) return c.listing;
        if (args.includes('-count_frames')) return c.decode;
        throw new Error('unexpected call: ' + cmd + ' ' + args.join(' '));
      },
    },
  };
  try {
    const file = { _id: '/m/a.mkv', file: '/m/a.mkv', container: 'mkv', ffProbeData: { streams: c.streams } };
    const res = pluginModule.plugin(file, {}, {}, { cacheFilePath: '/w/a.mkv', ffmpegPath: 'tdarr-ffmpeg', mkvpropeditPath: 'mkvpropedit' });
    return { res, calls, file };
  } finally {
    stubs = null;
  }
};

test('plugin: no video stream (only cover art) -> continues without running anything', () => {
  const { res, calls } = run({ streams: [{ index: 0, codec_type: 'video', r_frame_rate: '90000/1', disposition: { attached_pic: 1 } }] });
  assert.strictEqual(res.error, undefined);
  assert.strictEqual(res.infoLog, 'No video stream found, skipping.\r\n');
  assert.deepStrictEqual(calls, []);
});

test('plugin: standard frame rate -> continues without running anything', () => {
  const { res, calls } = run({ streams: [{ index: 0, codec_type: 'video', r_frame_rate: '24000/1001' }] });
  assert.strictEqual(res.error, undefined);
  assert.strictEqual(res.infoLog, 'Frame rate already standard (24000/1001), skipping.\r\n');
  assert.deepStrictEqual(calls, []);
});

test('plugin: odd rate with steady timing -> one timestamp listing, no decode, continues', () => {
  const { res, calls, file } = run({});
  assert.strictEqual(res.error, undefined);
  assert.strictEqual(res.infoLog, 'Frame rate 7016/301 is not standard, but the frame timing is steady (no gaps). Continuing.\r\n');
  assert.deepStrictEqual(calls, [['ffprobe'].concat(LIST_ARGS)]);
  assert.strictEqual(res.processFile, false);
  assert.strictEqual(res.file, file);
});

test('plugin: probes the video stream by its index, past cover art', () => {
  const { calls } = run({ streams: [
    { index: 0, codec_type: 'video', r_frame_rate: '90000/1', disposition: { attached_pic: 1 } },
    { index: 1, codec_type: 'video', r_frame_rate: '7016/301' },
  ] });
  assert.deepStrictEqual(calls[0].slice(3, 5), ['-select_streams', '1']);
});

test('plugin: gaps that decode cleanly are deliberate VFR -> continues', () => {
  const { res, calls } = run({ listing: { status: 0, stdout: holed, stderr: '' } });
  assert.strictEqual(res.error, undefined);
  assert.strictEqual(res.infoLog, 'Frame rate 7016/301: 1 timing gap (largest 4.04s at 00:04), about 4.0s of video missing, '
    + 'but the video decodes cleanly, so it was made variable-frame-rate on purpose. Continuing.\r\n');
  assert.deepStrictEqual(calls, [['ffprobe'].concat(LIST_ARGS), ['ffprobe'].concat(DECODE_ARGS)]);
});

test('plugin: gaps plus decoder errors fail the job with the reason', () => {
  const stderr = '[h264 @ 0x1] Missing reference picture, default is 0\n[h264 @ 0x1] mmco: unref short failure\n';
  const { res, file } = run({ listing: { status: 0, stdout: holed, stderr: '' }, decode: { status: 0, stdout: '144\n', stderr } });
  const msg = 'Damaged video: 1 timing gap (largest 4.04s at 00:04), about 4.0s of video missing, and 2 decode errors. '
    + 'The source is missing frames; replace it with a clean copy.';
  assert.strictEqual(res.error, msg);
  assert.strictEqual(res.infoLog, msg + '\r\n');
  assert.strictEqual(res.processFile, false);
  assert.strictEqual(res.file, file);
});

test('plugin: a failed timestamp listing fails the job', () => {
  const { res } = run({ listing: { status: 1, stdout: '', stderr: 'Invalid data found when processing input' } });
  assert.strictEqual(res.error, 'Detect damaged video: ffprobe could not list the video timestamps (exit 1): Invalid data found when processing input');
});

test('plugin: ffprobe that cannot be started fails the job', () => {
  const { res } = run({ listing: { error: new Error('spawnSync ffprobe ENOENT'), status: null, signal: null } });
  assert.strictEqual(res.error, 'Detect damaged video: ffprobe could not list the video timestamps (not started): spawnSync ffprobe ENOENT');
});

test('plugin: a killed decode fails the job', () => {
  const { res } = run({ listing: { status: 0, stdout: holed, stderr: '' }, decode: { status: null, signal: 'SIGKILL', stdout: '', stderr: '' } });
  assert.strictEqual(res.error, 'Detect damaged video: ffprobe could not decode the video (signal SIGKILL): signal SIGKILL');
});

test('plugin: listing with no usable timestamps fails the job instead of passing as steady', () => {
  const { res, calls } = run({ listing: { status: 0, stdout: 'N/A\nN/A\n', stderr: '' } });
  assert.strictEqual(res.error, 'Detect damaged video: ffprobe listed too few usable video timestamps (0 found)');
  assert.strictEqual(calls.length, 1);
});

test('plugin: long tool output in an error is cut to its last 20 lines', () => {
  const stderr = Array.from({ length: 30 }, (_, n) => 'err ' + (n + 1)).join('\n');
  const { res } = run({ listing: { status: 1, stdout: '', stderr } });
  assert.ok(res.error.includes('(10 earlier lines left out) err 11\n'));
  assert.ok(res.error.endsWith('err 30'));
});

test('plugin: without a numeric stream index, selects v:<video streams before it>', () => {
  const { calls } = run({ streams: [
    { codec_type: 'video', r_frame_rate: '90000/1', disposition: { attached_pic: 1 } },
    { codec_type: 'video', r_frame_rate: '7016/301' },
  ] });
  assert.deepStrictEqual(calls[0].slice(3, 5), ['-select_streams', 'v:1']);
});

test('plugin: a decode that exits non-zero fails the job', () => {
  const { res } = run({ listing: { status: 0, stdout: holed, stderr: '' }, decode: { status: 1, stdout: '', stderr: 'boom' } });
  assert.strictEqual(res.error, 'Detect damaged video: ffprobe could not decode the video (exit 1): boom');
});

test('plugin: works without otherArguments, using ffprobe from PATH', () => {
  const seen = {};
  stubs = {
    fs: { existsSync: () => false },
    child_process: { spawnSync: (cmd) => { seen.cmd = cmd; return { status: 0, stdout: steady, stderr: '' }; } },
  };
  try {
    const file = { _id: '/m/a.mkv', container: 'mkv', ffProbeData: { streams: [{ index: 0, codec_type: 'video', r_frame_rate: '7016/301' }] } };
    const res = pluginModule.plugin(file, {}, {}, undefined);
    assert.strictEqual(res.error, undefined);
    assert.strictEqual(seen.cmd, 'ffprobe');
    assert.match(res.infoLog, /steady/);
  } finally {
    stubs = null;
  }
});

test('plugin: a missing frame rate is labelled unknown', () => {
  const { res } = run({ streams: [{ index: 0, codec_type: 'video' }] });
  assert.strictEqual(res.infoLog, 'Frame rate unknown is not standard, but the frame timing is steady (no gaps). Continuing.\r\n');
});
```

- [ ] **Step 2: Run the tests to verify the new ones fail**

Run: `node --test tests/detect_damaged_video.test.js`
Expected: the new `tail:` test and the `plugin:` tests FAIL with `pluginModule.plugin is not a function`; the Task 1 tests still pass.

- [ ] **Step 3: Write `plugin`**

In `Tdarr_Plugin_the1nk_detect_damaged_video.js`, insert this between the `countLines` definition and `module.exports.details = details;`:

```js
// Last 20 non-empty lines and at most 2000 characters of tool output, so an error or log stays readable.
var tail = function (text) {
  var lines = String(text || '').split(/\r?\n/).filter(function (line) { return line.trim() !== ''; });
  var dropped = Math.max(0, lines.length - 20);
  var out = lines.slice(dropped).join('\n');
  if (out.length > 2000) out = out.slice(-2000);
  return (dropped ? '(' + dropped + ' earlier lines left out) ' : '') + out;
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars
var plugin = function (file, librarySettings, inputs, otherArguments) {
  var lib = require('../methods/lib')();
  // eslint-disable-next-line @typescript-eslint/no-unused-vars,no-param-reassign
  inputs = lib.loadDefaultValues(inputs, details);
  var fs = require('fs');
  var spawnSync = require('child_process').spawnSync;

  var response = {
    file: file,
    removeFromDB: false,
    updateDB: false,
    infoLog: '',
    processFile: false,
    preset: '',
    container: '.' + file.container,
    handBrakeMode: false,
    FFmpegMode: false,
  };

  // A badly damaged file can print thousands of error lines; leave room so maxBuffer never trips.
  var run = function (cmd, args) {
    return spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  };
  var exitOf = function (r) {
    if (r.signal) return 'signal ' + r.signal;
    return r.error && r.status == null ? 'not started' : 'exit ' + r.status;
  };
  var why = function (r) { return tail(r.error ? r.error.message : (r.stderr || r.stdout || exitOf(r))); };

  try {
    var video = pickVideo(file.ffProbeData && file.ffProbeData.streams);
    if (!video) {
      response.infoLog += 'No video stream found, skipping.\r\n';
      return response;
    }
    var rate = video.r_frame_rate || 'unknown';
    if (STD.indexOf(rate) !== -1) {
      response.infoLog += 'Frame rate already standard (' + rate + '), skipping.\r\n';
      return response;
    }

    var ffprobe = pickFfprobe((otherArguments || {}).ffmpegPath, fs.existsSync);
    var stream;
    if (typeof video.index === 'number') {
      stream = String(video.index);
    } else {
      // ffprobe's v:N counts cover art too.
      var before = file.ffProbeData.streams.slice(0, file.ffProbeData.streams.indexOf(video));
      stream = 'v:' + before.filter(function (s) { return s.codec_type === 'video'; }).length;
    }

    var list = run(ffprobe, ['-v', 'error', '-select_streams', stream, '-show_entries', 'packet=pts_time',
      '-of', 'csv=p=0', '--', file._id]);
    if (list.error || list.status !== 0) {
      throw new Error('ffprobe could not list the video timestamps (' + exitOf(list) + '): ' + why(list));
    }
    var times = parseTimes(list.stdout);
    if (times.length < 2) {
      throw new Error('ffprobe listed too few usable video timestamps (' + times.length + ' found)');
    }
    var g = findGaps(times);
    if (!g.gaps.length) {
      response.infoLog += 'Frame rate ' + rate + ' is not standard, but the frame timing is steady (no gaps). Continuing.\r\n';
      return response;
    }

    // Decode every frame. "repeat+" keeps ffmpeg from folding repeated errors into "Last message repeated
    // N times". ffprobe has no muxer (unlike "ffmpeg -f null"), so it never complains about a variable-rate
    // file's timestamps: every stderr line is a decoder error.
    var dec = run(ffprobe, ['-v', 'repeat+error', '-select_streams', stream, '-count_frames',
      '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', '--', file._id]);
    if (dec.error || dec.status !== 0) {
      throw new Error('ffprobe could not decode the video (' + exitOf(dec) + '): ' + why(dec));
    }
    var errors = countLines(dec.stderr);
    if (errors === 0) {
      response.infoLog += 'Frame rate ' + rate + ': ' + describeGaps(g)
        + ', but the video decodes cleanly, so it was made variable-frame-rate on purpose. Continuing.\r\n';
      return response;
    }

    var msg = damagedMessage(g, errors);
    response.infoLog += msg + '\r\n';
    response.error = msg;
    return response;
  } catch (err) {
    console.log(err);
    response.infoLog += 'Error: ' + err.message + '\r\n';
    // Letting the file through unchecked would defeat the check, so fail the job with the reason.
    response.error = 'Detect damaged video: ' + err.message;
    return response;
  }
};
```

and change the export block so it also exports `plugin`:

```js
module.exports.details = details;
module.exports.plugin = plugin;
```

and add `tail: tail,` to the `module.exports._test = { … }` block (after `countLines`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/*.test.js`
Expected: every test PASSES (`# fail 0`), including the existing `convert_unsupported_subs` tests.

- [ ] **Step 5: Commit**

```bash
git add Tdarr_Plugin_the1nk_detect_damaged_video.js tests/detect_damaged_video.test.js
git commit -F - <<'EOF'
Fail the job when the video is missing frames

Claude-Session: https://claude.ai/code/session_016ziVwwvkMXfjNotbAoqpyw
EOF
```

---

### Task 3: Repair Frame Rate skips near-miss files with gaps

**Files:**
- Create: `tests/repair_framerate.test.js`
- Modify: `Tdarr_Plugin_the1nk_repair_framerate.js` (description/version lines 11–12, after `toFps` line 37, lines 101–118, exports at the end)

- [ ] **Step 1: Write the failing tests**

Create `tests/repair_framerate.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const path = require('path');
const fs = require('fs');

// The plugins do require('../methods/lib') (Tdarr's runtime). Stub it for local runs.
// Tests that drive the plugin end to end also swap in fake 'fs' / 'child_process' via `stubs`.
let stubs = null;
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '../methods/lib') {
    return () => ({ loadDefaultValues: (inputs) => inputs || {} });
  }
  if (stubs && Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
  return origLoad.call(this, request, parent, isMain);
};

const repair = require(path.join(__dirname, '..', 'Tdarr_Plugin_the1nk_repair_framerate.js'));
const detect = require(path.join(__dirname, '..', 'Tdarr_Plugin_the1nk_detect_damaged_video.js'));

// 24 fps timestamps at a 1 ms timebase (41/42 ms steps, like Matroska), frames [from, to).
const grid = (from, to) => {
  const t = [];
  for (let n = from; n < to; n++) t.push(Math.round((n / 24) * 1000) / 1000);
  return t;
};
const csv = (times) => times.map((t) => t.toFixed(6)).join('\n') + '\n';
const LIST_ARGS = ['-v', 'error', '-select_streams', '0', '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', '--', '/m/a.mkv'];

// 23185/967 is 0.0002 fps from 24000/1001: a near-miss.
const run = (cfg) => {
  const c = Object.assign({ rate: '23185/967', listing: { status: 0, stdout: csv(grid(0, 240)), stderr: '' },
    other: { cacheFilePath: '/w/a.mkv', mkvpropeditPath: 'mkvpropedit' } }, cfg);
  const calls = [];
  stubs = {
    fs: { existsSync: () => false, unlinkSync: () => {} },
    child_process: {
      spawnSync: (cmd, args) => {
        calls.push([cmd].concat(args));
        if (args.includes('packet=pts_time')) return c.listing;
        // Stop the repair at its first mkvmerge call: reaching it proves the guard let the file through.
        if (cmd === 'mkvmerge' && args[0] === '-J') return { status: 2, stdout: 'stopped by test', stderr: '' };
        throw new Error('unexpected call: ' + cmd + ' ' + args.join(' '));
      },
    },
  };
  try {
    const file = { _id: '/m/a.mkv', file: '/m/a.mkv', container: 'mkv',
      ffProbeData: { streams: c.streams || [{ index: 0, codec_type: 'video', r_frame_rate: c.rate }] } };
    const res = repair.plugin(file, {}, { max_delta_fps: 0.05 }, c.other);
    return { res, calls };
  } finally {
    stubs = null;
  }
};

test('repair: near-miss with steady timing goes on to mkvmerge as before', () => {
  const { res, calls } = run({});
  assert.deepStrictEqual(calls.map((x) => x[0]), ['ffprobe', 'mkvmerge']);
  assert.deepStrictEqual(calls[0].slice(1), LIST_ARGS);
  assert.match(res.infoLog, /mkvmerge identify failed \(mkvmerge\): stopped by test/);
});

test('repair: near-miss with gaps is skipped before mkvmerge', () => {
  const { res, calls } = run({ listing: { status: 0, stdout: csv(grid(0, 50).concat(grid(51, 100))), stderr: '' } });
  assert.strictEqual(res.infoLog, 'Near-miss rate 23185/967, but found 1 timing gap (largest 0.08s at 00:02), '
    + 'about 0.04s of video missing. Forcing a constant rate would desync audio. Skipping.\r\n');
  assert.deepStrictEqual(calls.map((x) => x[0]), ['ffprobe']);
  assert.strictEqual(res.file._id, '/m/a.mkv');
});

test('repair: outside a flow, a near-miss is skipped before anything is read', () => {
  const { res, calls } = run({ other: undefined });
  assert.strictEqual(res.infoLog, 'No cacheFilePath provided (not running in a flow?), skipping.\r\n');
  assert.deepStrictEqual(calls, []);
});

test('repair: a far-off rate is still skipped without probing', () => {
  const { res, calls } = run({ rate: '7016/301' });
  assert.match(res.infoLog, /Not a near-miss; repairing would change playback speed\. Skipping\./);
  assert.deepStrictEqual(calls, []);
});

test('repair: a failed timestamp listing leaves the original untouched', () => {
  const { res, calls } = run({ listing: { status: 1, stdout: '', stderr: 'boom' } });
  assert.strictEqual(res.infoLog, 'Error: ffprobe could not list the video timestamps (exit 1): boom. Original left untouched.\r\n');
  assert.deepStrictEqual(calls.map((x) => x[0]), ['ffprobe']);
  assert.strictEqual(res.error, undefined);
});

test('repair: an ffprobe failure message is trimmed, and says so when there is no output', () => {
  const msg = (why) => 'Error: ffprobe could not list the video timestamps (' + why + '. Original left untouched.\r\n';
  assert.strictEqual(run({ listing: { status: 1, stdout: '', stderr: 'boom\n' } }).res.infoLog, msg('exit 1): boom'));
  assert.strictEqual(run({ listing: { status: 1, stdout: '', stderr: '' } }).res.infoLog, msg('exit 1): no output'));
  assert.strictEqual(run({ listing: { status: null, signal: 'SIGKILL', stdout: '', stderr: '' } }).res.infoLog, msg('signal SIGKILL): no output'));
});

test('repair: ffprobe that cannot be started leaves the original untouched', () => {
  const { res } = run({ listing: { error: new Error('spawnSync ffprobe ENOENT'), status: null, signal: null } });
  assert.strictEqual(res.infoLog, 'Error: ffprobe could not list the video timestamps (not started): spawnSync ffprobe ENOENT. Original left untouched.\r\n');
});

test('repair: too few usable timestamps means the timing cannot be checked, so no repair', () => {
  const { res, calls } = run({ listing: { status: 0, stdout: 'N/A\nN/A\n', stderr: '' } });
  assert.strictEqual(res.infoLog, 'Near-miss rate 23185/967, but ffprobe listed too few usable video timestamps (0 found), '
    + 'so the timing cannot be checked. Skipping.\r\n');
  assert.deepStrictEqual(calls.map((x) => x[0]), ['ffprobe']);
});

test('repair: without a numeric stream index, selects the video by its position among video streams', () => {
  const { calls } = run({
    listing: { status: 0, stdout: csv(grid(0, 50).concat(grid(51, 100))), stderr: '' },
    streams: [
      { codec_type: 'video', r_frame_rate: '90000/1', disposition: { attached_pic: 1 } },
      { codec_type: 'video', r_frame_rate: '23185/967' },
    ],
  });
  assert.deepStrictEqual(calls[0].slice(3, 5), ['-select_streams', 'v:1']);
});

test('repair: the verification gate probes the same video stream the gap check used', () => {
  const calls = [];
  stubs = {
    fs: { existsSync: (p) => p === '/w/a.mkv', unlinkSync: () => {} },
    child_process: {
      spawnSync: (cmd, args) => {
        calls.push([cmd].concat(args));
        if (cmd === 'ffprobe' && args.includes('packet=pts_time')) return { status: 0, stdout: csv(grid(0, 240)), stderr: '' };
        if (cmd === 'mkvmerge' && args[0] === '-J') return { status: 0, stdout: JSON.stringify({ tracks: [{ id: 1, type: 'video' }] }), stderr: '' };
        if (cmd === 'mkvmerge') return { status: 0, stdout: '', stderr: '' };
        if (cmd === 'ffprobe') {
          return { status: 0, stderr: '', stdout: JSON.stringify({ streams: [{ codec_name: 'h264', pix_fmt: 'yuv420p',
            r_frame_rate: args.includes('/m/a.mkv') ? '23185/967' : '24000/1001', nb_read_packets: '240' }], format: { duration: '10' } }) };
        }
        throw new Error('unexpected call: ' + cmd);
      },
    },
  };
  let res;
  try {
    const file = { _id: '/m/a.mkv', file: '/m/a.mkv', container: 'mkv', ffProbeData: { streams: [
      { index: 0, codec_type: 'video', r_frame_rate: '90000/1', disposition: { attached_pic: 1 } },
      { index: 1, codec_type: 'video', r_frame_rate: '23185/967' },
    ] } };
    res = repair.plugin(file, {}, { max_delta_fps: 0.05 }, { cacheFilePath: '/w/a.mkv', mkvpropeditPath: 'mkvpropedit' });
  } finally {
    stubs = null;
  }
  assert.match(res.infoLog, /Verified:/);
  const probes = calls.filter((x) => x[0] === 'ffprobe');
  assert.strictEqual(probes.length, 3);
  probes.forEach((x) => assert.strictEqual(x[x.indexOf('-select_streams') + 1], '1'));
});

test('repair: an ffprobe failure in the verification gate is reported with its status and trimmed text', () => {
  stubs = {
    fs: { existsSync: (p) => p === '/w/a.mkv', unlinkSync: () => {} },
    child_process: {
      spawnSync: (cmd, args) => {
        if (args.includes('packet=pts_time')) return { status: 0, stdout: csv(grid(0, 240)), stderr: '' };
        if (cmd === 'mkvmerge' && args[0] === '-J') return { status: 0, stdout: JSON.stringify({ tracks: [{ id: 0, type: 'video' }] }), stderr: '' };
        if (cmd === 'mkvmerge') return { status: 0, stdout: '', stderr: '' };
        if (args.includes('-count_packets')) return { status: 1, stdout: '', stderr: 'bad file\n' };
        throw new Error('unexpected call: ' + cmd);
      },
    },
  };
  let res;
  try {
    const file = { _id: '/m/a.mkv', file: '/m/a.mkv', container: 'mkv',
      ffProbeData: { streams: [{ index: 0, codec_type: 'video', r_frame_rate: '23185/967' }] } };
    res = repair.plugin(file, {}, { max_delta_fps: 0.05 }, { cacheFilePath: '/w/a.mkv', mkvpropeditPath: 'mkvpropedit' });
  } finally {
    stubs = null;
  }
  assert.ok(res.infoLog.includes('Error: ffprobe failed on /m/a.mkv (exit 1): bad file. Original left untouched.'), res.infoLog);
});

// Each plugin file must stand alone, so the gap code exists twice. Both copies must agree.
test('shared gap code: the source text of both copies is identical', () => {
  const extract = (file) => {
    const text = fs.readFileSync(path.join(__dirname, '..', file), 'utf8').replace(/\r\n/g, '\n');
    const from = text.search(/^\/\/ --- Gaps in the frame timing/m);
    const endMark = '// --- end of the shared gap code ---';
    const to = text.indexOf(endMark);
    assert.ok(from >= 0 && to > from, file + ': markers not found');
    return text.slice(from, to + endMark.length).split('\n').slice(1).join('\n');
  };
  const a = extract('Tdarr_Plugin_the1nk_repair_framerate.js');
  const b = extract('Tdarr_Plugin_the1nk_detect_damaged_video.js');
  assert.ok(a.length > 0);
  assert.strictEqual(a, b);
});

test('shared gap code: both plugins give the same results', () => {
  const r = repair._test;
  const d = detect._test;
  const inputs = [
    '',
    '1.5\n',
    csv(grid(0, 240)),
    csv(grid(0, 50).concat(grid(51, 100))),
    csv(grid(0, 50).concat(grid(51, 100), grid(101, 150))),
    csv(grid(0, 120).concat(grid(216, 240))),
    '0.083000\r\n0.000000\r\nN/A\r\n0.042000,\r\n',
    '0\n0.04\n0.08\n0.13\n0.18\n',
  ];
  inputs.forEach((text) => {
    assert.deepStrictEqual(r.parseTimes(text), d.parseTimes(text), JSON.stringify(text));
    const g = r.findGaps(r.parseTimes(text));
    assert.deepStrictEqual(g, d.findGaps(d.parseTimes(text)), JSON.stringify(text));
    if (g.gaps.length) assert.strictEqual(r.describeGaps(g), d.describeGaps(g));
  });
  [0, 50.98, 75, 3725.9].forEach((s) => assert.strictEqual(r.clock(s), d.clock(s)));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/repair_framerate.test.js`
Expected: FAIL. The steady/gappy/listing/not-started/no-timestamps/stream-position/no-flow/failure-message/verification-stream tests fail because no `ffprobe` call happens before `mkvmerge`; the parity test fails with `Cannot read properties of undefined (reading 'parseTimes')` (no `_test` export yet). The far-off test passes already.

- [ ] **Step 3: Implement the guard**

In `Tdarr_Plugin_the1nk_repair_framerate.js`:

(a) Replace the `Description` and `Version` lines (11–12) with:

```js
    Description: `Losslessly repairs malformed MKV frame-rate metadata (e.g. 23185/967 instead of 24000/1001) that makes files stutter on devices like the Fire TV 4K Max. Remuxes with mkvmerge, setting the default duration to the nearest standard rate and fixing bitstream timing. Files whose frame timing has gaps (frames missing) are never repaired: forcing a constant rate would close the gaps by sliding the video out of sync with the audio. The result is verified (rate, codec, pixel format, duration, video packet count) before it is used; on any failure the file is left untouched. Flow-only: runs mkvmerge itself and hands the repaired file to the next flow plugin.`,
    Version: "1.02",
```

(b) Directly after the `toFps` definition (after line 37, before the `// eslint-disable-next-line` line above `const plugin`), insert the shared gap code, **copied character for character** from the block in `Tdarr_Plugin_the1nk_detect_damaged_video.js` that starts at `// --- Gaps in the frame timing.` and ends at `// --- end of the shared gap code ---`, except that the first comment line names the other file:

```js
// --- Gaps in the frame timing. Keep identical to the copy in Tdarr_Plugin_the1nk_detect_damaged_video.js. ---
```

(c) Replace lines 101–118 (from `if (delta >= inputs.max_delta_fps) {` through the line `var ffprobe = FFPROBE_CANDIDATES.find(…);`) with the block below. The `cacheFilePath` check now comes right after the near-miss test, so a run outside a flow never reads the file; the mkvmerge path lines stay after the guard:

```js
    if (delta >= inputs.max_delta_fps) {
      response.infoLog += 'Frame rate ' + rate + ' (' + fps.toFixed(3) + ' fps) is ' + delta.toFixed(3)
        + ' fps from nearest standard ' + target + ' (limit ' + inputs.max_delta_fps + '). '
        + 'Not a near-miss; repairing would change playback speed. Skipping.\r\n';
      return response;
    }

    if (!otherArguments || !otherArguments.cacheFilePath) {
      response.infoLog += 'No cacheFilePath provided (not running in a flow?), skipping.\r\n';
      return response;
    }

    var ffprobe = FFPROBE_CANDIDATES.find(function (c) { return !path.isAbsolute(c) || fs.existsSync(c); });

    // Frames missing from the stream also give a near-miss rate (24 fps missing 1 frame in 600 is 23.96).
    // Forcing a constant rate would close those holes by sliding the video out of sync with the audio.
    var stream;
    if (typeof video.index === 'number') {
      stream = String(video.index);
    } else {
      // ffprobe's v:N counts cover art too.
      var earlier = streams.slice(0, streams.indexOf(video));
      stream = 'v:' + earlier.filter(function (s) { return s.codec_type === 'video'; }).length;
    }
    var list = spawnSync(ffprobe, ['-v', 'error', '-select_streams', stream, '-show_entries', 'packet=pts_time',
      '-of', 'csv=p=0', '--', file._id], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    if (list.error || list.status !== 0) {
      throw new Error('ffprobe could not list the video timestamps (' + failureText(list));
    }
    var times = parseTimes(list.stdout);
    if (times.length < 2) {
      response.infoLog += 'Near-miss rate ' + rate + ', but ffprobe listed too few usable video timestamps ('
        + times.length + ' found), so the timing cannot be checked. Skipping.\r\n';
      return response;
    }
    var timing = findGaps(times);
    if (timing.gaps.length) {
      response.infoLog += 'Near-miss rate ' + rate + ', but found ' + describeGaps(timing)
        + '. Forcing a constant rate would desync audio. Skipping.\r\n';
      return response;
    }

    // mkvmerge ships alongside mkvpropedit (mkvtoolnix).
    var propedit = (otherArguments.mkvpropeditPath || 'mkvpropedit');
    var mkvmerge = path.join(path.dirname(propedit), path.basename(propedit).replace('mkvpropedit', 'mkvmerge'));
    if (path.dirname(propedit) === '.') mkvmerge = path.basename(mkvmerge);
```

(The old `var ffprobe = …` that sat after the mkvmerge lines is removed; it now comes before the guard. The old `cacheFilePath` check moved up, ahead of it.)

(c2) In the verification gate, the `info` helper must probe the same video the guard checked. Replace `var info = function (p) {` and its first line `var j = probe(['-select_streams', 'v:0', '-count_packets',` with:

```js
    // Same selector for source and output: mkvmerge keeps the track order, so it names the same video in both.
    var info = function (p) {
      var j = probe(['-select_streams', stream, '-count_packets',
```

(c3) The guard and the verification gate share one helper for failed ffprobe runs. Directly before `var outPath = '';` add:

```js
  // Rest of a failed spawnSync message, after the opening "(": "<status>): <trimmed output>".
  var failureText = function (r) {
    return (r.error && r.status === null && !r.signal ? 'not started'
      : r.signal ? 'signal ' + r.signal : 'exit ' + r.status) + '): '
      + String(r.error ? r.error.message : (r.stderr || r.stdout || 'no output')).trim().slice(-2000);
  };

```

The guard's error then reads `throw new Error('ffprobe could not list the video timestamps (' + failureText(list));` (already so in the block above). In the verification gate's `probe`, replace the `throw new Error('ffprobe failed on ' + p + ': ' + ...)` with `throw new Error('ffprobe failed on ' + p + ' (' + failureText(r));`.

(d) At the end of the file, after `module.exports.plugin = plugin;`, add:

```js
// Pure helpers, exported for tests/repair_framerate.test.js. Tdarr only uses details and plugin.
module.exports._test = {
  parseTimes: parseTimes,
  findGaps: findGaps,
  clock: clock,
  describeGaps: describeGaps,
};
```

- [ ] **Step 4: Check the two copies are identical**

Run (Git Bash, repo root):

```bash
diff <(sed -n '/^\/\/ --- Gaps in the frame timing/,/^\/\/ --- end of the shared gap code ---/p' Tdarr_Plugin_the1nk_detect_damaged_video.js | tail -n +2) \
     <(sed -n '/^\/\/ --- Gaps in the frame timing/,/^\/\/ --- end of the shared gap code ---/p' Tdarr_Plugin_the1nk_repair_framerate.js | tail -n +2) && echo IDENTICAL
```

Expected: `IDENTICAL` (only the first comment line, which names the other file, is excluded).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/*.test.js`
Expected: every test PASSES (`# fail 0`).

- [ ] **Step 6: Commit**

```bash
git add Tdarr_Plugin_the1nk_repair_framerate.js tests/repair_framerate.test.js
git commit -F - <<'EOF'
Never force a constant frame rate onto video with timing gaps

Claude-Session: https://claude.ai/code/session_016ziVwwvkMXfjNotbAoqpyw
EOF
```

---

### Task 4: Integration test in the Tdarr node

**Files:**
- Create: `tests/container/detect_damaged_video.itest.js`

- [ ] **Step 1: Write the integration test**

Create `tests/container/detect_damaged_video.itest.js`:

```js
// Integration test: runs the real Detect Damaged Video and Repair Frame Rate plugins, with Tdarr's real
// methods/lib, FFmpeg and ffprobe, against small videos it builds itself: clean, steady at an odd rate,
// variable-frame-rate on purpose, and damaged (frames cut out of the encoded stream). Run it inside the
// tdarr-node container (see README "Tests"). It writes only under /tmp/itest.
//
// Stage the files (from the repo root, Git Bash; MSYS_NO_PATHCONV stops container paths being rewritten):
//   MSYS_NO_PATHCONV=1 docker exec tdarr-node sh -c 'rm -rf /tmp/itest && mkdir -p /tmp/itest/plugins/Local && ln -s /app/Tdarr_Node/assets/app/plugins/methods /tmp/itest/plugins/methods'
//   MSYS_NO_PATHCONV=1 docker cp Tdarr_Plugin_the1nk_detect_damaged_video.js tdarr-node:/tmp/itest/plugins/Local/
//   MSYS_NO_PATHCONV=1 docker cp Tdarr_Plugin_the1nk_repair_framerate.js tdarr-node:/tmp/itest/plugins/Local/
//   MSYS_NO_PATHCONV=1 docker cp tests/container/detect_damaged_video.itest.js tdarr-node:/tmp/itest/plugins/
// Run it (seconds; a few minutes more with a real file). Optionally pass a real damaged file under /media; it must be reported as damaged:
//   MSYS_NO_PATHCONV=1 docker exec tdarr-node node /tmp/itest/plugins/detect_damaged_video.itest.js ["<damaged file under /media>"]
// Clean up afterwards:
//   MSYS_NO_PATHCONV=1 docker exec tdarr-node rm -rf /tmp/itest
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REAL = process.argv[2];
if (REAL && !fs.existsSync(REAL)) {
  console.error('No such file: ' + REAL);
  process.exit(2);
}

const ROOT = '/tmp/itest';
const WORK = path.join(ROOT, 'work');
const FFMPEG = 'tdarr-ffmpeg';
const FFPROBE = '/app/Tdarr_Node/assets/app/ffmpeg/linux_x64/ffprobe';
const run = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 100 * 1024 * 1024 });

const detect = require(path.join(ROOT, 'plugins', 'Local', 'Tdarr_Plugin_the1nk_detect_damaged_video.js'));
const repair = require(path.join(ROOT, 'plugins', 'Local', 'Tdarr_Plugin_the1nk_repair_framerate.js'));

const W = (name) => path.join(WORK, name);
const ffmpeg = (args) => {
  const r = run(FFMPEG, ['-hide_banner', '-v', 'error', '-y'].concat(args));
  assert.strictEqual(r.status, 0, 'ffmpeg ' + args.join(' ') + ' failed: ' + r.stderr);
};
const probe = (p) => {
  const r = run(FFPROBE, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', '--', p]);
  assert.strictEqual(r.status, 0, 'ffprobe failed: ' + r.stderr);
  return JSON.parse(r.stdout);
};
const fileObj = (p) => ({ _id: p, file: p, container: path.extname(p).slice(1), ffProbeData: probe(p) });
const rateOf = (p) => probe(p).streams.find((s) => s.codec_type === 'video').r_frame_rate;
const otherArgs = { cacheFilePath: W('out.mkv'), ffmpegPath: FFMPEG, mkvpropeditPath: 'mkvpropedit' };
const otherArgs2 = Object.assign({}, otherArgs, { cacheFilePath: W('repaired.mkv') });

fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
try {
  const ver = run(FFMPEG, ['-version']);
  console.log('ffmpeg: ' + String(ver.stdout || ver.error).split(/\r?\n/)[0]);

  // The expected gap and error values below were measured on ffmpeg 7.1.4-Jellyfin. If Tdarr's ffmpeg changes,
  // re-measure them. Fixtures: -threads 1 only pins x264's output bytes, as a precaution; the decode error
  // count does not depend on decoder or encoder threading.
  // Going through MP4 gives the gappy files an odd frame rate (72/5), like the real damaged downloads.
  const src = (rate) => ['-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=' + rate + ':duration=10'];
  const x264 = ['-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p'];
  ffmpeg(src('24').concat(x264, ['-g', '240', W('clean.mp4')]));
  ffmpeg(['-i', W('clean.mp4'), '-c', 'copy', W('clean.mkv')]);
  ffmpeg(src('72/5').concat(x264, [W('steady.mkv')]));
  // Frames 120-215 (4 s) left out before encoding: a deliberate hold, which decodes cleanly.
  ffmpeg(src('24').concat(['-vf', 'select=not(between(n\\,120\\,215))', '-fps_mode', 'passthrough'], x264, [W('vfr.mp4')]));
  ffmpeg(['-i', W('vfr.mp4'), '-c', 'copy', W('vfr.mkv')]);
  // The same frames cut out of the encoded stream: later frames lose the pictures they reference.
  ffmpeg(['-i', W('clean.mp4'), '-c', 'copy', '-bsf:v', 'noise=drop=between(n\\,120\\,215)', W('damaged.mp4')]);
  ffmpeg(['-i', W('damaged.mp4'), '-c', 'copy', W('damaged.mkv')]);

  // Steady near-miss: 24000/1001 video whose track rate mkvmerge relabels as 23185/967 (about 23.976 fps, nonstandard).
  ffmpeg(src('24000/1001').concat(x264, [W('ntsc.mkv')]));
  const mm = run('mkvmerge', ['-o', W('near.mkv'), '--default-duration', '0:23185/967p', W('ntsc.mkv')]);
  assert.ok(!mm.error && (mm.status === 0 || mm.status === 1),'mkvmerge failed: ' + mm.stdout + mm.stderr);

  assert.strictEqual(rateOf(W('clean.mkv')), '24/1');
  assert.strictEqual(rateOf(W('near.mkv')), '23185/967');
  ['steady.mkv', 'vfr.mkv', 'damaged.mkv'].forEach((n) => assert.strictEqual(rateOf(W(n)), '72/5', n));

  const check = (p) => {
    const res = detect.plugin(fileObj(p), {}, {}, otherArgs);
    console.log(path.basename(p) + ': ' + res.infoLog.trim());
    assert.strictEqual(res.processFile, false);
    assert.strictEqual(res.file._id, p);
    return res;
  };

  let res = check(W('clean.mkv'));
  assert.strictEqual(res.error, undefined);
  assert.strictEqual(res.infoLog, 'Frame rate already standard (24/1), skipping.\r\n');

  res = check(W('steady.mkv'));
  assert.strictEqual(res.error, undefined);
  assert.strictEqual(res.infoLog, 'Frame rate 72/5 is not standard, but the frame timing is steady (no gaps). Continuing.\r\n');

  res = check(W('near.mkv'));
  assert.strictEqual(res.error, undefined);
  assert.strictEqual(res.infoLog, 'Frame rate 23185/967 is not standard, but the frame timing is steady (no gaps). Continuing.\r\n');

  res = check(W('vfr.mkv'));
  assert.strictEqual(res.error, undefined);
  assert.strictEqual(res.infoLog, 'Frame rate 72/5: 1 timing gap (largest 4.04s at 00:04), about 4.0s of video missing, '
    + 'but the video decodes cleanly, so it was made variable-frame-rate on purpose. Continuing.\r\n');

  res = check(W('damaged.mkv'));
  assert.strictEqual(res.error, 'Damaged video: 2 timing gaps (largest 4.00s at 00:05), about 4.0s of video missing, '
    + 'and 3 decode errors. The source is missing frames; replace it with a clean copy.');

  // Repair Frame Rate must not force a constant rate onto a file with gaps. 72/5 is 9.58 fps from
  // 24000/1001, so raise the near-miss limit to make it count as one.
  const rep = repair.plugin(fileObj(W('vfr.mkv')), {}, { max_delta_fps: 10 }, otherArgs);
  console.log('repair vfr.mkv: ' + rep.infoLog.trim());
  assert.strictEqual(rep.infoLog, 'Near-miss rate 72/5, but found 1 timing gap (largest 4.04s at 00:04), about 4.0s of '
    + 'video missing. Forcing a constant rate would desync audio. Skipping.\r\n');
  assert.ok(!fs.existsSync(otherArgs.cacheFilePath), 'Repair Frame Rate wrote an output file');

  // Positive control: a steady near-miss file is still repaired, with the real mkvmerge and verification.
  const fix = repair.plugin(fileObj(W('near.mkv')), {}, { max_delta_fps: 0.05 }, otherArgs2);
  console.log('repair near.mkv: ' + fix.infoLog.trim());
  assert.strictEqual(fix.error, undefined);
  assert.ok(fix.infoLog.includes('Near-miss frame rate 23185/967'), fix.infoLog);
  assert.ok(fix.infoLog.includes('Verified:'), fix.infoLog);
  assert.strictEqual(fix.file._id, W('repaired.mkv'));
  assert.strictEqual(fix.processFile, false);
  assert.strictEqual(fix.updateDB, false);
  assert.strictEqual(fix.removeFromDB, false);
  assert.ok(fs.existsSync(W('repaired.mkv')), 'repaired file missing');
  assert.strictEqual(rateOf(W('repaired.mkv')), '24000/1001');

  if (REAL) {
    res = check(REAL);
    assert.match(String(res.error), /^Damaged video: \d+ timing gaps? \(largest [\d.]+s at [\d:]+\), about [\d.]+s of video missing, and \d+ decode errors?\. /, res.infoLog);
  }
  fs.rmSync(WORK, { recursive: true, force: true });
  console.log('PASS');
} catch (e) {
  console.error(e && e.stack ? e.stack : e);
  console.error('FAILED. Work files kept for inspection in ' + WORK);
  process.exit(1);
}
```

- [ ] **Step 2: Stage and run it in the container**

Run from the repo root in Git Bash:

```bash
MSYS_NO_PATHCONV=1 docker exec tdarr-node sh -c 'rm -rf /tmp/itest && mkdir -p /tmp/itest/plugins/Local && ln -s /app/Tdarr_Node/assets/app/plugins/methods /tmp/itest/plugins/methods'
MSYS_NO_PATHCONV=1 docker cp Tdarr_Plugin_the1nk_detect_damaged_video.js tdarr-node:/tmp/itest/plugins/Local/
MSYS_NO_PATHCONV=1 docker cp Tdarr_Plugin_the1nk_repair_framerate.js tdarr-node:/tmp/itest/plugins/Local/
MSYS_NO_PATHCONV=1 docker cp tests/container/detect_damaged_video.itest.js tdarr-node:/tmp/itest/plugins/
MSYS_NO_PATHCONV=1 docker exec tdarr-node node /tmp/itest/plugins/detect_damaged_video.itest.js
```

Expected: an `ffmpeg:` version line, then log lines for clean, steady, near, vfr and damaged, then `repair vfr.mkv` (gap guard) and `repair near.mkv` (a real repair, `Verified: 23185/967 -> 24000/1001 ... Lossless.`), and then `PASS`, exit code 0. On success the test deletes its own work files; on failure it prints `FAILED. Work files kept for inspection in /tmp/itest/work` and exits 1.

If an assertion fails, do not edit the expected strings to match. Find out why the plugin's output differs from the measured fixture results in Background, and fix the cause. The one exception: if the logged `ffmpeg:` version differs from 7.1.4-Jellyfin, re-measure the fixture values instead.

- [ ] **Step 3: Clean up the container**

```bash
MSYS_NO_PATHCONV=1 docker exec tdarr-node rm -rf /tmp/itest
```

- [ ] **Step 4: Commit**

```bash
git add tests/container/detect_damaged_video.itest.js
git commit -F - <<'EOF'
Add container integration test for damaged-video detection

Claude-Session: https://claude.ai/code/session_016ziVwwvkMXfjNotbAoqpyw
EOF
```

---

### Task 5: Run Detect Damaged Video first in every flow

**Files:**
- Modify: `flowMovies.json`, `flowAnimovies.json`, `flowShows.json`, `flowAnishows.json`, `flowOtherVideos.json`
- Modify (gitignored, not committed): `flowMovies.local.json`, `flowAnimovies.local.json`, `flowShows.local.json`, `flowAnishows.local.json`, `flowOtherVideos.local.json`

Each flow currently has Processed Tag Filter (output 1) → Convert Unsupported Subtitles. The new node goes between them, in Convert Unsupported Subtitles' position; that node and every node below it in the same column move down 100 px (the same layout change as commit `60f274a`).

- [ ] **Step 1: Write the one-off insertion script (scratch, not committed)**

Create `C:\Users\adam\AppData\Local\Temp\claude\C--git-tdarr-plugins\8d4010ae-e5a3-494d-b7ee-7b951074e6d1\scratchpad\insert-detect-node.js`:

```js
// Inserts "Run Classic Transcode Plugin: Tdarr_Plugin_the1nk_detect_damaged_video" in front of
// Convert Unsupported Subtitles. Usage: node insert-detect-node.js <flow.json>...
const fs = require('fs');
const crypto = require('crypto');

const NAME = 'Run Classic Transcode Plugin: Tdarr_Plugin_the1nk_detect_damaged_video';
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
const newId = () => Array.from(crypto.randomBytes(10), (b) => ALPHABET[b % 64]).join('');

for (const f of process.argv.slice(2)) {
  const flow = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (flow.flowPlugins.some((n) => n.name === NAME)) throw new Error(f + ': already has the node');
  const subs = flow.flowPlugins.find((n) => n.name === 'Run Classic Transcode Plugin: Tdarr_Plugin_the1nk_convert_unsupported_subs');
  if (!subs) throw new Error(f + ': no Convert Unsupported Subtitles node');
  const into = flow.flowEdges.filter((e) => e.target === subs.id);
  if (into.length !== 1) throw new Error(f + ': expected 1 edge into Convert Unsupported Subtitles, found ' + into.length);
  const { x, y } = subs.position;
  flow.flowPlugins.forEach((n) => {
    if (Math.abs(n.position.x - x) < 1 && n.position.y >= y) n.position.y += 100;
  });
  const node = {
    name: NAME,
    sourceRepo: 'Community',
    pluginName: 'runClassicTranscodePlugin',
    version: '2.0.0',
    inputsDB: { pluginSourceId: 'Local:Tdarr_Plugin_the1nk_detect_damaged_video' },
    fpEnabled: true,
    id: newId(),
    position: { x, y },
  };
  flow.flowPlugins.splice(flow.flowPlugins.indexOf(subs), 0, node);
  into[0].target = node.id;
  flow.flowEdges.push(
    { source: node.id, sourceHandle: '1', target: subs.id, targetHandle: null, id: newId() },
    { source: node.id, sourceHandle: '2', target: subs.id, targetHandle: null, id: newId() },
  );
  // The exports use CRLF everywhere except after the final "}".
  fs.writeFileSync(f, JSON.stringify(flow, null, 2).replace(/\n/g, '\r\n') + '\n');
  console.log(f + ': inserted ' + node.id + ' before ' + subs.id);
}
```

- [ ] **Step 2: Run it on all ten flow files**

```bash
cd "/c/git/tdarr plugins" && node "/c/Users/adam/AppData/Local/Temp/claude/C--git-tdarr-plugins/8d4010ae-e5a3-494d-b7ee-7b951074e6d1/scratchpad/insert-detect-node.js" flowMovies.json flowAnimovies.json flowShows.json flowAnishows.json flowOtherVideos.json flowMovies.local.json flowAnimovies.local.json flowShows.local.json flowAnishows.local.json flowOtherVideos.local.json
```

Expected: ten `inserted … before …` lines.

- [ ] **Step 3: Verify the result**

```bash
cd "/c/git/tdarr plugins" && for f in flow*.json; do node -e '
const f = process.argv[1]; const flow = require("./" + f);
const byId = Object.fromEntries(flow.flowPlugins.map((n) => [n.id, n]));
const det = flow.flowPlugins.find((n) => /detect_damaged_video$/.test(n.name));
const into = flow.flowEdges.filter((e) => e.target === det.id).map((e) => byId[e.source].name + " #" + e.sourceHandle);
const out = flow.flowEdges.filter((e) => e.source === det.id).map((e) => "#" + e.sourceHandle + " " + byId[e.target].name);
const col = flow.flowPlugins.filter((n) => Math.abs(n.position.x - det.position.x) < 1).map((n) => n.position.y).sort((a, b) => a - b);
const evenSteps = col.every((y, i) => i === 0 || Math.abs(y - col[i - 1] - 100) < 1e-6);
console.log(f, "| in:", into.join(", "), "| out:", out.join(", "), "| column steps 100px:", evenSteps);
' "$f"; done
git diff --stat
```

Expected for every file: `in: Run Classic Filter Plugin: Tdarr_Plugin_the1nk_processed_tag_filter #1 | out: #1 Run Classic Transcode Plugin: Tdarr_Plugin_the1nk_convert_unsupported_subs, #2 Run Classic Transcode Plugin: Tdarr_Plugin_the1nk_convert_unsupported_subs | column steps 100px: true`. `git diff --stat` lists only the five tracked `flow*.json` files (the `.local.json` files are gitignored). Also confirm the tracked files still contain `YOUR_RADARR_API_KEY` / `YOUR_SONARR_API_KEY` where they did before: `git diff | grep -c API_KEY` must print `0`.

- [ ] **Step 4: Commit (tracked flows only)**

```bash
git add flowMovies.json flowAnimovies.json flowShows.json flowAnishows.json flowOtherVideos.json
git commit -F - <<'EOF'
Run Detect Damaged Video first in every flow

Claude-Session: https://claude.ai/code/session_016ziVwwvkMXfjNotbAoqpyw
EOF
```

---

### Task 6: README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Flow diagram**

In the mermaid block, replace:

```
    f2 -- continue --> t1[Convert Unsupported Subtitles<br/>WebVTT to SRT]
```

with:

```
    f2 -- continue --> t0[Detect Damaged Video]
    t0 --> t1[Convert Unsupported Subtitles<br/>WebVTT to SRT]
```

- [ ] **Step 2: Ordering rules**

Replace the bullet that starts `- **Convert Unsupported Subtitles goes _first_, before any FFmpeg step.**` with these two bullets:

```markdown
- **Detect Damaged Video goes _first_.** It fails the job before any work is done on a file that is missing frames. It must come before H265 CPU Transcode in any case: a re-encode keeps the timing gaps but writes a clean stream, which hides the decoder errors the check relies on.
- **Convert Unsupported Subtitles comes next, before any FFmpeg step.** Every later step copies all streams (`-map 0 -c copy`), and FFmpeg can't copy a track it can't read, so a single WebVTT track stored as `S_TEXT/WEBVTT` fails the whole flow with `Subtitle codec 0 is not supported`.
```

In the Convert Unsupported Subtitles plugin section, change `In a flow, put it **first** (see [Ordering rules](#ordering-rules)).` to `In a flow, put it right after Detect Damaged Video, before any FFmpeg step (see [Ordering rules](#ordering-rules)).`

- [ ] **Step 3: Plugin section for Detect Damaged Video**

Insert directly before the line ``#### `Tdarr_Plugin_the1nk_convert_unsupported_subs` `` (it is preceded by a `---` line and a blank line; the block below ends with its own `---` and a blank line, so the separators stay one per section):

```markdown
#### `Tdarr_Plugin_the1nk_detect_damaged_video`
**Detect Damaged Video** — v1.00

Fails the job when the source video is missing frames, so a damaged download never replaces the library file. The known case is downloads with whole seconds of video cut out: the player freezes on the last frame until the next one arrives, and the frame rate comes out odd (a 24 fps episode missing 209 frames reported `7016/301` = 23.309 fps).

- **Gate:** only files whose video frame rate is not a standard one (`24000/1001`, `24/1`, `25/1`, `30000/1001`, `30/1`, `50/1`, `60000/1001`, `60/1`, `24000/1000`). Everything else passes through without being read.
- **Timing gaps:** ffprobe lists the video packet timestamps. The normal interval is the most common one; any interval of at least 1.5× normal is a gap.
- **Decoder errors:** only when there are gaps, ffprobe decodes the video once (`-count_frames`) and counts the decoder errors. Frames cut out of the stream leave later frames pointing at pictures that no longer exist ("Missing reference picture").

| Gaps | Decoder errors | Result |
|------|----------------|--------|
| none | (not checked) | continues |
| yes | none | continues: the file was made variable-frame-rate on purpose (a still scene stored as one long frame) |
| yes | yes | **job fails**, e.g. `Damaged video: 7 timing gaps (largest 4.17s at 04:00), about 8.7s of video missing, and 202 decode errors. The source is missing frames; replace it with a clean copy.` |

The file is only read, never changed. If ffprobe can't run, the job fails too, because passing the file unchecked would defeat the check. It uses Tdarr's bundled ffprobe, else one next to an absolute `ffmpegPath`, else `ffprobe` on PATH. Damage cut cleanly at keyframes leaves no decoder errors and isn't detected; neither is damage in a file whose rate is still standard. In a flow, put it **first** (see [Ordering rules](#ordering-rules)).

No inputs.

---
```

- [ ] **Step 4: Repair Frame Rate section**

Change `**Repair Near-Miss Frame Rate** — v1.01 _(flow-only)_` to `**Repair Near-Miss Frame Rate** — v1.02 _(flow-only)_`, and after the `- **Gate:** …` bullet add:

```markdown
- **Gaps:** the video packet timestamps are listed first. If the timing has gaps (frames missing; the same 1.5× rule as Detect Damaged Video), the file is skipped and the gaps are logged: a constant rate would close them by sliding the video out of sync with the audio.
```

- [ ] **Step 5: Tests section**

At the end of the `## Tests` section, after the existing integration test's code block, add:

````markdown
Integration test for `Tdarr_Plugin_the1nk_detect_damaged_video` and Repair Frame Rate's gap check, run inside the `tdarr-node` container. It builds four 10-second test videos with `tdarr-ffmpeg` (clean; steady at an odd rate; variable-frame-rate on purpose; frames cut out of the stream) and checks each verdict and message exactly. It needs no media and only writes under `/tmp/itest`. Pass a real damaged file under `/media` as an extra argument to check that it's reported as damaged too:

```bash
MSYS_NO_PATHCONV=1 docker exec tdarr-node sh -c 'rm -rf /tmp/itest && mkdir -p /tmp/itest/plugins/Local && ln -s /app/Tdarr_Node/assets/app/plugins/methods /tmp/itest/plugins/methods'
MSYS_NO_PATHCONV=1 docker cp Tdarr_Plugin_the1nk_detect_damaged_video.js tdarr-node:/tmp/itest/plugins/Local/
MSYS_NO_PATHCONV=1 docker cp Tdarr_Plugin_the1nk_repair_framerate.js tdarr-node:/tmp/itest/plugins/Local/
MSYS_NO_PATHCONV=1 docker cp tests/container/detect_damaged_video.itest.js tdarr-node:/tmp/itest/plugins/
MSYS_NO_PATHCONV=1 docker exec tdarr-node node /tmp/itest/plugins/detect_damaged_video.itest.js
MSYS_NO_PATHCONV=1 docker exec tdarr-node rm -rf /tmp/itest
```
````

- [ ] **Step 6: Check the README renders sensibly**

Run: `grep -n "Detect Damaged Video\|detect_damaged_video\|v1.02" README.md`
Expected: hits in the diagram, the ordering rules, the new plugin section, the Repair section and the Tests section.

- [ ] **Step 7: Commit**

```bash
git add README.md
git commit -F - <<'EOF'
Document the Detect Damaged Video plugin and Repair Frame Rate's gap check

Claude-Session: https://claude.ai/code/session_016ziVwwvkMXfjNotbAoqpyw
EOF
```

---

## After all tasks

- Run `node --test tests/*.test.js` once more: `# fail 0`.
- Not part of this plan (outward-facing; the user decides): `./push.ps1` to copy the plugins to Tdarr, and importing the five `flow*.local.json` files into Tdarr.
