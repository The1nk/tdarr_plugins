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

const plugin = require(path.join(__dirname, '..', 'plugins', 'Tdarr_Plugin_00td_action_remove_stream_by_specified_property.js'));

const inputs = { propertyToCheck: 'codec_name', valuesToRemove: 'bmp' };
const run = (file) => plugin.plugin(Object.assign({ container: 'mkv' }, file), {}, inputs, {});

// Trimmed from DAN DA DAN S01E07: MediaInfo lists General, the media tracks and Menu (chapters),
// but not the font attachments ffprobe lists after the tracks.
const streams = [
  { index: 0, codec_type: 'video', codec_name: 'h264' },
  { index: 1, codec_type: 'audio', codec_name: 'aac' },
  { index: 2, codec_type: 'attachment', codec_name: 'unknown' },
  { index: 3, codec_type: 'attachment', codec_name: 'unknown' },
];
const mediaInfo = { track: [{ '@type': 'General' }, { '@type': 'Video' }, { '@type': 'Audio' }, { '@type': 'Menu' }] };

test('remove stream: streams MediaInfo does not list are checked by ffprobe alone, without errors', () => {
  const res = run({ ffProbeData: { streams }, mediaInfo });
  assert.doesNotMatch(res.infoLog, /Error/);
  assert.strictEqual(res.processFile, false);
  assert.match(res.infoLog, /File does not have streams which need to be removed/);
});

test('remove stream: an ffprobe match past the MediaInfo tracks is still removed', () => {
  const s = streams.concat([{ index: 4, codec_type: 'video', codec_name: 'bmp' }]);
  const res = run({ ffProbeData: { streams: s }, mediaInfo });
  assert.doesNotMatch(res.infoLog, /Error/);
  assert.strictEqual(res.processFile, true);
  assert.strictEqual(res.preset, ', -map 0 -c copy -max_muxing_queue_size 9999 -map -0:4 ');
  assert.match(res.infoLog, /Removing stream 4 which has codec_name of bmp/);
});

test('remove stream: a MediaInfo match is still removed; no MediaInfo at all is not an error', () => {
  const mi = { track: [{ '@type': 'General' }, { '@type': 'Video' }, { '@type': 'Audio', codec_name: 'bmp' }] };
  const res = run({ ffProbeData: { streams }, mediaInfo: mi });
  assert.strictEqual(res.processFile, true);
  assert.strictEqual(res.preset, ', -map 0 -c copy -max_muxing_queue_size 9999 -map -0:1 ');
  // Menu is chapters, not a stream: its properties never pair with an attachment.
  const menu = { track: [{ '@type': 'General' }, { '@type': 'Video' }, { '@type': 'Audio' }, { '@type': 'Menu', codec_name: 'bmp' }] };
  assert.strictEqual(run({ ffProbeData: { streams }, mediaInfo: menu }).processFile, false);
  const none = run({ ffProbeData: { streams } });
  assert.doesNotMatch(none.infoLog, /Error/);
  assert.strictEqual(none.processFile, false);
});
