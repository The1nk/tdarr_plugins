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

const repair = require(path.join(__dirname, '..', 'plugins', 'Tdarr_Plugin_the1nk_repair_framerate.js'));
const detect = require(path.join(__dirname, '..', 'plugins', 'Tdarr_Plugin_the1nk_detect_damaged_video.js'));

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
    const text = fs.readFileSync(path.join(__dirname, '..', 'plugins', file), 'utf8').replace(/\r\n/g, '\n');
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
