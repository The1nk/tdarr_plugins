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
  parseTimes, findGaps, clock, describeGaps, damagedMessage, countLines, firstErrors, tail, pickFfprobe, pickVideo,
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

test('firstErrors: Windows ffprobe prints the context address without 0x', () => {
  assert.deepStrictEqual(firstErrors('[h264 @ 0000025e00d66440] error while decoding MB 2 67, bytestream -8\n', 3),
    ['h264: error while decoding MB 2 67, bytestream -8']);
  assert.deepStrictEqual(firstErrors('[h264 @ 0x55d1ffc77a00] mmco: unref short failure', 1), ['h264: mmco: unref short failure']);
});

test('firstErrors: first n non-empty lines, [name @ addr] rewritten to name:, capped at 200 characters', () => {
  const err = '[h264 @ 0x55d1ffc77a00] error while decoding MB 2 67, bytestream -8\r\n\r\n  plain line  \n   \n[mov,mp4 @ 0xabc] second\n[h264 @ 0x1] fourth\n';
  assert.deepStrictEqual(firstErrors(err, 2), ['h264: error while decoding MB 2 67, bytestream -8', 'plain line']);
  assert.deepStrictEqual(firstErrors(err, 1), ['h264: error while decoding MB 2 67, bytestream -8']);
  assert.deepStrictEqual(firstErrors(err, 5), ['h264: error while decoding MB 2 67, bytestream -8', 'plain line', 'mov,mp4: second', 'h264: fourth']);
  assert.deepStrictEqual(firstErrors('', 3), []);
  assert.deepStrictEqual(firstErrors(undefined, 3), []);
  assert.strictEqual(firstErrors('[h264 @ 0x1] ' + 'x'.repeat(300), 1)[0].length, 200);
  assert.strictEqual(firstErrors('y'.repeat(300), 1)[0], 'y'.repeat(200));
});

test('tail: short text is unchanged; long text keeps the last 20 lines and 2000 characters', () => {
  assert.strictEqual(tail('a\nb\n'), 'a\nb');
  const lines = Array.from({ length: 25 }, (_, n) => 'line ' + (n + 1));
  assert.strictEqual(tail(lines.join('\n')), '(5 earlier lines left out) ' + lines.slice(5).join('\n'));
  assert.strictEqual(tail('x'.repeat(3000) + 'y'.repeat(2000)), 'y'.repeat(2000));
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

// --- plugin(), with ffprobe stubbed ---

const csv = (times) => times.map((t) => t.toFixed(6)).join('\n') + '\n';
const steady = csv(grid(0, 240));
const holed = csv(grid(0, 120).concat(grid(216, 240)));
const LIST_ARGS = ['-v', 'error', '-select_streams', '0', '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', '--', '/m/a.mkv'];
const DECODE_ARGS = ['-v', 'repeat+error', '-threads', '0', '-select_streams', '0', '-count_frames', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', '--', '/m/a.mkv'];

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
  assert.strictEqual(res.error, msg + ' First error: h264: Missing reference picture, default is 0');
  assert.strictEqual(res.infoLog, msg + '\r\nFirst decoder errors:\r\n  h264: Missing reference picture, default is 0\r\n  h264: mmco: unref short failure\r\n');
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
