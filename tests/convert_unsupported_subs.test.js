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
  findUnreadableSubs, planTracks, buildMerge, toolFailed, cueStats, verifyOutput, pickFfprobe,
  vttProblem, packetCount, sumPacketCsv, comparesBytes,
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
});

test('cueStats: mkvmerge only treats ASCII whitespace as blank', () => {
  const srt = '1\n00:00:01,000 --> 00:00:02,000\n \t \n\n2\n00:00:03,000 --> 00:00:04,000\n\u00a0\n\n'
    + '3\n00:00:05,000 --> 00:00:06,000\nX\n\n';
  const s = cueStats(srt, 'srt');
  assert.strictEqual(s.content, 1);
  assert.strictEqual(s.muxed, 2);
});

test('cueStats: empty, header-only and missing text have no cues', () => {
  assert.deepStrictEqual(cueStats('', 'vtt'), { total: 0, content: 0, muxed: 0 });
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

test('vttProblem: extracted file must exist and start with the WEBVTT signature', () => {
  assert.match(vttProblem(null), /missing/);
  assert.match(vttProblem('1\n00:00:01,000 --> 00:00:02,000\nHello\n'), /not a WebVTT file/);
  assert.match(vttProblem(''), /not a WebVTT file/);
  assert.match(vttProblem('WEBVTTX\n'), /not a WebVTT file/);
  // mkvextract writes BOM + WEBVTT for a track with no cues; that one is valid (and has no text cues).
  assert.strictEqual(vttProblem('\uFEFFWEBVTT\n'), null);
  assert.strictEqual(cueStats('\uFEFFWEBVTT\n', 'vtt').content, 0);
  assert.strictEqual(vttProblem('WEBVTT'), null);
  assert.strictEqual(vttProblem('WEBVTT - title\r\n\r\n'), null);
  assert.strictEqual(vttProblem(vtt4), null);
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
const outStreamsGB = [
  { index: 0, codec_type: 'video', codec_name: 'h264', nb_read_packets: '108595' },
  { index: 1, codec_type: 'audio', codec_name: 'aac', nb_read_packets: '212102' },
  { index: 2, codec_type: 'subtitle', codec_name: 'subrip', nb_read_packets: '285' },
];
// Source packet counts by source stream index (stream 2 is the unreadable WebVTT track).
const inPacketsGB = { 0: '108595', 1: '212102', 2: '285' };
const okOutput = (over) => Object.assign({
  layout: layoutGB,
  outTracks: outTracksGB,
  outStreams: outStreamsGB,
  inPackets: inPacketsGB,
  expectedPackets: { 2: 285 },
  inDuration: 100,
  outDuration: 100.2,
  lossy: false,
}, over);
const withStream = (i, change) => outStreamsGB.map((s) => (s.index === i ? Object.assign({}, s, change) : s));

test('verifyOutput: passes a correct conversion (equal packet counts)', () => {
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
  assert.match(verifyOutput(okOutput({ outStreams: outStreamsGB.slice(0, 2) })), /0 subtitle streams in the output, expected 1/);
});

test('verifyOutput: unreadable output subtitle stream', () => {
  assert.match(verifyOutput(okOutput({ outStreams: withStream(2, { codec_name: undefined }) })), /stream 2 is still unreadable/);
});

test('verifyOutput: subtitle stream that is not a subtitle in the layout', () => {
  const odd = [outStreamsGB[0],
    { index: 1, codec_type: 'subtitle', codec_name: 'subrip', nb_read_packets: '212102' },
    { index: 2, codec_type: 'audio', codec_name: 'aac', nb_read_packets: '285' }];
  assert.match(verifyOutput(okOutput({ outStreams: odd })), /stream 1 .*not a subtitle/);
});

test('verifyOutput: converted cue count mismatch; an unresolved N/A count fails', () => {
  assert.match(verifyOutput(okOutput({ outStreams: withStream(2, { nb_read_packets: '284' }) })), /284 cues, expected 285/);
  assert.match(verifyOutput(okOutput({ outStreams: withStream(2, { nb_read_packets: 'N/A' }) })), /output stream 2 has no packet count/);
});

test('verifyOutput: a kept video or audio stream short by one packet fails', () => {
  assert.strictEqual(
    verifyOutput(okOutput({ outStreams: withStream(0, { nb_read_packets: '108594' }) })),
    'output stream 0 (video) has 108594 packets, source has 108595',
  );
  assert.strictEqual(
    verifyOutput(okOutput({ outStreams: withStream(1, { nb_read_packets: '212101' }) })),
    'output stream 1 (audio) has 212101 packets, source has 212102',
  );
  // An extra packet is just as wrong.
  assert.match(verifyOutput(okOutput({ outStreams: withStream(0, { nb_read_packets: '108596' }) })), /108596 packets, source has 108595/);
});

test('verifyOutput: sub-1s truncation is caught by packet counts even when the duration is in tolerance', () => {
  const short = withStream(0, { nb_read_packets: '108570' });
  assert.match(verifyOutput(okOutput({ outStreams: short, outDuration: 99.2 })), /output stream 0 \(video\) has 108570 packets/);
});

// Source: video, audio, dropped HDMV (2), kept SRT (3), converted WebVTT (4). Output positions 0..3.
const mixedTracks = [
  { id: 0, type: 'video', properties: { codec_id: 'V_MPEG4/ISO/AVC' } },
  { id: 1, type: 'audio', properties: { codec_id: 'A_AAC' } },
  { id: 2, type: 'subtitles', properties: { codec_id: 'S_HDMV/TEXTST' } },
  { id: 3, type: 'subtitles', properties: { codec_id: 'S_TEXT/UTF8' } },
  { id: 4, type: 'subtitles', properties: { codec_id: 'S_TEXT/WEBVTT' } },
];
const mixed = (outSubPackets) => {
  const built = buildMerge('/in/m.mkv', '/out/m.mkv', mixedTracks, planTracks(mixedTracks, [2, 4]), { 4: '/w/track4.srt' });
  return {
    layout: built.layout,
    outTracks: [mixedTracks[0], mixedTracks[1], mixedTracks[3], { type: 'subtitles', properties: { codec_id: 'S_TEXT/UTF8' } }],
    outStreams: [
      { index: 0, codec_type: 'video', codec_name: 'h264', nb_read_packets: '250' },
      { index: 1, codec_type: 'audio', codec_name: 'aac', nb_read_packets: '432' },
      { index: 2, codec_type: 'subtitle', codec_name: 'subrip', nb_read_packets: outSubPackets },
      { index: 3, codec_type: 'subtitle', codec_name: 'subrip', nb_read_packets: '4' },
      { index: 4, codec_type: 'attachment', nb_read_packets: '0' },
    ],
    inPackets: { 0: '250', 1: '432', 2: '0', 3: '17', 4: '5' },
    expectedPackets: { 4: 4 },
    inDuration: 120,
    outDuration: 10.03,
    lossy: true,
  };
};

test('verifyOutput: kept readable subtitle is compared with its own source stream via the layout', () => {
  assert.strictEqual(verifyOutput(mixed('17')), null);
  assert.strictEqual(verifyOutput(mixed('16')), 'output stream 2 (subtitle) has 16 packets, source has 17');
});

test('verifyOutput: a kept stream ffprobe did not report, or a source count that is missing, fails', () => {
  const v = okOutput({ outStreams: [outStreamsGB[1], outStreamsGB[2]] });
  assert.match(verifyOutput(v), /output stream 0 \(video\) has no packet count/);
  assert.match(verifyOutput(okOutput({ inPackets: { 1: '212102', 2: '285' } })), /source stream 0 has no packet count/);
  assert.match(verifyOutput(okOutput({ inPackets: { 0: 'garbage', 1: '212102', 2: '285' } })), /source stream 0 has no packet count/);
  // N/A is never taken as a number (the plugin resolves it by listing the stream's packets first).
  assert.match(verifyOutput(okOutput({ inPackets: { 0: 'N/A', 1: '212102', 2: '285' } })), /source stream 0 has no packet count/);
  assert.match(verifyOutput(okOutput({
    inPackets: { 0: '108595', 1: 'N/A', 2: '285' }, outStreams: withStream(1, { nb_read_packets: 'N/A' }),
  })), /output stream 1 \(audio\) has no packet count/);
  // A resolved count of 0 on both sides (an empty kept track) passes.
  assert.strictEqual(verifyOutput(okOutput({
    inPackets: { 0: '108595', 1: 0, 2: '285' }, outStreams: withStream(1, { nb_read_packets: 0 }),
  })), null);
});

test('packetCount: digits or numbers; N/A, missing and garbage are NaN', () => {
  assert.strictEqual(packetCount('42'), 42);
  assert.strictEqual(packetCount(0), 0);
  assert.ok(Number.isNaN(packetCount('N/A')));
  assert.ok(Number.isNaN(packetCount(undefined)));
  assert.ok(Number.isNaN(packetCount('4x')));
});

test('sumPacketCsv: rows of "-show_entries packet=size -of csv=p=0"', () => {
  assert.deepStrictEqual(sumPacketCsv('7680\n7680\r\n3840\n'), { packets: 3, bytes: 19200 });
  assert.deepStrictEqual(sumPacketCsv(''), { packets: 0, bytes: 0 });
  assert.deepStrictEqual(sumPacketCsv('12\nN/A\n'), { packets: 2, bytes: NaN });
});

test('comparesBytes: PCM is compared by payload bytes, everything else by packets', () => {
  ['pcm_s16le', 'pcm_s24le', 'pcm_s32le', 'pcm_f32le', 'pcm_s16be', 'pcm_u8'].forEach((c) => assert.ok(comparesBytes(c), c));
  ['flac', 'truehd', 'dts', 'mp3', 'opus', 'vorbis', 'ac3', 'eac3', 'aac', 'alac', 'h264', 'subrip', undefined].forEach((c) => assert.ok(!comparesBytes(c), c));
});

// PCM from an FFmpeg-muxed source: mkvmerge re-packetizes (2813 -> 1500 packets), bytes are equal.
const pcmOutput = (outBytes, over) => okOutput(Object.assign({
  outStreams: withStream(1, { codec_name: 'pcm_s16le', nb_read_packets: '1500' }),
  inPackets: { 0: '108595', 1: '2813', 2: '285' },
  inBytes: { 1: 11520000 },
  outBytes: { 1: outBytes },
}, over));

test('verifyOutput: PCM passes on equal bytes despite different packet counts', () => {
  assert.strictEqual(verifyOutput(pcmOutput(11520000)), null);
});

test('verifyOutput: PCM short by one byte, or with bytes not measured, fails', () => {
  assert.strictEqual(verifyOutput(pcmOutput(11519999)), 'output stream 1 (audio, pcm_s16le) has 11519999 bytes, source has 11520000');
  assert.match(verifyOutput(pcmOutput(undefined)), /output stream 1 \(audio, pcm_s16le\) has no byte count/);
  assert.match(verifyOutput(pcmOutput(11520000, { inBytes: {} })), /source stream 1 has no byte count/);
});

test('verifyOutput: strict +-1s duration when nothing was lost; input duration is required', () => {
  assert.match(verifyOutput(okOutput({ outDuration: 98.5 })), /duration mismatch/);
  assert.match(verifyOutput(okOutput({ outDuration: 101.5 })), /longer than the input/);
  assert.match(verifyOutput(okOutput({ inDuration: 0, outDuration: 5 })), /input duration/);
  assert.match(verifyOutput(okOutput({ inDuration: NaN, outDuration: 5 })), /input duration/);
});

test('verifyOutput: a dropped track that ran longest may shorten the output, but never lengthen it', () => {
  // Input 120s only because a dropped subtitle track ran to 120s; video/audio end at 100s.
  assert.strictEqual(verifyOutput(okOutput({ inDuration: 120, outDuration: 100.04, lossy: true })), null);
  assert.match(verifyOutput(okOutput({ inDuration: 120, outDuration: 122, lossy: true })), /longer than the input/);
  // The drop-only mixed layout: 120s input, 10.03s output, every kept packet present.
  assert.strictEqual(verifyOutput(mixed('17')), null);
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

const runStubbed = (vttText) => {
  const calls = [];
  const vtt = path.join('/w', 'track2.vtt');
  stubs = {
    fs: {
      existsSync: (p) => (p === vtt ? vttText !== null : true),
      unlinkSync: () => {},
      readFileSync: (p) => {
        if (p !== vtt || vttText === null) throw new Error('unexpected read ' + p);
        return vttText;
      },
    },
    child_process: {
      spawnSync: (cmd, args) => {
        calls.push(cmd);
        if (cmd === 'mkvmerge' && args[0] === '-J') return { status: 0, stdout: JSON.stringify({ tracks: goodBoyTracks }) };
        if (cmd === 'mkvmerge') return { status: 2, stdout: 'stop here' };
        return { status: 0, stdout: '', stderr: '' };
      },
    },
  };
  try {
    const res = call(
      { _id: '/m/a.mkv', container: 'mkv', ffProbeData: { streams: goodBoyStreams, format: { duration: '100' } } },
      { cacheFilePath: '/w/out.mkv', ffmpegPath: 'tdarr-ffmpeg', mkvpropeditPath: 'mkvpropedit' },
    );
    return { res, calls };
  } finally {
    stubs = null;
  }
};

test('plugin: a WebVTT file mkvextract did not write fails the job instead of dropping the track', () => {
  const { res, calls } = runStubbed(null);
  assert.match(res.error, /extracted track 2 is missing/);
  assert.strictEqual(res.file._id, '/m/a.mkv');
  assert.ok(!calls.includes('tdarr-ffmpeg'));
});

test('plugin: an extracted file without the WEBVTT signature fails the job', () => {
  const { res } = runStubbed('garbage\n00:00:01.000 --> 00:00:02.000\nHello\n');
  assert.match(res.error, /extracted track 2 is not a WebVTT file/);
});

test('plugin: a valid WebVTT file with no text cues is dropped (mkvmerge runs without it)', () => {
  const { res } = runStubbed('\uFEFFWEBVTT\n');
  assert.match(res.infoLog, /WebVTT track 2 has no cues with text \(0 cues\), dropping it/);
  assert.match(res.error, /mkvmerge failed/); // the stub stops the run at the mux
});

// A full stubbed run: extract, convert, mux, then the verification probes.
// opts.inFormat replaces Tdarr's format probe data; opts.durationProbe is what the stubbed
// ffprobe prints for "-show_entries format=duration" (stdout text). opts.inAudio / opts.outAudio
// override the audio stream's count entries; opts.listings maps "<file>#<stream>" to the stubbed
// "-show_entries packet=size" output.
const runFull = (outVideoPackets, opts) => {
  const o = opts || {};
  const calls = [];
  const unlinked = [];
  const files = {};
  files[path.join('/w', 'track2.vtt')] = vtt4;
  files[path.join('/w', 'track2.srt')] = srt4;
  const inCounts = { streams: [{ index: 0, nb_read_packets: '2500' }, Object.assign({ index: 1, nb_read_packets: '4300' }, o.inAudio), { index: 2, nb_read_packets: '4' }] };
  const outProbe = {
    streams: [
      { index: 0, codec_type: 'video', codec_name: 'h264', nb_read_packets: outVideoPackets },
      Object.assign({ index: 1, codec_type: 'audio', codec_name: 'aac', nb_read_packets: '4300' }, o.outAudio),
      { index: 2, codec_type: 'subtitle', codec_name: 'subrip', nb_read_packets: '2' },
    ].map((x) => JSON.parse(JSON.stringify(x))),
    format: { duration: '100.2' },
  };
  const outTracks = goodBoyTracks.slice(0, 2).concat([{ id: 2, type: 'subtitles', properties: { codec_id: 'S_TEXT/UTF8' } }]);
  stubs = {
    fs: {
      existsSync: () => true,
      unlinkSync: (p) => { unlinked.push(p); },
      readFileSync: (p) => {
        if (!(p in files)) throw new Error('unexpected read ' + p);
        return files[p];
      },
    },
    child_process: {
      spawnSync: (cmd, args) => {
        calls.push([cmd].concat(args));
        if (cmd === 'mkvmerge' && args[0] === '-J') {
          return { status: 0, stdout: JSON.stringify({ tracks: args[1] === '/w/out.mkv' ? outTracks : goodBoyTracks }) };
        }
        if (/ffprobe$/.test(cmd)) {
          if (args.includes('format=duration')) return { status: 0, stdout: o.durationProbe };
          if (args.includes('packet=size')) {
            const key = args[args.length - 1] + '#' + args[args.indexOf('-select_streams') + 1];
            if (!o.listings || !(key in o.listings)) throw new Error('unexpected listing ' + key);
            return { status: 0, stdout: o.listings[key] };
          }
          return { status: 0, stdout: JSON.stringify(args[args.length - 1] === '/w/out.mkv' ? outProbe : inCounts) };
        }
        return { status: 0, stdout: '', stderr: '' };
      },
    },
  };
  try {
    const res = call(
      { _id: '/m/a.mkv', container: 'mkv', ffProbeData: { streams: goodBoyStreams, format: o.inFormat || { duration: '100' } } },
      { cacheFilePath: '/w/out.mkv', ffmpegPath: 'tdarr-ffmpeg', mkvpropeditPath: 'mkvpropedit' },
    );
    return { res, calls, unlinked };
  } finally {
    stubs = null;
  }
};

test('plugin: verifies kept tracks by packet counts against the source and hands on the output', () => {
  const { res, calls, unlinked } = runFull('2500');
  assert.strictEqual(res.error, undefined, res.infoLog);
  assert.strictEqual(res.file._id, '/w/out.mkv');
  const probes = calls.filter((c) => /ffprobe$/.test(c[0]));
  assert.deepStrictEqual(probes.map((c) => c[c.length - 1]), ['/m/a.mkv', '/w/out.mkv']);
  probes.forEach((c) => assert.ok(c.includes('-count_packets'), c.join(' ')));
  assert.ok(!probes[1].includes('-select_streams'), 'output pass covers every stream');
  assert.match(res.infoLog, /0 \(video\) 2500, 1 \(audio\) 4300/);
  assert.ok(!unlinked.includes('/w/out.mkv'));
  assert.ok(!calls.some((c) => c.includes('packet=size')), 'no packet listing when every count is known');
});

const listingCalls = (calls) => calls.filter((c) => c.includes('packet=size'))
  .map((c) => c[c.length - 1] + '#' + c[c.indexOf('-select_streams') + 1]).sort();

test('plugin: PCM is verified by payload bytes listed on both files', () => {
  const pcm = {
    inAudio: { nb_read_packets: '2813' },
    outAudio: { codec_name: 'pcm_s16le', nb_read_packets: '1500' },
    listings: { '/m/a.mkv#1': '4000\n4000\n4000\n', '/w/out.mkv#1': '6000\n6000\n' },
  };
  const { res, calls } = runFull('2500', pcm);
  assert.strictEqual(res.error, undefined, res.infoLog);
  assert.deepStrictEqual(listingCalls(calls), ['/m/a.mkv#1', '/w/out.mkv#1']);
  assert.match(res.infoLog, /kept streams match the source exactly \(packets, or bytes for PCM\): 0 \(video\) 2500, 1 \(audio\) 12000 bytes\./);
  const short = runFull('2500', Object.assign({}, pcm, { listings: { '/m/a.mkv#1': '4000\n4000\n4000\n', '/w/out.mkv#1': '6000\n5999\n' } }));
  assert.match(short.res.error, /output stream 1 \(audio, pcm_s16le\) has 11999 bytes, source has 12000/);
});

test('plugin: an unknown (N/A) packet count is resolved by listing that stream, exactly', () => {
  // ffprobe leaves nb_read_packets out of JSON for a stream with no packets.
  const empty = { inAudio: { nb_read_packets: undefined }, outAudio: { nb_read_packets: undefined }, listings: { '/m/a.mkv#1': '', '/w/out.mkv#1': '' } };
  const { res, calls } = runFull('2500', empty);
  assert.strictEqual(res.error, undefined, res.infoLog);
  assert.deepStrictEqual(listingCalls(calls), ['/m/a.mkv#1', '/w/out.mkv#1']);
  assert.match(res.infoLog, /1 \(audio\) 0/);
  // Source unknown and really 3 packets; output counted 2: fails.
  const lost = runFull('2500', { inAudio: { nb_read_packets: 'N/A' }, outAudio: { nb_read_packets: '2' }, listings: { '/m/a.mkv#1': '9\n9\n9\n' } });
  assert.match(lost.res.error, /output stream 1 \(audio\) has 2 packets, source has 3/);
});

test('plugin: a kept stream short by one packet fails the job and removes the output', () => {
  const { res, unlinked } = runFull('2499');
  assert.match(res.error, /output stream 0 \(video\) has 2499 packets, source has 2500/);
  assert.strictEqual(res.file._id, '/m/a.mkv');
  assert.ok(unlinked.includes('/w/out.mkv'));
});

const durationProbes = (calls) => calls.filter((c) => /ffprobe$/.test(c[0]) && c.includes('format=duration'));

test('plugin: no duration in the probe data: measures it with ffprobe and uses the result', () => {
  const { res, calls } = runFull('2500', { inFormat: {}, durationProbe: JSON.stringify({ format: { duration: '100.000000' } }) });
  assert.strictEqual(res.error, undefined, res.infoLog);
  const d = durationProbes(calls);
  assert.strictEqual(d.length, 1);
  assert.strictEqual(d[0][d[0].length - 1], '/m/a.mkv');
  // The measured value is the one checked: a measured 50s makes the 100.2s output too long.
  const short = runFull('2500', { inFormat: { duration: '0' }, durationProbe: JSON.stringify({ format: { duration: '50' } }) });
  assert.match(short.res.error, /output is longer than the input: 100.2s vs 50s/);
});

test('plugin: no duration in the probe data and ffprobe returns nothing: the job fails before muxing', () => {
  ['', '{}', JSON.stringify({ format: {} }), JSON.stringify({ format: { duration: 'N/A' } })].forEach((out) => {
    const { res, calls } = runFull('2500', { inFormat: {}, durationProbe: out });
    assert.match(res.error, /could not measure the input duration/, JSON.stringify(out));
    assert.strictEqual(res.file._id, '/m/a.mkv');
    assert.ok(!calls.some((c) => c[0] === 'mkvextract'), 'stopped before extracting');
  });
});

test('details: id matches the filename', () => {
  assert.strictEqual(pluginModule.details().id, 'Tdarr_Plugin_the1nk_convert_unsupported_subs');
});

test('details: description names the PCM byte check', () => {
  assert.match(pluginModule.details().Description,
    /exact packet count for every kept track except PCM, which is checked by exact payload bytes/);
});
