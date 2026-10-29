#!/usr/bin/env node
// Checks video files for missing frames with the Detect Damaged Video plugin's rules.
// Usage: node tools/check-video.js [--all] [-j N] [--timeout MIN] [--ffprobe <path>] <file or folder>...
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const rules = require('../plugins/Tdarr_Plugin_the1nk_detect_damaged_video.js')._test;

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
// setTimeout fires at once beyond 2^31-1 ms, so --timeout stops there (about 35791 minutes).
const MAX_TIMER_MS = 2147483647;
const MAX_TIMEOUT_MIN = 35791;

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
    else if (status === CONTROL_C || signal === 'SIGINT') r.interrupted = true;
    finish(r);
  });
  if (o.timeoutMs > 0 && o.timeoutMs <= MAX_TIMER_MS) {
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
    real = fs.realpathSync.native(dir);
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
        real = fs.realpathSync.native(f);
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
      if (!Number.isInteger(n) || n < 0 || n > MAX_TIMEOUT_MIN) {
        return Object.assign(o, { error: '--timeout needs a whole number of minutes from 0 to ' + MAX_TIMEOUT_MIN + ' (0 = none)' });
      }
      o.timeout = n;
    } else if (a === '--ffprobe') {
      if (argv[i + 1] === undefined || argv[i + 1].startsWith('-')) return Object.assign(o, { error: '--ffprobe needs a path' });
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
  d.out('Found ' + plural(files.length, 'file') + ' to check.');

  const results = problems.slice();
  let next = 0;
  let done = 0;
  let interrupted = false;
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
    while (!interrupted && next < files.length) {
      const file = files[next++];
      let hit = false;
      const run = async (cmd, args, ropts) => {
        const res = await d.run(cmd, args, ropts);
        if (res && (res.interrupted || res.status === CONTROL_C || (res.signal === 'SIGINT' && !res.timedOut))) hit = true;
        return res;
      };
      let r;
      try {
        r = await checkFile(file, o, run);
      } catch (e) {
        r = { file, verdict: 'error', detail: oneLine(e.message) };
      }
      if (hit) interrupt(); // Ctrl+C reached an ffprobe before node's own handler ran
      if (interrupted) return;
      results.push(r);
      done++;
      d.out('[' + done + '/' + files.length + '] ' + LABEL[r.verdict].padEnd(7) + ' ' + r.file + '\t' + r.detail);
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(o.jobs, files.length) }, worker));
    if (interrupted) return 130;
    return summarise(results, files.length, d.out);
  } finally {
    if (typeof off === 'function') off();
  }
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
