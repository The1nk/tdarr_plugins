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

test('clock: mm:ss under an hour, h:mm:ss from one hour, seconds rounded down', () => {
  assert.strictEqual(clock(0), '00:00');
  assert.strictEqual(clock(50.98), '00:50');
  assert.strictEqual(clock(75), '01:15');
  assert.strictEqual(clock(3725.9), '1:02:05');
});

test('describeGaps: count, largest (first one on a tie), missing time', () => {
  assert.strictEqual(describeGaps(findGaps(grid(0, 50).concat(grid(51, 100)))),
    '1 timing gap (largest 0.08s at 00:02), about 0.04s of video missing');
  assert.strictEqual(describeGaps({ gaps: [{ at: 10, length: 2 }, { at: 20, length: 2 }], missing: 3.916 }),
    '2 timing gaps (largest 2.00s at 00:10), about 3.9s of video missing');
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
