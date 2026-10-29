const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const path = require('path');

// The plugin does require('../methods/lib') (Tdarr's runtime). Stub it for local runs.
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '../methods/lib') {
    return () => ({ loadDefaultValues: (inputs) => inputs || {} });
  }
  return origLoad.call(this, request, parent, isMain);
};

const migz = require(path.join(__dirname, '..', 'Tdarr_Plugin_MC93_Migz1Remux.js'));

const run = (file) => migz.plugin(file, {}, { container: 'mkv', force_conform: true }, {});
const video = (extra) => Object.assign({ codec_type: 'video', codec_name: 'h264', disposition: { attached_pic: 0 } }, extra);
const audio = (codec) => ({ codec_type: 'audio', codec_name: codec });

test('migz remux: a .ts labelled audio but holding a video stream is remuxed to mkv with genpts', () => {
  const res = run({ container: 'ts', fileMedium: 'audio', ffProbeData: { streams: [video(), audio('aac')] } });
  assert.strictEqual(res.processFile, true);
  assert.strictEqual(res.preset, '-fflags +genpts, -map 0 -c copy -max_muxing_queue_size 9999 -map -0:d ');
  assert.strictEqual(res.container, '.mkv');
  assert.ok(res.infoLog.includes('☒File is ts but requested to be mkv container. Remuxing.'), res.infoLog);
});

test('migz remux: audio whose only video stream is cover art is not a video', () => {
  const res = run({ container: 'mp3', fileMedium: 'audio', ffProbeData: { streams: [
    audio('mp3'), video({ codec_name: 'mjpeg', disposition: { attached_pic: 1 } })] } });
  assert.strictEqual(res.processFile, false);
  assert.strictEqual(res.infoLog, '☒File is not a video. \n');
});

test('migz remux: an audio-only file is not a video', () => {
  const res = run({ container: 'm4a', fileMedium: 'audio', ffProbeData: { streams: [audio('aac')] } });
  assert.strictEqual(res.processFile, false);
  assert.strictEqual(res.infoLog, '☒File is not a video. \n');
});

test('migz remux: an mkv video is already in the container', () => {
  const res = run({ container: 'mkv', fileMedium: 'video', ffProbeData: { streams: [video()] } });
  assert.strictEqual(res.processFile, false);
  assert.ok(res.infoLog.includes('☑File is already in mkv container.'), res.infoLog);
});

test('migz remux: a normal mp4 video is remuxed without genpts', () => {
  const res = run({ container: 'mp4', fileMedium: 'video', ffProbeData: { streams: [video(), audio('aac')] } });
  assert.strictEqual(res.processFile, true);
  assert.strictEqual(res.preset, ', -map 0 -c copy -max_muxing_queue_size 9999 -map -0:d ');
});

test('migz remux: missing ffProbeData on an audio file is not a video and does not crash', () => {
  const res = run({ container: 'ts', fileMedium: 'audio' });
  assert.strictEqual(res.processFile, false);
  assert.strictEqual(res.infoLog, '☒File is not a video. \n');
});
