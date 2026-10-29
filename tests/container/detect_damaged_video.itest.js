// Integration test: runs the real Detect Damaged Video and Repair Frame Rate plugins, with Tdarr's real
// methods/lib, FFmpeg and ffprobe, against small videos it builds itself: clean, steady at an odd rate,
// a steady near-miss (23185/967), variable-frame-rate on purpose, and damaged (frames cut out of the encoded stream). Run it inside the
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
  // re-measure them. Fixtures: -threads 1 only pins x264's output bytes, as a precaution. Detect decodes with
  // -threads 0 (all cores); measured in the Tdarr node, the error counts do not depend on threading (3 runs each
  // at -threads 1 and -threads 0: 0 errors for vfr.mkv, 3 for damaged.mkv), and single-threaded ffprobe took 334 s
  // on a 24-minute 1080p episode, while threading cut a 180 s window from 45 s to 16 s.
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
  assert.ok(!mm.error && (mm.status === 0 || mm.status === 1), 'mkvmerge failed: ' + mm.stdout + mm.stderr);

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
    + 'and 3 decode errors. The source is missing frames; replace it with a clean copy. '
    + 'First error: h264: reference picture missing during reorder');

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
