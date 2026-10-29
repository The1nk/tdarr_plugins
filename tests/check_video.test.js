const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tool = require(path.join(__dirname, '..', 'tools', 'check-video.js'));
const { runTool, checkFile, collectFiles, parseArgs, main } = tool;

// 24 fps timestamps at a 1 ms timebase (41/42 ms steps, like Matroska), frames [from, to).
const grid = (from, to) => {
  const t = [];
  for (let n = from; n < to; n++) t.push(Math.round((n / 24) * 1000) / 1000);
  return t;
};
const csv = (times) => times.map((t) => t.toFixed(6)).join('\n') + '\n';

const PROBE_ARG = 'stream=index,codec_type,r_frame_rate:stream_disposition=attached_pic';
const VIDEO = (rate, index) => ({ index: index || 0, codec_type: 'video', r_frame_rate: rate, disposition: { attached_pic: 0 } });
const COVER = (index) => ({ index, codec_type: 'video', r_frame_rate: '90000/1', disposition: { attached_pic: 1 } });
const HOLE = grid(0, 120).concat(grid(216, 240));
const BAD_STDERR = '[h264 @ 0x1] Missing reference picture, default is 0\n[h264 @ 0x1] mmco: unref short failure\n';
const GAP_TEXT = '1 timing gap (largest 4.04s at 00:04), about 4.0s of video missing';
const DAMAGED_DETAIL = 'Damaged video: ' + GAP_TEXT + ', and 2 decode errors. The source is missing frames; replace it with a clean copy.';

// A fake runner that records [cmd, ...args] and answers by argument.
const fake = (cfg) => {
  const c = cfg || {};
  const calls = [];
  const run = async (cmd, args) => {
    calls.push([cmd].concat(args));
    if (args.includes(PROBE_ARG)) {
      if (c.probe) return c.probe;
      return { status: 0, stdout: JSON.stringify({ streams: c.streams || [VIDEO('7016/301')] }), stderr: '' };
    }
    if (args.includes('packet=pts_time')) {
      return c.list || { status: 0, stdout: csv(grid(0, 240)), stderr: '' };
    }
    if (args.includes('-count_frames')) {
      return c.decode || { status: 0, stdout: '144\n', stderr: '' };
    }
    throw new Error('unexpected call: ' + args.join(' '));
  };
  run.calls = calls;
  return run;
};

const OPTS = { all: false, ffprobe: 'ffprobe' };
const FILE = '/v/a.mkv';

test('parseArgs: defaults', () => {
  const o = parseArgs([]);
  assert.deepStrictEqual(o, { all: false, jobs: 2, ffprobe: 'ffprobe', paths: [], help: false });
  assert.ok(!('error' in o));
});

test('parseArgs: options and paths', () => {
  const o = parseArgs(['--all', '-j', '4', '--ffprobe', 'C:\\ff\\ffprobe.exe', 'a', 'b']);
  assert.strictEqual(o.all, true);
  assert.strictEqual(o.jobs, 4);
  assert.strictEqual(o.ffprobe, 'C:\\ff\\ffprobe.exe');
  assert.deepStrictEqual(o.paths, ['a', 'b']);
});

test('parseArgs: errors', () => {
  assert.strictEqual(parseArgs(['--jobs', '0']).error, '--jobs needs a whole number of at least 1');
  assert.strictEqual(parseArgs(['-j', 'x']).error, '-j needs a whole number of at least 1');
  assert.strictEqual(parseArgs(['--ffprobe']).error, '--ffprobe needs a path');
  assert.strictEqual(parseArgs(['--bogus']).error, 'unknown option --bogus');
});

test('parseArgs: -- ends the options, and help', () => {
  assert.deepStrictEqual(parseArgs(['--', '-odd.mkv']).paths, ['-odd.mkv']);
  assert.strictEqual(parseArgs(['-h']).help, true);
  assert.strictEqual(parseArgs(['--help']).help, true);
});

test('checkFile: only cover art is skipped', async () => {
  const run = fake({ streams: [COVER(0)] });
  assert.deepStrictEqual(await checkFile(FILE, OPTS, run), { file: FILE, verdict: 'skipped', detail: 'no video stream' });
  assert.strictEqual(run.calls.length, 1);
});

test('checkFile: standard frame rate is clean after one call; --all lists the timestamps', async () => {
  const run = fake({ streams: [VIDEO('24000/1001')] });
  const r = await checkFile(FILE, OPTS, run);
  assert.strictEqual(r.verdict, 'clean');
  assert.strictEqual(r.detail, 'standard frame rate 24000/1001');
  assert.strictEqual(run.calls.length, 1);

  const run2 = fake({ streams: [VIDEO('24000/1001')] });
  const r2 = await checkFile(FILE, { all: true, ffprobe: 'ffprobe' }, run2);
  assert.strictEqual(r2.verdict, 'clean');
  assert.strictEqual(r2.detail, 'frame rate 24000/1001, steady timing (no gaps)');
  assert.strictEqual(run2.calls.length, 2);
});

