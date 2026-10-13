// Integration test: run inside the tdarr-node container (see README "Tests").
// Usage: node /tmp/itest/plugins/convert_unsupported_subs.itest.js "<source mkv under /media>"
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SRC = process.argv[2];
const ROOT = '/tmp/itest';
const WORK = path.join(ROOT, 'work');
const FFPROBE = '/app/Tdarr_Node/assets/app/ffmpeg/linux_x64/ffprobe';
const run = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 100 * 1024 * 1024 });

const convert = require(path.join(ROOT, 'plugins', 'Local', 'Tdarr_Plugin_the1nk_convert_unsupported_subs.js'));
const drc = require(path.join(ROOT, 'plugins', 'Local', 'Tdarr_Plugin_the1nk_downmix_to_stereo_and_apply_DRC.js'));

const fileObj = (p) => {
  const r = run(FFPROBE, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', '--', p]);
  assert.strictEqual(r.status, 0, 'ffprobe failed: ' + r.stderr);
  return { _id: p, file: p, container: 'mkv', ffProbeData: JSON.parse(r.stdout) };
};
const otherArgs = (cacheFilePath) => ({ cacheFilePath, ffmpegPath: 'tdarr-ffmpeg', mkvpropeditPath: 'mkvpropedit' });

// Runs the DRC plugin's preset on p (first 60s only) and returns the ffmpeg exit code.
const runDrc = (p, out) => {
  const res = drc.plugin(fileObj(p), {}, {}, {});
  assert.strictEqual(res.processFile, true, 'DRC plugin did not want to process ' + p);
  const toArgs = (s) => (s.match(/"[^"]*"|\S+/g) || []).map((a) => a.replace(/^"|"$/g, ''));
  const [pre, post] = res.preset.split('<io>');
  const r = run('tdarr-ffmpeg', [...toArgs(pre), '-hide_banner', '-v', 'error', '-y', '-i', p, ...toArgs(post), '-t', '60', out]);
  return r.status;
};

fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
try {
  // 1. Reproduce the original failure on the untouched source.
  assert.notStrictEqual(runDrc(SRC, path.join(WORK, 'drc-source.mkv')), 0, 'expected DRC ffmpeg to fail on the source');
  console.log('PASS 1: DRC ffmpeg fails on the source (bug reproduced)');

  // 2. Convert.
  const cache = path.join(WORK, path.basename(SRC));
  const res = convert.plugin(fileObj(SRC), {}, {}, otherArgs(cache));
  console.log(res.infoLog);
  assert.strictEqual(res.error, undefined, res.error);
  assert.strictEqual(res.file._id, cache);
  assert.ok(fs.existsSync(cache));
  // The plugin's temp files are track<N>.vtt, track<N>.srt and kept<N>.srt, all next to the output.
  assert.deepStrictEqual(fs.readdirSync(WORK).filter((f) => /^(track|kept)\d+\.(vtt|srt)$/.test(f)), [], 'temp files left behind');
  const subs = fileObj(cache).ffProbeData.streams.filter((s) => s.codec_type === 'subtitle');
  assert.ok(subs.length > 0 && subs.every((s) => s.codec_name && s.codec_name !== 'unknown' && s.codec_name !== 'none'), 'unreadable subtitle left');
  console.log('PASS 2: converted, subtitle codecs now: ' + subs.map((s) => s.codec_name).join(','));

  // 3. Second run on the output is a no-op.
  const again = convert.plugin(fileObj(cache), {}, {}, otherArgs(path.join(WORK, 'again.mkv')));
  assert.strictEqual(again.error, undefined);
  assert.strictEqual(again.file._id, cache);
  assert.match(again.infoLog, /readable/);
  console.log('PASS 3: second run skips');

  // 4. The step that failed in production now works.
  assert.strictEqual(runDrc(cache, path.join(WORK, 'drc-converted.mkv')), 0, 'DRC ffmpeg failed on converted file');
  console.log('PASS 4: DRC ffmpeg succeeds on the converted file');
  console.log('ALL PASS');
} finally {
  fs.rmSync(WORK, { recursive: true, force: true });
}
