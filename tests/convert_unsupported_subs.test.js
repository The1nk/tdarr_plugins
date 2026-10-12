const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const path = require('path');

// The plugin does require('../methods/lib') (Tdarr's runtime). Stub it for local runs.
// Tests that drive the plugin end to end also swap in fake 'fs' / 'child_process' via `stubs`.
let stubs = null;
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '../methods/lib') {
    return () => ({ loadDefaultValues: (inputs) => inputs || {} });
  }
  if (stubs && Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
  return origLoad.call(this, request, parent, isMain);
};

const pluginModule = require(path.join(__dirname, '..', 'Tdarr_Plugin_the1nk_convert_unsupported_subs.js'));
const {
  findUnreadableSubs, planTracks, buildMerge, toolFailed, cueStats, lastPacketEnd, verifyOutput, pickFfprobe,
} = pluginModule._test;

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

test('buildMerge: carries over every defined flag mkvmerge -J exposes, and only those', () => {
  const tracks = [
    { id: 0, type: 'video', properties: { codec_id: 'V_MPEG4/ISO/AVC' } },
    {
      id: 1,
      type: 'subtitles',
      properties: {
        codec_id: 'S_TEXT/WEBVTT', language: 'eng', default_track: false, forced_track: false,
        enabled_track: false, flag_hearing_impaired: false, flag_visual_impaired: true,
        flag_text_descriptions: true, flag_original: false, flag_commentary: true,
      },
    },
    { id: 2, type: 'subtitles', properties: { codec_id: 'S_TEXT/WEBVTT', language: 'fre', enabled_track: true } },
  ];
  const plan = planTracks(tracks, [1, 2]);
  const built = buildMerge('/in/c.mkv', '/out/c.mkv', tracks, plan, { 1: '/w/track1.srt', 2: '/w/track2.srt' });
  assert.deepStrictEqual(built.args, [
    '-o', '/out/c.mkv',
    '--subtitle-tracks', '!1,2',
    '/in/c.mkv',
    '--language', '0:eng',
    '--default-track-flag', '0:no',
    '--forced-display-flag', '0:no',
    '--track-enabled-flag', '0:no',
    '--hearing-impaired-flag', '0:no',
    '--visual-impaired-flag', '0:yes',
    '--text-descriptions-flag', '0:yes',
    '--original-flag', '0:no',
    '--commentary-flag', '0:yes',
    '--sub-charset', '0:UTF-8',
    '/w/track1.srt',
    '--language', '0:fre',
    '--default-track-flag', '0:no',
    '--forced-display-flag', '0:no',
    '--track-enabled-flag', '0:yes',
    '--sub-charset', '0:UTF-8',
    '/w/track2.srt',
    '--track-order', '0:0,1:0,2:0',
  ]);
});

test('buildMerge: drop-only plan has no SRT inputs', () => {
  const tracks = [
    { id: 0, type: 'video', properties: { codec_id: 'V_MPEG4/ISO/AVC' } },
    { id: 1, type: 'audio', properties: { codec_id: 'A_AAC' } },
    { id: 2, type: 'subtitles', properties: { codec_id: 'S_HDMV/TEXTST' } },
  ];
  const plan = planTracks(tracks, [2]);
  const built = buildMerge('/in/d.mkv', '/out/d.mkv', tracks, plan, {});
  assert.deepStrictEqual(built.args, ['-o', '/out/d.mkv', '--subtitle-tracks', '!2', '/in/d.mkv', '--track-order', '0:0,0:1']);
  assert.deepStrictEqual(built.layout.map((l) => [l.track.id, l.converted]), [[0, false], [1, false]]);
});

test('buildMerge: converted track with no language falls back to und', () => {
  const tracks = [
    { id: 0, type: 'video', properties: { codec_id: 'V_MPEG4/ISO/AVC' } },
    { id: 1, type: 'subtitles', properties: { codec_id: 'S_TEXT/WEBVTT' } },
  ];
  const built = buildMerge('/in/e.mkv', '/out/e.mkv', tracks, planTracks(tracks, [1]), { 1: '/w/track1.srt' });
  assert.deepStrictEqual(built.args.slice(5, 7), ['--language', '0:und']);
});

test('toolFailed: launch error, signal kill (status null) and exit >= 2 fail; 0 and 1 pass', () => {
  assert.ok(toolFailed({ error: new Error('ENOENT'), status: null }));
  assert.ok(toolFailed({ status: null, signal: 'SIGKILL' }));
  assert.ok(toolFailed({ status: 2 }));
  assert.ok(!toolFailed({ status: 0 }));
  assert.ok(!toolFailed({ status: 1 }));
});

