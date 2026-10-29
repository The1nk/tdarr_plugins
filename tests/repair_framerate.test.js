const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const path = require('path');

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
  const c = Object.assign({ rate: '23185/967', listing: { status: 0, stdout: csv(grid(0, 240)), stderr: '' } }, cfg);
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
      ffProbeData: { streams: [{ index: 0, codec_type: 'video', r_frame_rate: c.rate }] } };
    const res = repair.plugin(file, {}, { max_delta_fps: 0.05 }, { cacheFilePath: '/w/a.mkv', mkvpropeditPath: 'mkvpropedit' });
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
  stubs = null;
  const calls = [];
  stubs = {
    fs: { existsSync: () => false, unlinkSync: () => {} },
    child_process: {
      spawnSync: (cmd, args) => {
        calls.push([cmd].concat(args));
        if (args.includes('packet=pts_time')) return { status: 0, stdout: csv(grid(0, 50).concat(grid(51, 100))), stderr: '' };
        throw new Error('unexpected call: ' + cmd + ' ' + args.join(' '));
      },
    },
  };
  try {
    const file = { _id: '/m/a.mkv', file: '/m/a.mkv', container: 'mkv', ffProbeData: { streams: [
      { codec_type: 'video', r_frame_rate: '90000/1', disposition: { attached_pic: 1 } },
      { codec_type: 'video', r_frame_rate: '23185/967' },
    ] } };
    repair.plugin(file, {}, { max_delta_fps: 0.05 }, { cacheFilePath: '/w/a.mkv', mkvpropeditPath: 'mkvpropedit' });
  } finally {
    stubs = null;
  }
  assert.deepStrictEqual(calls[0].slice(3, 5), ['-select_streams', 'v:1']);
});

// Each plugin file must stand alone, so the gap code exists twice. Both copies must agree.
test('shared gap code: both plugins give the same results', () => {
  const r = repair._test;
  const d = detect._test;
  const inputs = [
    '',
    '1.5\n',
    csv(grid(0, 240)),
    csv(grid(0, 50).concat(grid(51, 100))),
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
