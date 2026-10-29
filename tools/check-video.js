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
