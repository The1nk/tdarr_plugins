# Convert Unsupported Subtitles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop Tdarr flows failing on MKVs whose subtitle tracks FFmpeg can't read (e.g. WebVTT stored with the Matroska codec ID `S_TEXT/WEBVTT`), by converting those tracks to SRT (and dropping any other unreadable subtitle track) before any FFmpeg step runs.

**Architecture:** A new flow-only classic transcode plugin, `Tdarr_Plugin_the1nk_convert_unsupported_subs`, modelled on `Tdarr_Plugin_the1nk_repair_framerate.js`. It detects subtitle streams that ffprobe reports without a codec, uses mkvtoolnix (`mkvmerge -J`, `mkvextract`) plus FFmpeg (`.vtt` → `.srt`) and `mkvmerge` to write a new MKV to the flow's `cacheFilePath` with the converted tracks in their original positions, verifies it, and hands it to the next flow plugin by returning `response.file` with the new `_id`. It never edits the library file. It is inserted into all five flows right after the Processed Tag Filter, before the first FFmpeg step.

**Tech Stack:** Node.js (Tdarr classic plugin API), mkvtoolnix v99 (`mkvmerge`, `mkvextract`, in the Tdarr node image next to `mkvpropedit`), FFmpeg 7.1 (`tdarr-ffmpeg`), Tdarr's bundled ffprobe, `node:test` for unit tests.

---

## Background (read this first)

- Failing job: `Good Boy (2025) {imdb-tt35521922} ().mkv`. Its subtitle track (mkvmerge track ID 2) has codec ID `S_TEXT/WEBVTT`. FFmpeg 7.1.4 (and an Aug-2025 FFmpeg git build) can't demux that codec ID. ffprobe reports the stream with **no `codec_name`** (Tdarr's `file.ffProbeData.streams[2]` has `codec_type: 'subtitle'` and no `codec_name` key; standalone ffprobe prints `unknown`). Any `-map 0 -c copy` / `-map 0:s? -c:s copy` then fails with `Subtitle codec 0 is not supported` / `Could not write header`.
- Verified by hand inside the `tdarr-node` container (all exit 0):
  - `mkvextract SRC tracks 2:/tmp/x/t2.vtt` → a valid WEBVTT file, 285 cues.
  - `tdarr-ffmpeg -hide_banner -v error -y -i t2.vtt -c:s srt t2.srt` → 285 cues (ffprobe `-count_packets` gives `nb_read_packets: "285"` for both).
  - `mkvmerge -o out.mkv --subtitle-tracks '!2' SRC --language 0:en --default-track-flag 0:yes --forced-display-flag 0:no --sub-charset 0:UTF-8 t2.srt --track-order 0:0,0:1,1:0` → out.mkv streams: h264, aac, subrip (codec ID `S_TEXT/UTF8`) in that order.
  - The DRC plugin's exact preset then runs fine on out.mkv.
- How flows run classic plugins (Tdarr node, `FlowHelpers/1.0.0/classicPlugins.js`): `otherArguments` = `{ handbrakePath, ffmpegPath, mkvpropeditPath, originalLibraryFile, nodeHardwareType, pluginCycle, workerType, version, platform_arch_isdocker, cacheFilePath, job }`. If the plugin returns `response.file._id` different from the input `_id`, the runner switches the flow's working file to it. If `response.error` is set, the job fails with that message. `ffmpegPath` is `tdarr-ffmpeg` on this node.
- Tdarr's bundled ffprobe is `/app/Tdarr_Node/assets/app/ffmpeg/linux_x64/ffprobe` (not reliably on PATH).
- mkvmerge / mkvextract exit codes: 0 = ok, 1 = ok with warnings, 2 = error.
- mkvmerge track IDs and ffprobe stream indexes both count tracks in file order (ffprobe lists attachments after all tracks), so ffprobe stream index N is mkvmerge track ID N. The plugin guards this by checking the types match.
- Repo conventions: see `CLAUDE.md` and `README.md`. Plugin files sit in the repo root. `push.ps1` copies only root `*.js`, so `tests/` is never deployed. Work on branch `convert-unsupported-subs`. Commit at the end of each task (never push). Commit messages end with a blank line and then `Claude-Session: https://claude.ai/code/session_01DrjEQXEq8Gpf6bmsJf8KNb`.
- Windows dev box: never redirect to `/dev/null`. In PowerShell, a `’` (U+2019) inside a command breaks quoting, so pass such paths through files/scripts.

## File Structure