// The reviewer's case, as mkvextract writes it and as tdarr-ffmpeg 7.1 converts it.
const vtt4 = '\uFEFFWEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello\n\n00:00:02.500 --> 00:00:03.000\n\n'
  + '00:00:03.500 --> 00:00:04.000\n<c.yellow></c>\n\n00:00:05.000 --> 00:00:06.000\nBye\n';
const srt4 = '1\n00:00:01,000 --> 00:00:02,000\nHello\n\n2\n00:00:03,500 --> 00:00:04,000\n\n\n'
  + '3\n00:00:05,000 --> 00:00:06,000\nBye\n\n';

test('cueStats: reviewer 4-cue example (empty + tag-only cue) gives matching text counts', () => {
  const v = cueStats(vtt4, 'vtt');
  const s = cueStats(srt4, 'srt');
  assert.strictEqual(v.total, 4);
  assert.strictEqual(v.content, 2);
  assert.strictEqual(s.total, 3);
  assert.strictEqual(s.content, 2);
  // mkvmerge stores only SRT entries whose text isn't blank: Hello and Bye.
  assert.strictEqual(s.muxed, 2);
  assert.strictEqual(s.muxedEnd, 6);
});

test('cueStats: whitespace, supported tags, entities, multi-line and CRLF payloads', () => {
  const vtt = 'WEBVTT\nKind: captions\n\nNOTE header note\n\nSTYLE\n::cue { color: red }\n\n'
    + 'id-1\n00:01.000 --> 00:02.000 align:start\n   \n\n'
    + '00:00:03.000 --> 00:00:04.000\n<i> </i>\n\n'
    + '00:00:05.000 --> 00:00:06.000\n<b>Bye</b>\n\n'
    + '00:00:07.000 --> 00:00:08.000\nline one\nline two\n\n'
    + '00:00:09.000 --> 00:00:10.000\n&nbsp;\n\n'
    + '00:00:11.000 --> 00:00:12.000\n&lt;3&gt;\n\n'
    + '00:00:13.000 --> 00:00:14.000\n<ruby>A<rt>a</rt></ruby>\n';
  const v = cueStats(vtt, 'vtt');
  assert.strictEqual(v.total, 7);
  assert.strictEqual(v.content, 4); // Bye, line one/two, <3, Aa
  // What tdarr-ffmpeg wrote for the same cues (CRLF inside multi-line payloads, \h for &nbsp;).
  const srt = '1\r\n00:00:01,000 --> 00:00:02,000\r\n\r\n\r\n2\n00:00:03,000 --> 00:00:04,000\n<i> </i>\n\n'
    + '3\n00:00:05,000 --> 00:00:06,000\n<b>Bye</b>\n\n4\n00:00:07,000 --> 00:00:08,000\nline one\r\nline two\n\n'
    + '5\n00:00:09,000 --> 00:00:10,000\n\\h\n\n6\n00:00:11,000 --> 00:00:12,000\n<3>\n\n'
    + '7\n00:00:13,000 --> 00:00:14,000\nAa\n\n';
  const s = cueStats(srt, 'srt');
  assert.strictEqual(s.total, 7);
  assert.strictEqual(s.content, 4);
  assert.strictEqual(s.muxed, 6); // all but the empty entry 1; mkvmerge keeps "<i> </i>" and "\h"
  assert.strictEqual(s.muxedEnd, 14);
});

test('cueStats: mkvmerge only treats ASCII whitespace as blank', () => {
  const srt = '1\n00:00:01,000 --> 00:00:02,000\n \t \n\n2\n00:00:03,000 --> 00:00:04,000\n\u00a0\n\n'
    + '3\n00:00:05,000 --> 00:00:06,000\nX\n\n';
  const s = cueStats(srt, 'srt');
  assert.strictEqual(s.content, 1);
  assert.strictEqual(s.muxed, 2);
});

test('cueStats: empty, header-only and missing text have no cues', () => {
  assert.deepStrictEqual(cueStats('', 'vtt'), { total: 0, content: 0, muxed: 0, muxedEnd: 0 });
  assert.strictEqual(cueStats('WEBVTT\n\n', 'vtt').total, 0);
  assert.strictEqual(cueStats(undefined, 'srt').total, 0);
  const onlyEmpty = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n\n00:00:03.000 --> 00:00:04.000\n<c.yellow></c>\n';
  assert.strictEqual(cueStats(onlyEmpty, 'vtt').total, 2);
  assert.strictEqual(cueStats(onlyEmpty, 'vtt').content, 0);
});