test('checkFile: odd frame rate with steady timing is clean', async () => {
  const run = fake();
  const r = await checkFile(FILE, OPTS, run);
  assert.strictEqual(r.verdict, 'clean');
  assert.strictEqual(r.detail, 'frame rate 7016/301, steady timing (no gaps)');
  assert.strictEqual(run.calls.length, 2);
  assert.deepStrictEqual(run.calls[1], ['ffprobe', '-v', 'error', '-select_streams', '0', '-show_entries', 'packet=pts_time',
    '-of', 'csv=p=0', '--', '/v/a.mkv']);
});

test('checkFile: a gap that decodes cleanly is deliberate VFR', async () => {
  const run = fake({ list: { status: 0, stdout: csv(HOLE), stderr: '' } });
  const r = await checkFile(FILE, OPTS, run);
  assert.strictEqual(r.verdict, 'vfr');
  assert.strictEqual(r.detail, 'frame rate 7016/301: ' + GAP_TEXT
    + ', but the video decodes cleanly (variable frame rate on purpose)');
  assert.deepStrictEqual(run.calls[2], ['ffprobe', '-v', 'repeat+error', '-threads', '0', '-select_streams', '0',
    '-count_frames', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', '--', '/v/a.mkv']);
});

test('checkFile: a gap with decode errors is damaged', async () => {
  const run = fake({
    list: { status: 0, stdout: csv(HOLE), stderr: '' },
    decode: { status: 0, stdout: '144\n', stderr: BAD_STDERR },
  });
  const r = await checkFile(FILE, OPTS, run);
  assert.strictEqual(r.verdict, 'damaged');
  assert.strictEqual(r.detail, DAMAGED_DETAIL);
  assert.deepStrictEqual(r.firstErrors, ['h264: Missing reference picture, default is 0', 'h264: mmco: unref short failure']);
});

test('checkFile: cover art first, video second uses the video stream index', async () => {
  const run = fake({ streams: [COVER(0), VIDEO('7016/301', 1)] });
  await checkFile(FILE, OPTS, run);
  const list = run.calls[1];
  assert.strictEqual(list[list.indexOf('-select_streams') + 1], '1');
});

test('checkFile: ffprobe failures become errors', async () => {
  let r = await checkFile(FILE, OPTS, fake({ probe: { status: 1, stdout: '', stderr: 'Invalid data found when processing input\n' } }));
  assert.strictEqual(r.verdict, 'error');
  assert.strictEqual(r.detail, 'ffprobe could not read the file (exit 1): Invalid data found when processing input');

  r = await checkFile(FILE, OPTS, fake({
    probe: { error: new Error('spawn ffprobe ENOENT'), status: null, signal: null, stdout: '', stderr: '' },
  }));
  assert.strictEqual(r.detail, 'ffprobe could not read the file (not started): spawn ffprobe ENOENT');

  r = await checkFile(FILE, OPTS, fake({ probe: { status: 0, stdout: 'not json', stderr: '' } }));
  assert.strictEqual(r.verdict, 'error');
  assert.strictEqual(r.detail, 'ffprobe returned no JSON');

  r = await checkFile(FILE, OPTS, fake({ list: { status: null, signal: 'SIGKILL', stdout: '', stderr: '' } }));
  assert.strictEqual(r.detail, 'ffprobe could not list the video timestamps (signal SIGKILL): no output');

  r = await checkFile(FILE, OPTS, fake({ list: { status: 0, stdout: 'N/A\n', stderr: '' } }));
  assert.strictEqual(r.verdict, 'error');
  assert.strictEqual(r.detail, 'ffprobe listed too few usable video timestamps (0 found)');

  r = await checkFile(FILE, OPTS, fake({
    list: { status: 0, stdout: csv(HOLE), stderr: '' },
    decode: { status: 1, stdout: '', stderr: 'boom' },
  }));
  assert.strictEqual(r.detail, 'ffprobe could not decode the video (exit 1): boom');
});

test('collectFiles: walks folders, filters by extension, dedupes', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const show = path.join(root, 'show');
  fs.mkdirSync(path.join(show, 'S1'), { recursive: true });
  const touch = (...p) => { const f = path.join(...p); fs.writeFileSync(f, ''); return f; };
  const e1 = touch(show, 'S1', 'E1.MKV');
  const e2 = touch(show, 'S1', 'E2.mp4');
  touch(show, 'S1', 'E2.nfo');
  const e3 = touch(show, 'E3.m2t');
  touch(show, 'cover.jpg');
  const loose = touch(root, 'loose.txt');

  assert.deepStrictEqual(collectFiles([show]), { files: [e3, e1, e2], problems: [] });
  assert.deepStrictEqual(collectFiles([loose]), { files: [loose], problems: [] });
  const missing = path.join(root, 'missing');
  assert.deepStrictEqual(collectFiles([missing]), {
    files: [], problems: [{ file: missing, verdict: 'error', detail: 'not found' }],
  });
  assert.deepStrictEqual(collectFiles([loose, loose]).files, [loose]);
});

const capture = (run) => {
  const out = [];
  const err = [];
  return { out, err, deps: { run, out: (s) => out.push(s), err: (s) => err.push(s) } };
};

test('main: no paths prints usage and returns 2', async () => {
  const c = capture(fake());
  assert.strictEqual(await main([], c.deps), 2);
  assert.ok(c.err.join('\n').startsWith('Usage: node tools/check-video.js'));
});

test('main: --help prints usage and returns 0', async () => {
  const c = capture(fake());
  assert.strictEqual(await main(['--help'], c.deps), 0);
  assert.ok(c.out.join('\n').startsWith('Usage: node tools/check-video.js'));
});

test('main: unknown option', async () => {
  const c = capture(fake());
  assert.strictEqual(await main(['--bogus'], c.deps), 2);
  assert.strictEqual(c.err[0], 'unknown option --bogus');
  assert.ok(c.err[1].startsWith('Usage: node tools/check-video.js'));
});

test('main: a folder with no video files', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'notes.nfo'), '');
  const c = capture(fake());
  assert.strictEqual(await main([root], c.deps), 2);
  assert.ok(c.err.includes('No video files found.'));
});

