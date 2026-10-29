const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tool = require(path.join(__dirname, '..', 'tools', 'check-video.js'));
const {
  runTool, checkFile, collectFiles, parseArgs, main, oneLine, summarise, capLabel,
} = tool;

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
const USAGE_START = 'Usage: node tools/check-video.js';

// A fake runner that records [cmd, ...args] and answers by argument.
const fake = (cfg) => {
  const c = cfg || {};
  const calls = [];
  const run = async (cmd, args) => {
    calls.push([cmd].concat(args));
    if (args.includes('-version')) return c.version || { status: 0, stdout: 'ffprobe version 7\n', stderr: '' };
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

const OPTS = { all: false, ffprobe: 'ffprobe', timeout: 120 };
const FILE = '/v/a.mkv';

const tmpRoot = (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
};
const capture = (run, extra) => {
  const out = [];
  const err = [];
  return { out, err, deps: Object.assign({ run, out: (s) => out.push(s), err: (s) => err.push(s) }, extra) };
};

test('oneLine: splits on line breaks, trims, drops empty lines, joins with |', () => {
  assert.strictEqual(oneLine('a\r\n  b  \n\n c\rd'), 'a | b | c | d');
  assert.strictEqual(oneLine('single'), 'single');
  assert.strictEqual(oneLine(''), '');
});

test('capLabel', () => {
  assert.strictEqual(capLabel(256 * 1024 * 1024), '256 MB');
  assert.strictEqual(capLabel(1000), '1000 bytes');
});

test('parseArgs: defaults', () => {
  const o = parseArgs([]);
  assert.deepStrictEqual(o, { all: false, jobs: 2, timeout: 120, ffprobe: 'ffprobe', paths: [], help: false });
  assert.ok(!('error' in o));
});

test('parseArgs: options and paths', () => {
  const o = parseArgs(['--all', '-j', '4', '--timeout', '30', '--ffprobe', 'C:\\ff\\ffprobe.exe', 'a', 'b']);
  assert.strictEqual(o.all, true);
  assert.strictEqual(o.jobs, 4);
  assert.strictEqual(o.timeout, 30);
  assert.strictEqual(o.ffprobe, 'C:\\ff\\ffprobe.exe');
  assert.deepStrictEqual(o.paths, ['a', 'b']);
  assert.strictEqual(parseArgs(['--timeout', '0']).timeout, 0);
});

test('parseArgs: errors', () => {
  assert.strictEqual(parseArgs(['--jobs', '0']).error, '--jobs needs a whole number of at least 1');
  assert.strictEqual(parseArgs(['-j', 'x']).error, '-j needs a whole number of at least 1');
  assert.strictEqual(parseArgs(['--ffprobe']).error, '--ffprobe needs a path');
  assert.strictEqual(parseArgs(['--bogus']).error, 'unknown option --bogus');
  const msg = '--timeout needs a whole number of minutes (0 = none)';
  assert.strictEqual(parseArgs(['--timeout', '-1']).error, msg);
  assert.strictEqual(parseArgs(['--timeout', 'x']).error, msg);
  assert.strictEqual(parseArgs(['--timeout', '1.5']).error, msg);
  assert.strictEqual(parseArgs(['--timeout']).error, msg);
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
  const r2 = await checkFile(FILE, Object.assign({}, OPTS, { all: true }), run2);
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

test('checkFile: passes the per-call timeout to the runner', async () => {
  const seen = [];
  const inner = fake();
  const run = (cmd, args, o) => { seen.push(o); return inner(cmd, args); };
  await checkFile(FILE, Object.assign({}, OPTS, { timeout: 5 }), run);
  assert.strictEqual(seen.length, 2);
  seen.forEach((o) => assert.strictEqual(o.timeoutMs, 5 * 60000));
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

test('checkFile: a timeout is reported with the minutes', async () => {
  const r = await checkFile(FILE, Object.assign({}, OPTS, { timeout: 7 }), fake({
    list: { status: null, signal: 'SIGTERM', timedOut: true, stdout: '', stderr: '' },
  }));
  assert.strictEqual(r.verdict, 'error');
  assert.strictEqual(r.detail, 'ffprobe could not list the video timestamps (timed out after 7 min): no output');
});

test('checkFile: error details never contain a line break', async () => {
  const r = await checkFile(FILE, OPTS, fake({ probe: { status: 1, stdout: '', stderr: 'first line\r\nsecond line\n\n  third\n' } }));
  assert.strictEqual(r.detail, 'ffprobe could not read the file (exit 1): first line | second line | third');
  assert.ok(!/[\r\n]/.test(r.detail));
});

test('collectFiles: walks folders, filters by extension, dedupes', (t) => {
  const root = tmpRoot(t);
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

test('collectFiles: paths are normalised and a file is listed once however it is reached', (t) => {
  const root = tmpRoot(t);
  const show = path.join(root, 'show');
  fs.mkdirSync(path.join(show, 'S1'), { recursive: true });
  const e1 = path.join(show, 'S1', 'E1.mkv');
  const e3 = path.join(show, 'E3.mkv');
  fs.writeFileSync(e1, '');
  fs.writeFileSync(e3, '');

  const forward = root.split(path.sep).join('/') + '/show/E3.mkv';
  const back = root.split(path.sep).join('\\') + '\\show\\E3.mkv';
  assert.deepStrictEqual(collectFiles([forward, back]).files, [path.resolve(forward)]);
  assert.deepStrictEqual(collectFiles([forward]).files, [e3]);

  // a file given directly and inside a folder that is also given, the first spelling is kept
  assert.deepStrictEqual(collectFiles([e3, show]).files, [e3, e1]);
  assert.deepStrictEqual(collectFiles([show, e3]).files, [e3, e1]);
  // overlapping folders
  assert.deepStrictEqual(collectFiles([show, path.join(show, 'S1')]).files, [e3, e1]);
  // relative paths are made absolute
  assert.deepStrictEqual(collectFiles([path.relative(process.cwd(), e3)]).files.map((f) => path.isAbsolute(f)), [true]);

  if (process.platform === 'win32') {
    assert.deepStrictEqual(collectFiles([e3, e3.toUpperCase()]).files, [e3]);
  }
});

test('collectFiles: follows folder links and does not loop', (t) => {
  const root = tmpRoot(t);
  const outside = path.join(root, 'outside');
  const tree = path.join(root, 'tree');
  fs.mkdirSync(outside);
  fs.mkdirSync(path.join(tree, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(outside, 'V.mkv'), '');
  fs.writeFileSync(path.join(tree, 'sub', 'W.mkv'), '');
  try {
    fs.symlinkSync(outside, path.join(tree, 'link'), 'junction');
    fs.symlinkSync(tree, path.join(tree, 'sub', 'back'), 'junction');
  } catch (e) {
    t.skip('cannot create links here: ' + e.message);
    return;
  }
  const r = collectFiles([tree]);
  assert.deepStrictEqual(r.problems, []);
  assert.deepStrictEqual(r.files, [path.join(tree, 'link', 'V.mkv'), path.join(tree, 'sub', 'W.mkv')]);
});

test('collectFiles: a folder that cannot be read is a problem, the rest is still collected', (t) => {
  const root = tmpRoot(t);
  const bad = path.join(root, 'bad');
  const good = path.join(root, 'good');
  fs.mkdirSync(bad);
  fs.mkdirSync(good);
  fs.writeFileSync(path.join(good, 'G.mkv'), '');
  const orig = fs.readdirSync;
  t.mock.method(fs, 'readdirSync', (dir, opts) => {
    if (dir === bad) throw new Error('EACCES: denied\nsecond line');
    return orig(dir, opts);
  });
  const r = collectFiles([bad, good]);
  assert.deepStrictEqual(r.files, [path.join(good, 'G.mkv')]);
  assert.deepStrictEqual(r.problems, [{ file: bad, verdict: 'error', detail: 'could not read the folder: EACCES: denied | second line' }]);
});

test('summarise: counts, singular and plural, sections, exit code', () => {
  const out = [];
  const results = [
    { file: 'a', verdict: 'clean', detail: 'x' },
    { file: 'b', verdict: 'damaged', detail: 'D', firstErrors: ['e1'] },
    { file: 'c', verdict: 'error', detail: 'bad' },
    { file: 'm', verdict: 'error', detail: 'not found' },
  ];
  const code = summarise(results, 3, (s) => out.push(s));
  assert.strictEqual(code, 1);
  assert.deepStrictEqual(out, [
    '',
    'Checked 3 files: 1 clean, 0 deliberate VFR, 1 damaged, 1 error, 0 skipped. 1 path not found.',
    '',
    'Damaged:',
    '  b',
    '    D',
    '    First decoder errors:',
    '      e1',
    '',
    'Errors:',
    '  c: bad',
    '  m: not found',
  ]);

  const out2 = [];
  const code2 = summarise([
    { file: 'a', verdict: 'clean', detail: 'x' },
    { file: 'b', verdict: 'error', detail: 'bad' },
    { file: 'c', verdict: 'error', detail: 'bad' },
    { file: 'm', verdict: 'error', detail: 'not found' },
    { file: 'n', verdict: 'error', detail: 'not found' },
  ], 1, (s) => out2.push(s));
  assert.strictEqual(code2, 3);
  assert.strictEqual(out2[1], 'Checked 1 file: 1 clean, 0 deliberate VFR, 0 damaged, 2 errors, 0 skipped. 2 paths not found.');

  const out3 = [];
  assert.strictEqual(summarise([{ file: 'a', verdict: 'vfr', detail: 'x' }, { file: 'b', verdict: 'skipped', detail: 'y' }], 2,
    (s) => out3.push(s)), 0);
  assert.deepStrictEqual(out3, ['', 'Checked 2 files: 0 clean, 1 deliberate VFR, 0 damaged, 0 errors, 1 skipped.']);
});

test('main: no paths prints usage and returns 2', async () => {
  const c = capture(fake());
  assert.strictEqual(await main([], c.deps), 2);
  assert.ok(c.err.join('\n').startsWith(USAGE_START));
});

test('main: --help prints usage and returns 0', async () => {
  const c = capture(fake());
  assert.strictEqual(await main(['--help'], c.deps), 0);
  assert.ok(c.out.join('\n').startsWith(USAGE_START));
  assert.ok(c.out.join('\n').includes('--timeout'));
});

test('main: unknown option', async () => {
  const c = capture(fake());
  assert.strictEqual(await main(['--bogus'], c.deps), 2);
  assert.strictEqual(c.err[0], 'unknown option --bogus');
  assert.ok(c.err[1].startsWith(USAGE_START));
});

test('main: an unusable ffprobe returns 2 before anything is checked', async (t) => {
  const root = tmpRoot(t);
  fs.writeFileSync(path.join(root, 'a.mkv'), '');
  const run = fake({ version: { error: new Error('spawn nosuch ENOENT'), status: null, signal: null, stdout: '', stderr: '' } });
  const c = capture(run);
  assert.strictEqual(await main(['--ffprobe', 'nosuch', root], c.deps), 2);
  assert.deepStrictEqual(c.err, ['ffprobe is not usable (not started): spawn nosuch ENOENT']);
  assert.deepStrictEqual(c.out, []);
  assert.deepStrictEqual(run.calls, [['nosuch', '-version']]);

  const c2 = capture(fake({ version: { status: 1, stdout: '', stderr: 'bad\nbuild\n' } }));
  assert.strictEqual(await main([root], c2.deps), 2);
  assert.deepStrictEqual(c2.err, ['ffprobe is not usable (exit 1): bad | build']);
});

test('main: a folder with no video files', async (t) => {
  const root = tmpRoot(t);
  fs.writeFileSync(path.join(root, 'notes.nfo'), '');
  const c = capture(fake());
  assert.strictEqual(await main([root], c.deps), 2);
  assert.ok(c.err.includes('No video files found.'));
});

test('main: reports damaged files and returns 1', async (t) => {
  const root = tmpRoot(t);
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
  assert.strictEqual(c.out[0], 'Found 2 video files.');
  assert.match(c.out[1], /^\[[12]\/2\] (CLEAN|DAMAGED) +.*[ab]\.mkv\t/);
  assert.match(c.out[2], /^\[[12]\/2\] (CLEAN|DAMAGED) +.*[ab]\.mkv\t/);
  const damagedLine = c.out.slice(1, 3).find((l) => l.includes('DAMAGED'));
  assert.strictEqual(damagedLine.slice(damagedLine.indexOf('DAMAGED')), 'DAMAGED ' + b + '\t' + DAMAGED_DETAIL);
  assert.deepStrictEqual(c.out.slice(3), [
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

test('main: one file is "Found 1 video file."; all clean returns 0', async (t) => {
  const root = tmpRoot(t);
  fs.writeFileSync(path.join(root, 'a.mkv'), '');
  const c = capture(fake());
  assert.strictEqual(await main([root], c.deps), 0);
  assert.strictEqual(c.out[0], 'Found 1 video file.');
  assert.ok(!c.out.includes('Damaged:'));
  assert.ok(c.out.includes('Checked 1 file: 1 clean, 0 deliberate VFR, 0 damaged, 0 errors, 0 skipped.'));
});

test('main: a missing path is listed under Errors but is not counted as a file or an error; exit 3', async (t) => {
  const root = tmpRoot(t);
  const a = path.join(root, 'a.mkv');
  const missing = path.join(root, 'nope');
  fs.writeFileSync(a, '');
  const c = capture(fake());
  assert.strictEqual(await main([missing, a], c.deps), 3);
  assert.ok(c.out.includes('Checked 1 file: 1 clean, 0 deliberate VFR, 0 damaged, 0 errors, 0 skipped. 1 path not found.'), c.out.join('\n'));
  assert.ok(c.out.includes('Errors:'));
  assert.ok(c.out.includes('  ' + missing + ': not found'));
});

test('main: a file that cannot be read gives exit 3 with a one-line error', async (t) => {
  const root = tmpRoot(t);
  fs.writeFileSync(path.join(root, 'a.mkv'), '');
  const c = capture(fake({ probe: { status: 1, stdout: '', stderr: 'one\ntwo\n' } }));
  assert.strictEqual(await main([root], c.deps), 3);
  const line = c.out.find((l) => l.startsWith('[1/1]'));
  assert.ok(line.includes('\tffprobe could not read the file (exit 1): one | two'), line);
  assert.ok(c.out.includes('Checked 1 file: 0 clean, 0 deliberate VFR, 0 damaged, 1 error, 0 skipped.'));
});

test('main: damaged wins over errors (exit 1)', async (t) => {
  const root = tmpRoot(t);
  const a = path.join(root, 'a.mkv');
  const b = path.join(root, 'b.mkv');
  fs.writeFileSync(a, '');
  fs.writeFileSync(b, '');
  const bad = fake({
    list: { status: 0, stdout: csv(HOLE), stderr: '' },
    decode: { status: 0, stdout: '144\n', stderr: BAD_STDERR },
  });
  const broken = fake({ probe: { status: 1, stdout: '', stderr: 'x' } });
  const c = capture((cmd, args) => (args[args.length - 1] === b ? bad : broken)(cmd, args));
  assert.strictEqual(await main([root], c.deps), 1);
});

test('main: a runner that throws is reported as an error for that file', async (t) => {
  const root = tmpRoot(t);
  fs.writeFileSync(path.join(root, 'a.mkv'), '');
  const run = async (cmd, args) => {
    if (args.includes('-version')) return { status: 0, stdout: '', stderr: '' };
    throw new Error('kaboom\nsecond');
  };
  const c = capture(run);
  assert.strictEqual(await main([root], c.deps), 3);
  const line = c.out.find((l) => l.startsWith('[1/1]'));
  assert.match(line, /^\[1\/1\] ERROR +.*a\.mkv\tkaboom \| second$/);
});

test('main: the same file given twice is checked once', async (t) => {
  const root = tmpRoot(t);
  const a = path.join(root, 'a.mkv');
  fs.writeFileSync(a, '');
  const c = capture(fake());
  assert.strictEqual(await main([a, root, a.split(path.sep).join('/')], c.deps), 0);
  assert.strictEqual(c.out[0], 'Found 1 video file.');
});

test('main: -j limits how many files are checked at once', async (t) => {
  const root = tmpRoot(t);
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

test('main: Ctrl+C prints Interrupted., the summary so far, and exits 130', async (t) => {
  const root = tmpRoot(t);
  for (let i = 1; i <= 3; i++) fs.writeFileSync(path.join(root, 'f' + i + '.mkv'), '');
  const inner = fake();
  let handler = null;
  let probes = 0;
  let unregistered = false;
  const exits = [];
  const run = async (cmd, args) => {
    if (args.includes(PROBE_ARG) && ++probes === 2) handler();
    return inner(cmd, args);
  };
  const c = capture(run, {
    onInterrupt: (fn) => { handler = fn; return () => { unregistered = true; }; },
    exit: (code) => exits.push(code),
  });
  assert.strictEqual(await main(['-j', '1', root], c.deps), 130);
  assert.deepStrictEqual(exits, [130]);
  assert.ok(unregistered);
  assert.strictEqual(c.out.filter((l) => l.startsWith('Checked')).length, 1);
  const i = c.out.indexOf('Interrupted.');
  assert.ok(i > 0, c.out.join('\n'));
  assert.deepStrictEqual(c.out.slice(i), [
    'Interrupted.',
    '',
    'Checked 1 file: 1 clean, 0 deliberate VFR, 0 damaged, 0 errors, 0 skipped.',
  ]);
});

test('runTool: captures status and output; a missing tool sets error', async () => {
  const r = await runTool(process.execPath, ['-e', 'process.stdout.write("hi");process.stderr.write("e");process.exit(3)']);
  assert.strictEqual(r.status, 3);
  assert.strictEqual(r.stdout, 'hi');
  assert.strictEqual(r.stderr, 'e');
  assert.ok(!r.timedOut);
  const m = await runTool('no-such-tool-xyz', []);
  assert.ok(m.error);
  assert.strictEqual(m.status, null);
});

test('runTool: kills a child that outlives the timeout', async () => {
  const start = Date.now();
  const r = await runTool(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], { timeoutMs: 200 });
  assert.strictEqual(r.timedOut, true);
  assert.ok(r.signal, 'signal is set');
  assert.ok(Date.now() - start < 8000);
});

test('runTool: a child that finishes in time is not marked timed out', async () => {
  const r = await runTool(process.execPath, ['-e', '0'], { timeoutMs: 20000 });
  assert.strictEqual(r.status, 0);
  assert.ok(!r.timedOut);
});

test('runTool: stops a child whose output exceeds the cap', async () => {
  const r = await runTool(process.execPath, ['-e', 'process.stdout.write("x".repeat(200000));setTimeout(()=>{},10000)'],
    { maxBytes: 1000 });
  assert.ok(r.error);
  assert.strictEqual(r.error.message, 'ffprobe output exceeded 1000 bytes');
  assert.strictEqual(r.status, null);
  const r2 = await runTool(process.execPath, ['-e', 'process.stderr.write("y".repeat(200000));setTimeout(()=>{},10000)'],
    { maxBytes: 1000 });
  assert.ok(r2.error);
});