test('cueStats: a lost or truncated cue changes the text count', () => {
  const lost = '1\n00:00:01,000 --> 00:00:02,000\nHello\n\n';
  assert.notStrictEqual(cueStats(lost, 'srt').content, cueStats(vtt4, 'vtt').content);
  const truncated = srt4.slice(0, srt4.lastIndexOf('Bye'));
  assert.notStrictEqual(cueStats(truncated, 'srt').content, cueStats(vtt4, 'vtt').content);
});

test('lastPacketEnd: latest pts+duration over streams not ignored, relative to start time', () => {
  const packets = [
    { stream_index: 0, pts_time: '99.000000', duration_time: '0.040000' },
    { stream_index: 1, pts_time: '99.500000', duration_time: '0.021333' },
    { stream_index: 2, pts_time: '119.000000', duration_time: '1.000000' },
    { stream_index: 1, pts_time: 'N/A', duration_time: '0.021333' },
    { stream_index: 0, pts_time: '98.000000' },
  ];
  assert.strictEqual(lastPacketEnd(packets, [2], 0).toFixed(6), '99.521333');
  assert.strictEqual(lastPacketEnd(packets, [], 0.5), 119.5);
  assert.strictEqual(lastPacketEnd(undefined, [], 0), 0);
});

const layoutGB = [
  { track: goodBoyTracks[0], converted: false },
  { track: goodBoyTracks[1], converted: false },
  { track: goodBoyTracks[2], converted: true },
];
const outTracksGB = [
  { type: 'video', properties: { codec_id: 'V_MPEG4/ISO/AVC' } },
  { type: 'audio', properties: { codec_id: 'A_AAC' } },
  { type: 'subtitles', properties: { codec_id: 'S_TEXT/UTF8' } },
];
const okOutput = (over) => Object.assign({
  layout: layoutGB,
  outTracks: outTracksGB,
  outSubStreams: [{ index: 2, codec_name: 'subrip', nb_read_packets: '285' }],
  expectedPackets: { 2: 285 },
  inDuration: 100,
  outDuration: 100.2,
  lossy: false,
  keptEnd: 0,
}, over);

test('verifyOutput: passes a correct conversion', () => {
  assert.strictEqual(verifyOutput(okOutput({})), null);
});

test('verifyOutput: wrong track count', () => {
  assert.match(verifyOutput(okOutput({ outTracks: outTracksGB.slice(0, 2) })), /2 tracks, expected 3/);
});

test('verifyOutput: wrong type or codec at a position', () => {
  const swapped = [outTracksGB[1], outTracksGB[0], outTracksGB[2]];
  assert.match(verifyOutput(okOutput({ outTracks: swapped })), /output track 0 is audio/);
  const stillVtt = outTracksGB.slice(0, 2).concat([{ type: 'subtitles', properties: { codec_id: 'S_TEXT/WEBVTT' } }]);
  assert.match(verifyOutput(okOutput({ outTracks: stillVtt })), /track 2 .*expected subtitles\/S_TEXT\/UTF8/);
});

test('verifyOutput: ffprobe must see one subtitle stream per layout subtitle', () => {
  assert.match(verifyOutput(okOutput({ outSubStreams: [] })), /0 subtitle streams in the output, expected 1/);
});

test('verifyOutput: unreadable output subtitle stream', () => {
  assert.match(verifyOutput(okOutput({ outSubStreams: [{ index: 2, nb_read_packets: '285' }] })), /stream 2 is still unreadable/);
});

test('verifyOutput: subtitle stream that is not a subtitle in the layout', () => {
  assert.match(verifyOutput(okOutput({ outSubStreams: [{ index: 1, codec_name: 'subrip', nb_read_packets: '285' }] })), /stream 1 .*not a subtitle/);
});

test('verifyOutput: converted cue count mismatch (including N/A packets)', () => {
  assert.match(verifyOutput(okOutput({ outSubStreams: [{ index: 2, codec_name: 'subrip', nb_read_packets: '284' }] })), /284 cues, expected 285/);
  assert.match(verifyOutput(okOutput({ outSubStreams: [{ index: 2, codec_name: 'subrip', nb_read_packets: 'N/A' }] })), /0 cues, expected 285/);
});

test('verifyOutput: strict +-1s duration when nothing was lost', () => {
  assert.match(verifyOutput(okOutput({ outDuration: 98.5 })), /duration mismatch/);
  assert.match(verifyOutput(okOutput({ outDuration: 101.5 })), /duration mismatch/);
  assert.strictEqual(verifyOutput(okOutput({ inDuration: 0, outDuration: 5 })), null);
});

