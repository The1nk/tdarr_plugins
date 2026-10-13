// Integration test: runs the real convert-unsupported-subs plugin, with Tdarr's real methods/lib,
// mkvtoolnix and FFmpeg, against a real MKV with a WebVTT subtitle track. Run it inside the
// tdarr-node container (see README "Tests"). It writes only under /tmp/itest and never touches the source.
//
// Stage the files (from the repo root, Git Bash; MSYS_NO_PATHCONV stops container paths being rewritten):
//   MSYS_NO_PATHCONV=1 docker exec tdarr-node sh -c 'rm -rf /tmp/itest && mkdir -p /tmp/itest/plugins/Local && ln -s /app/Tdarr_Node/assets/app/plugins/methods /tmp/itest/plugins/methods'
//   MSYS_NO_PATHCONV=1 docker cp Tdarr_Plugin_the1nk_convert_unsupported_subs.js tdarr-node:/tmp/itest/plugins/Local/
//   MSYS_NO_PATHCONV=1 docker cp Tdarr_Plugin_the1nk_downmix_to_stereo_and_apply_DRC.js tdarr-node:/tmp/itest/plugins/Local/
//   MSYS_NO_PATHCONV=1 docker cp tests/container/convert_unsupported_subs.itest.js tdarr-node:/tmp/itest/plugins/
// Run it (takes a few minutes on a large file):
//   MSYS_NO_PATHCONV=1 docker exec tdarr-node node /tmp/itest/plugins/convert_unsupported_subs.itest.js "<source mkv under /media>"
// Clean up afterwards:
//   MSYS_NO_PATHCONV=1 docker exec tdarr-node rm -rf /tmp/itest
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SRC = process.argv[2];
if (!SRC || !fs.existsSync(SRC)) {
  console.error('Usage: node /tmp/itest/plugins/convert_unsupported_subs.itest.js "<source mkv under /media>"');
  process.exit(2);
}

const ROOT = '/tmp/itest';
const WORK = path.join(ROOT, 'work');
const FFPROBE = '/app/Tdarr_Node/assets/app/ffmpeg/linux_x64/ffprobe';
const run = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 100 * 1024 * 1024 });

const convert = require(path.join(ROOT, 'plugins', 'Local', 'Tdarr_Plugin_the1nk_convert_unsupported_subs.js'));
const drc = require(path.join(ROOT, 'plugins', 'Local', 'Tdarr_Plugin_the1nk_downmix_to_stereo_and_apply_DRC.js'));

const probe = (p) => {
  const r = run(FFPROBE, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', '--', p]);
  assert.strictEqual(r.status, 0, 'ffprobe failed: ' + r.stderr);
  return JSON.parse(r.stdout);
};
const fileObj = (p) => ({ _id: p, file: p, container: 'mkv', ffProbeData: probe(p) });
const otherArgs = (cacheFilePath) => ({ cacheFilePath, ffmpegPath: 'tdarr-ffmpeg', mkvpropeditPath: 'mkvpropedit' });
const unreadable = (s) => !s.codec_name || s.codec_name === 'unknown' || s.codec_name === 'none';

// Runs the DRC plugin's preset on p (first 60s only) and returns the whole spawnSync result.
const runDrc = (p, out) => {
  const res = drc.plugin(fileObj(p), {}, {}, {});
  assert.strictEqual(res.processFile, true, 'DRC plugin did not want to process ' + p);
  const toArgs = (s) => (s.match(/"[^"]*"|\S+/g) || []).map((a) => a.replace(/^"|"$/g, ''));
  const [pre, post] = res.preset.split('<io>');
  return run('tdarr-ffmpeg', [...toArgs(pre), '-hide_banner', '-v', 'error', '-y', '-i', p, ...toArgs(post), '-t', '60', out]);
};

fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
try {
  // 1. Reproduce the original failure on the untouched source.
  const srcSubs = probe(SRC).streams.filter((s) => s.codec_type === 'subtitle');
  assert.ok(srcSubs.some(unreadable), 'the source has no unreadable subtitle stream');
  const before = runDrc(SRC, path.join(WORK, 'drc-source.mkv'));
  assert.strictEqual(before.error, undefined, 'could not run ffmpeg: ' + (before.error && before.error.message));
  assert.ok(typeof before.status === 'number' && before.status !== 0, 'expected DRC ffmpeg to fail on the source, status ' + before.status);
  assert.match(before.stderr, /Subtitle codec 0 is not supported/, 'ffmpeg failed for another reason: ' + before.stderr);
  console.log('PASS 1: DRC ffmpeg fails on the source with the production error (bug reproduced)');

  // 2. Convert.
  const cache = path.join(WORK, path.basename(SRC));
  const res = convert.plugin(fileObj(SRC), {}, {}, otherArgs(cache));
  console.log(res.infoLog);
  assert.strictEqual(res.error, undefined, res.error);
  assert.strictEqual(res.file._id, cache);
  // The handoff Tdarr relies on: a new file, with nothing for the runner to process or update.
  assert.strictEqual(res.processFile, false);
  assert.strictEqual(res.updateDB, false);
  assert.strictEqual(res.removeFromDB, false);
  assert.ok(fs.existsSync(cache));
  // Only the converted file and the failed DRC attempt's output may be in WORK (no track*.vtt/srt, kept*.srt, ...).
  const expected = new Set([path.basename(cache), 'drc-source.mkv']);
  assert.deepStrictEqual(fs.readdirSync(WORK).filter((f) => !expected.has(f)), [], 'unexpected files left behind');
  const subs = probe(cache).streams.filter((s) => s.codec_type === 'subtitle');
  assert.ok(subs.length > 0 && !subs.some(unreadable), 'unreadable subtitle left');
  console.log('PASS 2: converted, subtitle codecs now: ' + subs.map((s) => s.codec_name).join(','));

  // 3. Second run on the output is a no-op.
  const again = convert.plugin(fileObj(cache), {}, {}, otherArgs(path.join(WORK, 'again.mkv')));
  assert.strictEqual(again.error, undefined);
  assert.strictEqual(again.file._id, cache);
  assert.match(again.infoLog, /readable/);
  console.log('PASS 3: second run skips');

  // 4. The step that failed in production now works.
  const drcOut = path.join(WORK, 'drc-converted.mkv');
  const after = runDrc(cache, drcOut);
  assert.strictEqual(after.error, undefined, 'could not run ffmpeg: ' + (after.error && after.error.message));
  assert.strictEqual(after.status, 0, 'DRC ffmpeg failed on converted file: ' + after.stderr);
  assert.ok(fs.existsSync(drcOut), 'DRC output missing');
  const outTypes = probe(drcOut).streams.map((s) => s.codec_type + ':' + s.codec_name);
  assert.ok(outTypes.some((t) => t.startsWith('video:')), 'DRC output has no video: ' + outTypes);
  assert.ok(outTypes.some((t) => t.startsWith('audio:')), 'DRC output has no audio: ' + outTypes);
  assert.ok(outTypes.includes('subtitle:subrip'), 'DRC output has no subrip subtitle: ' + outTypes);
  console.log('PASS 4: DRC ffmpeg succeeds on the converted file (' + outTypes.join(',') + ')');
  console.log('ALL PASS');
  fs.rmSync(WORK, { recursive: true, force: true });
} catch (e) {
  console.error('FAILED. Work files kept for inspection in ' + WORK);
  throw e;
}