- Create: `Tdarr_Plugin_the1nk_convert_unsupported_subs.js`. The plugin. Exports `details`, `plugin`, and `_test` (pure helpers for unit tests).
- Create: `tests/convert_unsupported_subs.test.js`. Unit tests (`node --test`), with no external tools.
- Create: `tests/container/convert_unsupported_subs.itest.js`. Integration test, run inside the `tdarr-node` container against the real Good Boy file.
- Modify: `flowMovies.json`, `flowAnimovies.json`, `flowShows.json`, `flowAnishows.json`, `flowOtherVideos.json` and their `*.local.json` twins (gitignored): insert the new plugin node.
- Modify: `README.md`: flow diagram, ordering rules, plugin docs.

---

### Task 1: Pure helpers + unit tests

**Files:**
- Create: `tests/convert_unsupported_subs.test.js`
- Create: `Tdarr_Plugin_the1nk_convert_unsupported_subs.js`

- [ ] **Step 1: Write the failing unit tests**

Create `tests/convert_unsupported_subs.test.js`:

```js
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

const pluginModule = require(path.join(__dirname, '..', 'Tdarr_Plugin_the1nk_convert_unsupported_subs.js'));
const { findUnreadableSubs, planTracks, buildMerge } = pluginModule._test;

// Trimmed from the real "Good Boy (2025)" file.
const goodBoyStreams = [
  { index: 0, codec_type: 'video', codec_name: 'h264' },
  { index: 1, codec_type: 'audio', codec_name: 'aac' },
  { index: 2, codec_type: 'subtitle' },
];
const goodBoyTracks = [
  { id: 0, type: 'video', codec: 'AVC/H.264/MPEG-4p10', properties: { codec_id: 'V_MPEG4/ISO/AVC', language: 'eng', language_ietf: 'en' } },
  { id: 1, type: 'audio', codec: 'AAC', properties: { codec_id: 'A_AAC', language: 'eng', language_ietf: 'en' } },
  { id: 2, type: 'subtitles', codec: 'WebVTT', properties: { codec_id: 'S_TEXT/WEBVTT', language: 'eng', language_ietf: 'en', default_track: true, forced_track: false } },
];

test('findUnreadableSubs: subtitle stream with no codec_name', () => {
  assert.deepStrictEqual(findUnreadableSubs(goodBoyStreams), [2]);
});

test('findUnreadableSubs: unknown/none count as unreadable, readable subs and non-subtitle streams do not', () => {
  const streams = [
    { index: 0, codec_type: 'video', codec_name: 'h264' },
    { index: 1, codec_type: 'data' },
    { index: 2, codec_type: 'subtitle', codec_name: 'subrip' },
    { index: 3, codec_type: 'subtitle', codec_name: 'unknown' },
    { index: 4, codec_type: 'subtitle', codec_name: 'none' },
  ];
  assert.deepStrictEqual(findUnreadableSubs(streams), [3, 4]);
});

test('findUnreadableSubs: missing stream list', () => {
  assert.deepStrictEqual(findUnreadableSubs(undefined), []);
});

test('planTracks: S_TEXT/WEBVTT is converted, other unreadable subtitles are dropped', () => {
  const tracks = goodBoyTracks.concat([
    { id: 3, type: 'subtitles', codec: 'HDMV TextST', properties: { codec_id: 'S_HDMV/TEXTST' } },
  ]);
  const plan = planTracks(tracks, [2, 3]);
  assert.strictEqual(plan.error, undefined);
  assert.deepStrictEqual(plan.convert.map((t) => t.id), [2]);
  assert.deepStrictEqual(plan.drop.map((t) => t.id), [3]);
});

test('planTracks: error when the ffprobe index is not an mkvmerge subtitle track', () => {
  assert.match(planTracks(goodBoyTracks, [1]).error, /stream 1/);
  assert.match(planTracks(goodBoyTracks, [7]).error, /stream 7/);
});

test('buildMerge: Good Boy layout matches the hand-verified mkvmerge command', () => {
  const plan = planTracks(goodBoyTracks, [2]);
  const built = buildMerge('/in/a.mkv', '/out/a.mkv', goodBoyTracks, plan, { 2: '/w/track2.srt' });
  assert.deepStrictEqual(built.args, [
    '-o', '/out/a.mkv',
    '--subtitle-tracks', '!2',
    '/in/a.mkv',
    '--language', '0:en',
    '--default-track-flag', '0:yes',
    '--forced-display-flag', '0:no',
    '--sub-charset', '0:UTF-8',
    '/w/track2.srt',
    '--track-order', '0:0,0:1,1:0',
  ]);
  assert.deepStrictEqual(built.layout.map((l) => [l.track.id, l.converted]), [[0, false], [1, false], [2, true]]);
});

test('buildMerge: keeps original positions with mixed keep/convert/drop and passes names and HI flag', () => {
  const tracks = [
    { id: 0, type: 'video', properties: { codec_id: 'V_MPEGH/ISO/HEVC' } },
    { id: 1, type: 'audio', properties: { codec_id: 'A_EAC3' } },
    { id: 2, type: 'subtitles', properties: { codec_id: 'S_TEXT/WEBVTT', language: 'spa', track_name: 'Spanish', default_track: false, forced_track: true } },
    { id: 3, type: 'subtitles', properties: { codec_id: 'S_TEXT/UTF8', language: 'eng' } },
    { id: 4, type: 'subtitles', properties: { codec_id: 'S_HDMV/TEXTST' } },
    { id: 5, type: 'subtitles', properties: { codec_id: 'S_TEXT/WEBVTT', language: 'eng', language_ietf: 'en-US', default_track: false, forced_track: false, flag_hearing_impaired: true } },
  ];
  const plan = planTracks(tracks, [2, 4, 5]);
  const built = buildMerge('/in/b.mkv', '/out/b.mkv', tracks, plan, { 2: '/w/track2.srt', 5: '/w/track5.srt' });
  assert.deepStrictEqual(built.args, [
    '-o', '/out/b.mkv',
    '--subtitle-tracks', '!2,4,5',
    '/in/b.mkv',
    '--language', '0:spa',
    '--track-name', '0:Spanish',
    '--default-track-flag', '0:no',
    '--forced-display-flag', '0:yes',
    '--sub-charset', '0:UTF-8',
    '/w/track2.srt',
    '--language', '0:en-US',
    '--default-track-flag', '0:no',
    '--forced-display-flag', '0:no',
    '--hearing-impaired-flag', '0:yes',
    '--sub-charset', '0:UTF-8',
    '/w/track5.srt',
    '--track-order', '0:0,0:1,1:0,0:3,2:0',
  ]);
  assert.deepStrictEqual(built.layout.map((l) => [l.track.id, l.converted]), [[0, false], [1, false], [2, true], [3, false], [5, true]]);
});

const call = (file, otherArguments) => pluginModule.plugin(file, {}, {}, otherArguments);

test('plugin: skips non-MKV files', () => {
  const res = call({ _id: '/m/a.mp4', container: 'mp4', ffProbeData: { streams: goodBoyStreams } }, { cacheFilePath: '/w/a.mp4' });
  assert.strictEqual(res.processFile, false);
  assert.strictEqual(res.error, undefined);
  assert.strictEqual(res.file._id, '/m/a.mp4');
  assert.match(res.infoLog, /not MKV/);
});

test('plugin: skips when every subtitle track is readable', () => {
  const streams = [{ index: 0, codec_type: 'video', codec_name: 'h264' }, { index: 1, codec_type: 'subtitle', codec_name: 'subrip' }];
  const res = call({ _id: '/m/a.mkv', container: 'mkv', ffProbeData: { streams } }, { cacheFilePath: '/w/a.mkv' });
  assert.strictEqual(res.error, undefined);
  assert.strictEqual(res.file._id, '/m/a.mkv');
  assert.match(res.infoLog, /readable/);
});

test('plugin: skips outside a flow (no cacheFilePath)', () => {
  const res = call({ _id: '/m/a.mkv', container: 'mkv', ffProbeData: { streams: goodBoyStreams } }, {});
  assert.strictEqual(res.error, undefined);
  assert.strictEqual(res.file._id, '/m/a.mkv');
  assert.match(res.infoLog, /cacheFilePath/);
});

test('details: id matches the filename', () => {
  assert.strictEqual(pluginModule.details().id, 'Tdarr_Plugin_the1nk_convert_unsupported_subs');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from repo root, Bash): `node --test tests/*.test.js`
Expected: FAIL, `Cannot find module '...Tdarr_Plugin_the1nk_convert_unsupported_subs.js'`.

- [ ] **Step 3: Write the plugin**

Create `Tdarr_Plugin_the1nk_convert_unsupported_subs.js`:

```js
/* eslint-disable */