test('main: reports damaged files and returns 1', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const a = path.join(root, 'a.mkv');
  const b = path.join(root, 'b.mkv');
  fs.writeFileSync(a, '');
  fs.writeFileSync(b, '');
  const base = fake();
  const bad = fake({
    list: { status: 0, stdout: csv(HOLE), stderr: '' },
    decode: { status: 0, stdout: '144\n', stderr: BAD_STDERR },
  });
  const run = (cmd, args) => (args[args.length - 1] === b ? bad : base)(cmd, args);
  const c = capture(run);
  assert.strictEqual(await main([root], c.deps), 1);
  assert.match(c.out[0], /^\[[12]\/2\] (CLEAN|DAMAGED) +.*[ab]\.mkv - /);
  assert.match(c.out[1], /^\[[12]\/2\] (CLEAN|DAMAGED) +.*[ab]\.mkv - /);
  assert.deepStrictEqual(c.out.slice(2), [
    '',
    'Checked 2 files: 1 clean, 0 deliberate VFR, 1 damaged, 0 errors, 0 skipped.',
    '',
    'Damaged:',
    '  ' + b,
    '    ' + DAMAGED_DETAIL,
    '    First decoder errors:',
    '      h264: Missing reference picture, default is 0',
    '      h264: mmco: unref short failure',
  ]);
});

test('main: all clean returns 0', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'a.mkv'), '');
  const c = capture(fake());
  assert.strictEqual(await main([root], c.deps), 0);
  assert.ok(!c.out.includes('Damaged:'));
});

test('main: a missing path is an error', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const a = path.join(root, 'a.mkv');
  fs.writeFileSync(a, '');
  const c = capture(fake());
  assert.strictEqual(await main(['<missing>', a], c.deps), 1);
  assert.ok(c.out.some((l) => l.includes('1 errors')), c.out.join('\n'));
  assert.ok(c.out.includes('Errors:'));
  assert.ok(c.out.includes('  <missing>: not found'));
});

test('main: -j limits how many files are checked at once', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (let i = 1; i <= 5; i++) fs.writeFileSync(path.join(root, 'f' + i + '.mkv'), '');
  const maxFor = async (argv) => {
    const inner = fake();
    const active = new Map();
    let max = 0;
    const run = async (cmd, args) => {
      const f = args[args.length - 1];
      active.set(f, (active.get(f) || 0) + 1);
      max = Math.max(max, active.size);
      await new Promise((r) => setTimeout(r, 20));
      const res = await inner(cmd, args);
      active.set(f, active.get(f) - 1);
      if (active.get(f) === 0) active.delete(f);
      return res;
    };
    const c = capture(run);
    assert.strictEqual(await main(argv.concat([root]), c.deps), 0);
    return max;
  };
  assert.strictEqual(await maxFor(['-j', '2']), 2);
  assert.strictEqual(await maxFor(['-j', '1']), 1);
});

test('runTool: captures status and output; a missing tool sets error', async () => {
  const r = await runTool(process.execPath, ['-e', 'process.stdout.write("hi");process.stderr.write("e");process.exit(3)']);
  assert.strictEqual(r.status, 3);
  assert.strictEqual(r.stdout, 'hi');
  assert.strictEqual(r.stderr, 'e');
  const m = await runTool('no-such-tool-xyz', []);
  assert.ok(m.error);
  assert.strictEqual(m.status, null);
});