test('verifyOutput: a dropped track that ran longest may shorten the output, truncation still fails', () => {
  // Input 120s only because a dropped subtitle track ran to 120s; video/audio end at 100s.
  assert.strictEqual(verifyOutput(okOutput({ inDuration: 120, outDuration: 100.04, lossy: true, keptEnd: 100.02 })), null);
  assert.match(verifyOutput(okOutput({ inDuration: 120, outDuration: 60, lossy: true, keptEnd: 100.02 })), /truncated/);
  assert.match(verifyOutput(okOutput({ inDuration: 120, outDuration: 122, lossy: true, keptEnd: 100.02 })), /longer/);
  assert.match(verifyOutput(okOutput({ inDuration: 120, outDuration: 100, lossy: true, keptEnd: 0 })), /could not measure/);
});

test('pickFfprobe: bundled, then next to an absolute ffmpegPath, then PATH', () => {
  const bundled = '/app/Tdarr_Node/assets/app/ffmpeg/linux_x64/ffprobe';
  const nextTo = path.join('/opt/ff', 'ffprobe');
  assert.strictEqual(pickFfprobe('/opt/ff/ffmpeg', () => true), bundled);
  assert.strictEqual(pickFfprobe('/opt/ff/ffmpeg', (p) => p === nextTo), nextTo);
  assert.strictEqual(pickFfprobe('/opt/ff/ffmpeg', () => false), 'ffprobe');
  assert.strictEqual(pickFfprobe('tdarr-ffmpeg', (p) => p === nextTo), 'ffprobe');
  assert.strictEqual(pickFfprobe(undefined, () => false), 'ffprobe');
  const win = path.join('C:\\ff', 'ffprobe.exe');
  assert.strictEqual(pickFfprobe('C:\\ff\\ffmpeg.exe', (p) => p === win), path.isAbsolute('C:\\ff\\ffmpeg.exe') ? win : 'ffprobe');
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

test('plugin: skips when the output path equals the input path', () => {
  const res = call({ _id: '/m/a.mkv', container: 'mkv', ffProbeData: { streams: goodBoyStreams } }, { cacheFilePath: '/m/../m/a.mkv' });
  assert.strictEqual(res.error, undefined);
  assert.strictEqual(res.file._id, '/m/a.mkv');
  assert.match(res.infoLog, /Output path equals input path/);
});

test('plugin: mkvmerge killed by a signal fails the job, keeps the input and cleans up', () => {
  const calls = [];
  const unlinked = [];
  const files = {};
  files[path.join('/w', 'track2.vtt')] = vtt4;
  files[path.join('/w', 'track2.srt')] = srt4;
  const fakeFs = {
    existsSync: () => true,
    unlinkSync: (p) => { unlinked.push(p); },
    readFileSync: (p) => {
      if (!(p in files)) throw new Error('unexpected read ' + p);
      return files[p];
    },
  };
  const fakeCp = {
    spawnSync: (cmd, args) => {
      calls.push([cmd].concat(args));
      if (cmd === 'mkvmerge' && args[0] === '-J') return { status: 0, stdout: JSON.stringify({ tracks: goodBoyTracks }) };
      if (cmd === 'mkvmerge') return { status: null, signal: 'SIGKILL', stdout: '', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    },
  };
  stubs = { fs: fakeFs, child_process: fakeCp };
  let res;
  try {
    res = call(
      { _id: '/m/a.mkv', container: 'mkv', ffProbeData: { streams: goodBoyStreams, format: { duration: '100' } } },
      { cacheFilePath: '/w/out.mkv', ffmpegPath: 'tdarr-ffmpeg', mkvpropeditPath: 'mkvpropedit' },
    );
  } finally {
    stubs = null;
  }
  assert.match(res.error, /mkvmerge failed/);
  assert.strictEqual(res.file._id, '/m/a.mkv');
  assert.ok(calls.some((c) => c[0] === 'mkvextract'), 'extracted');
  assert.ok(calls.some((c) => c[0] === 'tdarr-ffmpeg'), 'converted');
  assert.deepStrictEqual(unlinked.slice().sort(), [path.join('/w', 'track2.srt'), path.join('/w', 'track2.vtt'), '/w/out.mkv'].sort());
});

test('details: id matches the filename', () => {
  assert.strictEqual(pluginModule.details().id, 'Tdarr_Plugin_the1nk_convert_unsupported_subs');
});