// tdarrSkipTest
const details = () => {
  return {
    id: "Tdarr_Plugin_the1nk_convert_unsupported_subs",
    Stage: "Pre-processing",
    Name: "Convert unsupported subtitles",
    Type: "Video",
    Operation: "Transcode",
    Description: `Fixes MKV subtitle tracks that FFmpeg can't read (ffprobe reports no codec), which make every later "-map 0 -c copy" step fail with "Subtitle codec 0 is not supported". WebVTT tracks stored with the newer S_TEXT/WEBVTT codec ID are extracted with mkvextract, converted to SRT, and muxed back in their original position with their language, name and flags. Any other unreadable subtitle track is dropped. The result is verified (track layout, codecs, cue counts, duration) before it is used; if anything fails the job fails with the reason and the library file is left untouched. Flow-only: runs mkvtoolnix itself and hands the new file to the next flow plugin.`,
    Version: "1.00",
    Tags: "pre-processing,mkvmerge,subtitle",
    Inputs: [],
  };
};

var WEBVTT_CODEC_ID = 'S_TEXT/WEBVTT';
var SRT_CODEC_ID = 'S_TEXT/UTF8';
// Tdarr's bundled ffprobe (not on PATH in the Tdarr container), then PATH.
var FFPROBE_CANDIDATES = ['/app/Tdarr_Node/assets/app/ffmpeg/linux_x64/ffprobe', 'ffprobe'];

// ffprobe leaves codec_name unset (or 'unknown'/'none') for codecs it can't demux.
var isUnreadable = function (stream) {
  return !stream.codec_name || stream.codec_name === 'unknown' || stream.codec_name === 'none';
};

var findUnreadableSubs = function (streams) {
  return (streams || [])
    .filter(function (s) { return s.codec_type === 'subtitle' && isUnreadable(s); })
    .map(function (s) { return s.index; });
};

// mkvmerge track IDs and ffprobe stream indexes both count tracks in file order
// (ffprobe lists attachments after all tracks), so ffprobe stream N is mkvmerge track N.
var planTracks = function (mkvTracks, unreadableIdx) {
  var convert = [];
  var drop = [];
  for (var i = 0; i < unreadableIdx.length; i += 1) {
    var idx = unreadableIdx[i];
    var track = mkvTracks.find(function (t) { return t.id === idx; });
    if (!track || track.type !== 'subtitles') {
      return { error: 'ffprobe subtitle stream ' + idx + ' has no matching mkvmerge subtitle track' };
    }
    if ((track.properties || {}).codec_id === WEBVTT_CODEC_ID) convert.push(track);
    else drop.push(track);
  }
  return { convert: convert, drop: drop };
};

var yesNo = function (v) { return v ? 'yes' : 'no'; };

// Builds the mkvmerge command: the source minus every unreadable subtitle track, plus one
// SRT input per converted track, ordered so converted tracks sit where the originals were.
// layout lists the expected output tracks in order.
var buildMerge = function (input, output, mkvTracks, plan, srtPaths) {
  var removed = plan.convert.concat(plan.drop).map(function (t) { return t.id; });
  var args = ['-o', output, '--subtitle-tracks', '!' + removed.join(','), input];
  var order = [];
  var layout = [];
  var fileNo = 0;
  mkvTracks.forEach(function (t) {
    if (plan.drop.indexOf(t) !== -1) return;
    if (plan.convert.indexOf(t) === -1) {
      order.push('0:' + t.id);
      layout.push({ track: t, converted: false });
      return;
    }
    var p = t.properties || {};
    args.push('--language', '0:' + (p.language_ietf || p.language || 'und'));
    if (p.track_name) args.push('--track-name', '0:' + p.track_name);
    args.push('--default-track-flag', '0:' + yesNo(p.default_track));
    args.push('--forced-display-flag', '0:' + yesNo(p.forced_track));
    if (p.flag_hearing_impaired !== undefined) args.push('--hearing-impaired-flag', '0:' + yesNo(p.flag_hearing_impaired));
    args.push('--sub-charset', '0:UTF-8', srtPaths[t.id]);
    fileNo += 1;
    order.push(fileNo + ':0');
    layout.push({ track: t, converted: true });
  });
  args.push('--track-order', order.join(','));
  return { args: args, layout: layout };
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const plugin = (file, librarySettings, inputs, otherArguments) => {

  const lib = require('../methods/lib')();
  // eslint-disable-next-line @typescript-eslint/no-unused-vars,no-param-reassign
  inputs = lib.loadDefaultValues(inputs, details);
  var fs = require('fs');
  var path = require('path');
  var spawnSync = require('child_process').spawnSync;

  var response = {
    file,
    removeFromDB: false,
    updateDB: false,
    infoLog: "",
    processFile: false,
    preset: '',
    container: '.' + file.container,
    handBrakeMode: false,
    FFmpegMode: false,
  };

  var outPath = '';
  var temps = [];
  var removeFiles = function (paths) {
    paths.forEach(function (p) {
      if (p && fs.existsSync(p)) {
        try { fs.unlinkSync(p); } catch (e) { /* ignore */ }
      }
    });
  };
  var run = function (cmd, args) {
    return spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
  };
  var failed = function (r) { return r.error || r.status > 1; };
  var why = function (r) { return r.error ? r.error.message : (r.stderr || r.stdout); };

  try {
    if (file.container !== 'mkv') {
      response.infoLog += 'File is not MKV (mkvtoolnix only), skipping.\r\n';
      return response;
    }

    var unreadable = findUnreadableSubs(file.ffProbeData && file.ffProbeData.streams);
    if (unreadable.length === 0) {
      response.infoLog += 'All subtitle tracks are readable by FFmpeg, skipping.\r\n';
      return response;
    }

    if (!otherArguments || !otherArguments.cacheFilePath) {
      response.infoLog += 'No cacheFilePath provided (not running in a flow?), skipping.\r\n';
      return response;
    }
    outPath = otherArguments.cacheFilePath;
    if (path.resolve(outPath) === path.resolve(file._id)) {
      response.infoLog += 'Output path equals input path, skipping.\r\n';
      return response;
    }
    var workDir = path.dirname(outPath);

    // mkvmerge and mkvextract ship alongside mkvpropedit (mkvtoolnix).
    var propedit = (otherArguments.mkvpropeditPath || 'mkvpropedit');
    var mkvtool = function (name) {
      if (path.dirname(propedit) === '.') return name;
      return path.join(path.dirname(propedit), path.basename(propedit).replace('mkvpropedit', name));
    };
    var mkvmerge = mkvtool('mkvmerge');
    var mkvextract = mkvtool('mkvextract');
    var ffmpeg = otherArguments.ffmpegPath || 'ffmpeg';
    var ffprobe = FFPROBE_CANDIDATES.find(function (c) { return !path.isAbsolute(c) || fs.existsSync(c); });

    var identify = function (p) {
      var r = run(mkvmerge, ['-J', p]);
      if (failed(r)) throw new Error('mkvmerge identify failed on ' + p + ': ' + why(r));
      return JSON.parse(r.stdout).tracks || [];
    };
    var probe = function (args, p) {
      var r = run(ffprobe, ['-v', 'error'].concat(args, ['-of', 'json', '--', p]));
      if (r.error || r.status !== 0) throw new Error('ffprobe failed on ' + p + ': ' + why(r));
      return JSON.parse(r.stdout);
    };
    var countCues = function (p) {
      var s = (probe(['-count_packets', '-show_entries', 'stream=nb_read_packets'], p).streams || [])[0] || {};
      return Number(s.nb_read_packets);
    };

    var mkvTracks = identify(file._id);
    var plan = planTracks(mkvTracks, unreadable);
    if (plan.error) throw new Error(plan.error);

    plan.drop.forEach(function (t) {
      response.infoLog += 'Subtitle track ' + t.id + ' (' + (t.properties || {}).codec_id + ') is unreadable and not convertible, dropping it.\r\n';
    });

    // Extract every WebVTT track in one pass, then convert each to SRT.
    var srtPaths = {};
    var cueCounts = {};
    if (plan.convert.length > 0) {
      var extractArgs = [file._id, 'tracks'];
      plan.convert.forEach(function (t) {
        var vtt = path.join(workDir, 'track' + t.id + '.vtt');
        temps.push(vtt);
        extractArgs.push(t.id + ':' + vtt);
      });
      var ex = run(mkvextract, extractArgs);
      if (failed(ex)) throw new Error('mkvextract failed (exit ' + ex.status + '): ' + why(ex));

      plan.convert.forEach(function (t) {
        var vtt = path.join(workDir, 'track' + t.id + '.vtt');
        var srt = path.join(workDir, 'track' + t.id + '.srt');
        temps.push(srt);
        var conv = run(ffmpeg, ['-hide_banner', '-v', 'error', '-y', '-i', vtt, '-c:s', 'srt', srt]);
        if (conv.error || conv.status !== 0) throw new Error('ffmpeg could not convert track ' + t.id + ' to SRT: ' + why(conv));
        var vttCues = countCues(vtt);
        var srtCues = countCues(srt);
        if (!(vttCues > 0) || vttCues !== srtCues) {
          throw new Error('cue count mismatch on track ' + t.id + ': WebVTT ' + vttCues + ', SRT ' + srtCues);
        }
        srtPaths[t.id] = srt;
        cueCounts[t.id] = srtCues;
        response.infoLog += 'Converted WebVTT track ' + t.id + ' (' + ((t.properties || {}).language || 'und') + ') to SRT, ' + srtCues + ' cues.\r\n';
      });
    }

    var built = buildMerge(file._id, outPath, mkvTracks, plan, srtPaths);
    var merge = run(mkvmerge, built.args);
    if (failed(merge) || !fs.existsSync(outPath)) throw new Error('mkvmerge failed (exit ' + merge.status + '): ' + why(merge));
    if (merge.status === 1) response.infoLog += 'mkvmerge warnings: ' + merge.stdout + '\r\n';

    // --- verification gate ---
    var outTracks = identify(outPath);
    if (outTracks.length !== built.layout.length) {
      throw new Error('output has ' + outTracks.length + ' tracks, expected ' + built.layout.length);
    }
    built.layout.forEach(function (l, i) {
      var o = outTracks[i];
      var want = l.converted ? SRT_CODEC_ID : (l.track.properties || {}).codec_id;
      if (o.type !== l.track.type || (o.properties || {}).codec_id !== want) {
        throw new Error('output track ' + i + ' is ' + o.type + '/' + (o.properties || {}).codec_id + ', expected ' + l.track.type + '/' + want);
      }
    });
    var outProbe = probe(['-select_streams', 's', '-count_packets',
      '-show_entries', 'stream=index,codec_name,nb_read_packets:format=duration'], outPath);
    (outProbe.streams || []).forEach(function (s) {
      if (isUnreadable(s)) throw new Error('output subtitle stream ' + s.index + ' is still unreadable');
      var l = built.layout[s.index];
      if (l && l.converted && Number(s.nb_read_packets) !== cueCounts[l.track.id]) {
        throw new Error('output stream ' + s.index + ' has ' + s.nb_read_packets + ' cues, expected ' + cueCounts[l.track.id]);
      }
    });
    var inDuration = Number(((file.ffProbeData && file.ffProbeData.format) || {}).duration) || 0;
    var outDuration = Number((outProbe.format || {}).duration) || 0;
    if (inDuration > 0 && Math.abs(outDuration - inDuration) > 1.0) {
      throw new Error('duration mismatch: ' + outDuration + 's vs ' + inDuration + 's');
    }

    response.infoLog += 'Verified: ' + outTracks.length + ' tracks, every subtitle track readable, cue counts match.\r\n';
    removeFiles(temps);
    // Hand the new file to the next flow plugin (the runner picks up the new _id).
    response.file = Object.assign({}, file, { _id: outPath, file: outPath });
    return response;
  } catch (err) {
    console.log(err);
    removeFiles(temps.concat([outPath]));
    response.infoLog += 'Error: ' + err.message + '. Library file left untouched.\r\n';
    // Every later step would fail on this file anyway, so fail the job here with the real reason.
    response.error = 'Convert unsupported subtitles: ' + err.message;
    return response;
  }
};

module.exports.details = details;
module.exports.plugin = plugin;
// Pure helpers, exported for tests/convert_unsupported_subs.test.js. Tdarr only uses details and plugin.
module.exports._test = { findUnreadableSubs: findUnreadableSubs, planTracks: planTracks, buildMerge: buildMerge };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/*.test.js`
Expected: all tests PASS (11 tests, 0 failures).

---

### Task 2: Integration test inside the Tdarr node container

**Files:**
- Create: `tests/container/convert_unsupported_subs.itest.js`

This runs the real plugin, with Tdarr's real `methods/lib`, mkvtoolnix and FFmpeg, against the real Good Boy file. It writes only under `/tmp/itest` inside the container and never modifies anything under `/media`.

- [ ] **Step 1: Write the integration test**

Create `tests/container/convert_unsupported_subs.itest.js`:

```js
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
  assert.deepStrictEqual(fs.readdirSync(WORK).filter((f) => /\.(vtt|srt)$/.test(f)), [], 'temp files left behind');
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
```

- [ ] **Step 2: Stage the files into the container**

Run (Bash, from repo root). `MSYS_NO_PATHCONV=1` stops Git Bash rewriting container paths:

```bash
MSYS_NO_PATHCONV=1 docker exec tdarr-node sh -c 'rm -rf /tmp/itest && mkdir -p /tmp/itest/plugins/Local && ln -s /app/Tdarr_Node/assets/app/plugins/methods /tmp/itest/plugins/methods'
MSYS_NO_PATHCONV=1 docker cp Tdarr_Plugin_the1nk_convert_unsupported_subs.js tdarr-node:/tmp/itest/plugins/Local/
MSYS_NO_PATHCONV=1 docker cp Tdarr_Plugin_the1nk_downmix_to_stereo_and_apply_DRC.js tdarr-node:/tmp/itest/plugins/Local/
MSYS_NO_PATHCONV=1 docker cp tests/container/convert_unsupported_subs.itest.js tdarr-node:/tmp/itest/plugins/
```

- [ ] **Step 3: Run the integration test**

```bash
MSYS_NO_PATHCONV=1 docker exec tdarr-node node /tmp/itest/plugins/convert_unsupported_subs.itest.js "/media/Library/Movies/Good Boy (2025)/Good Boy (2025) {imdb-tt35521922} ().mkv"
```

Expected (takes 1-3 minutes, 1.7 GB file over SMB): `PASS 1` … `PASS 4`, then `ALL PASS`, exit code 0. The infoLog printed in step 2 should include `Converted WebVTT track 2 (eng) to SRT, 285 cues.` and `Verified: 3 tracks, ...`.

If PASS 1 fails, the test isn't reproducing the bug, so stop and report. If a later step fails, fix the plugin (and add a unit test for the cause in `tests/convert_unsupported_subs.test.js`), re-run Task 1's tests, re-stage, and re-run.

- [ ] **Step 4: Clean up the container**

```bash
MSYS_NO_PATHCONV=1 docker exec tdarr-node rm -rf /tmp/itest
```

---

### Task 3: Insert the plugin into all five flows

**Files:**
- Modify: `flowMovies.json`, `flowAnimovies.json`, `flowShows.json`, `flowAnishows.json`, `flowOtherVideos.json`
- Modify: `flowMovies.local.json`, `flowAnimovies.local.json`, `flowShows.local.json`, `flowAnishows.local.json`, `flowOtherVideos.local.json` (gitignored; same structure but with real API keys, so **never print their contents**)

The new node goes between the Processed Tag Filter (its "continue" output, `sourceHandle "1"`) and the "Remove Streams By Specified Property" node. Both outputs of the new node ("1" processed / "2" not processed) lead to the Remove Streams node, the same as every other transcode node.

- [ ] **Step 1: Write the one-off edit script**

Create `C:\Users\adam\AppData\Local\Temp\claude\C--git-tdarr-plugins\c82633c8-d761-47f6-9d90-d19d99b4603a\scratchpad\insert_convert_subs.js`:

```js
// One-off: insert the Convert Unsupported Subtitles node into every flow export.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const repo = process.argv[2];
const id = () => crypto.randomBytes(8).toString('base64url').slice(0, 10);
const NEW_SOURCE = 'Local:Tdarr_Plugin_the1nk_convert_unsupported_subs';
const files = ['Movies', 'Animovies', 'Shows', 'Anishows', 'OtherVideos']
  .flatMap((n) => [`flow${n}.json`, `flow${n}.local.json`]);

for (const name of files) {
  const p = path.join(repo, name);
  const raw = fs.readFileSync(p, 'utf8');
  const flow = JSON.parse(raw);
  const bySource = (s) => flow.flowPlugins.filter((n) => n.inputsDB && n.inputsDB.pluginSourceId === s);
  if (bySource(NEW_SOURCE).length) { console.log(name + ': already has the node, skipped'); continue; }
  const filter = bySource('Local:Tdarr_Plugin_the1nk_processed_tag_filter');
  const remove = bySource('Local:Tdarr_Plugin_00td_action_remove_stream_by_specified_property');
  if (filter.length !== 1 || remove.length !== 1) throw new Error(name + ': expected exactly one filter and one remove-streams node');
  const edges = flow.flowEdges.filter((e) => e.source === filter[0].id && e.target === remove[0].id);
  if (edges.length !== 1 || edges[0].sourceHandle !== '1') throw new Error(name + ': expected one filter->remove edge on handle 1');

  // Make room: shift the remove-streams node and everything below it down by 100.
  const y0 = remove[0].position.y;
  flow.flowPlugins.forEach((n) => { if (n.position.y >= y0) n.position.y += 100; });

  const node = {
    name: 'Run Classic Transcode Plugin: Tdarr_Plugin_the1nk_convert_unsupported_subs',
    sourceRepo: 'Community',
    pluginName: 'runClassicTranscodePlugin',
    version: '2.0.0',
    inputsDB: { pluginSourceId: NEW_SOURCE },
    fpEnabled: true,
    id: id(),
    position: { x: remove[0].position.x, y: y0 },
  };
  flow.flowPlugins.splice(flow.flowPlugins.indexOf(remove[0]), 0, node);
  edges[0].target = node.id;
  flow.flowEdges.push(
    { source: node.id, sourceHandle: '1', target: remove[0].id, targetHandle: null, id: id() },
    { source: node.id, sourceHandle: '2', target: remove[0].id, targetHandle: null, id: id() },
  );

  // Keep the file's existing formatting (indent and trailing newline).
  const indent = (raw.match(/^\{\r?\n([ \t]+)/) || [, '  '])[1];
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  let out = JSON.stringify(flow, null, indent).replace(/\n/g, eol);
  if (/\r?\n$/.test(raw)) out += eol;
  fs.writeFileSync(p, out);
  console.log(name + ': inserted ' + node.id);
}
```

- [ ] **Step 2: Run it**

Run (Bash): `node "/c/Users/adam/AppData/Local/Temp/claude/C--git-tdarr-plugins/c82633c8-d761-47f6-9d90-d19d99b4603a/scratchpad/insert_convert_subs.js" "C:/git/tdarr plugins"`
Expected: 10 lines `flowX.json: inserted <id>` / `flowX.local.json: inserted <id>`, no errors.

- [ ] **Step 3: Verify**

Run: `git diff --stat -- 'flow*.json'` (expect 5 files changed, insertions only plus a few position lines). Then run this check, which prints the plugin order of each tracked flow by walking handle "1" edges from the input node:

```bash
node -e '
for (const n of ["Movies","Animovies","Shows","Anishows","OtherVideos"]) for (const f of [`flow${n}.json`,`flow${n}.local.json`]) {
  const fl = require("./" + f); const byId = Object.fromEntries(fl.flowPlugins.map(p => [p.id, p]));
  let cur = fl.flowPlugins.find(p => p.pluginName === "inputFile"); const names = [];
  while (cur && names.length < 30) { names.push((cur.inputsDB.pluginSourceId || cur.pluginName).replace(/^(Local|Community):Tdarr_Plugin_/, ""));
    const e = fl.flowEdges.find(e => e.source === cur.id && e.sourceHandle === "1"); cur = e && byId[e.target]; }
  console.log(f + ": " + names.slice(0, 5).join(" > "));
}'
```

Expected for all 10 files: `flowX.json: inputFile > the1nk_filename_suffix_filter > the1nk_processed_tag_filter > the1nk_convert_unsupported_subs > 00td_action_remove_stream_by_specified_property`.

Also confirm the tracked files still hold only the placeholder keys: `git diff -- 'flow*.json' | grep -i apikey` should print nothing.

---

### Task 4: README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update the flow diagram**

In the mermaid block, replace

```
    f2 -- continue --> t2[Remove Streams By Property<br/>codec_name = bmp]
```

with

```
    f2 -- continue --> t1[Convert Unsupported Subtitles<br/>WebVTT to SRT]
    t1 --> t2[Remove Streams By Property<br/>codec_name = bmp]
```

- [ ] **Step 2: Add an ordering rule**

In "### Ordering rules", add this as the first bullet after "Inside a flow, a classic plugin sees the current _working_ file.":

```markdown
- **Convert Unsupported Subtitles goes _first_, before any FFmpeg step.** Every later step copies all streams (`-map 0 -c copy`), and FFmpeg can't copy a track it can't read, so a single WebVTT track stored as `S_TEXT/WEBVTT` fails the whole flow with `Subtitle codec 0 is not supported`.
```

- [ ] **Step 3: Add plugin docs**

Read the "## Plugins" section and add an entry for `Tdarr_Plugin_the1nk_convert_unsupported_subs` in the same format as the `Tdarr_Plugin_the1nk_repair_framerate` entry, under the same heading that one uses. Content to cover, in the README's voice and level of detail:
- What it fixes: MKV subtitle tracks that FFmpeg can't read (ffprobe shows no codec). The known case is WebVTT muxed by recent mkvmerge with codec ID `S_TEXT/WEBVTT`, which FFmpeg 7.1 (and current FFmpeg) can't demux.
- What it does: `mkvextract` the track to `.vtt`, FFmpeg converts it to `.srt`, `mkvmerge` writes a new MKV to the flow cache with the SRT in the original track position, keeping language, name, default/forced/hearing-impaired flags. Other unreadable subtitle tracks are dropped (logged).
- Verification: track layout and codecs, every subtitle readable, cue counts equal (WebVTT = SRT = muxed), duration within 1 s.
- Failure: the job fails with the reason. The library file is never touched.
- Flow-only (needs `cacheFilePath`). No inputs.

- [ ] **Step 4: Add a Tests section**

At the end of README.md add:

````markdown
## Tests

Unit tests (no Tdarr or media tools needed):

```bash
node --test tests/*.test.js
```

Integration test for `Tdarr_Plugin_the1nk_convert_unsupported_subs`, run inside the `tdarr-node` container against a real file with an `S_TEXT/WEBVTT` subtitle track. It only writes under `/tmp/itest` in the container:

```bash
MSYS_NO_PATHCONV=1 docker exec tdarr-node sh -c 'rm -rf /tmp/itest && mkdir -p /tmp/itest/plugins/Local && ln -s /app/Tdarr_Node/assets/app/plugins/methods /tmp/itest/plugins/methods'
MSYS_NO_PATHCONV=1 docker cp Tdarr_Plugin_the1nk_convert_unsupported_subs.js tdarr-node:/tmp/itest/plugins/Local/
MSYS_NO_PATHCONV=1 docker cp Tdarr_Plugin_the1nk_downmix_to_stereo_and_apply_DRC.js tdarr-node:/tmp/itest/plugins/Local/
MSYS_NO_PATHCONV=1 docker cp tests/container/convert_unsupported_subs.itest.js tdarr-node:/tmp/itest/plugins/
MSYS_NO_PATHCONV=1 docker exec tdarr-node node /tmp/itest/plugins/convert_unsupported_subs.itest.js "/media/Library/Movies/Good Boy (2025)/Good Boy (2025) {imdb-tt35521922} ().mkv"
MSYS_NO_PATHCONV=1 docker exec tdarr-node rm -rf /tmp/itest
```
````

- [ ] **Step 5: Check**

Run: `git diff -- README.md` and confirm the mermaid block still parses (each line `a --> b` or `a -- label --> b`, node IDs unique: `t1` must not already exist in the diagram).

---

## Deployment (controller, after all tasks pass review)

Not for subagents:
1. `./push.ps1` copies the plugin `.js` files to the Tdarr plugins share.
2. Import the updated `flow*.local.json` into Tdarr (or update the flows through the Tdarr API).
3. Requeue Joker, [REC]³, Criminal Minds S18E06, The Paper S01E02 and Good Boy, then confirm the jobs succeed.
