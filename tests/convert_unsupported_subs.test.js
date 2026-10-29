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

const pluginModule = require(path.join(__dirname, '..', 'plugins', 'Tdarr_Plugin_the1nk_convert_unsupported_subs.js'));
const {
  findUnreadableSubs, planTracks, buildMerge, toolFailed, cueStats, verifyOutput, pickFfprobe,
  vttProblem, packetCount, sumPacketCsv, comparesBytes, readTrackEntries, mapTracks, filtersBlankBlocks,
  parseExtractedSrt, keptTextStats,
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

// --- Matroska Tracks header and the ffprobe <-> mkvmerge mapping ---

// EBML element with an 8-byte size (legal for any element).
const ebml = (idHex, payload) => {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const size = Buffer.alloc(8);
  size[0] = 0x01;
  size.writeUIntBE(data.length, 2, 6);
  return Buffer.concat([Buffer.from(idHex, 'hex'), size, data]);
};
const TRACK_TYPE = { video: 1, audio: 2, subtitles: 0x11, buttons: 0x12, metadata: 0x21, logo: 0x10, complex: 3, control: 0x20 };
// A Matroska file start: EBML header, Segment with SeekHead, Info, Void, Tracks (one TrackEntry per
// {type, codec}), then a Cluster. opts.clusterFirst puts the Cluster before Tracks.
const mkvHeader = (tracks, opts) => {
  const o = opts || {};
  const entries = tracks.map((t, i) => ebml('ae', Buffer.concat([
    ebml('d7', Buffer.from([i + 1])), ebml('83', Buffer.from([TRACK_TYPE[t.type]])), ebml('86', t.codec || 'X')])));
  const trackEl = ebml('1654ae6b', Buffer.concat(entries));
  const cluster = ebml('1f43b675', Buffer.alloc(64));
  const body = [ebml('114d9b74', Buffer.alloc(12)), ebml('1549a966', ebml('2ad7b1', Buffer.from([1]))), ebml('ec', Buffer.alloc(5))]
    .concat(o.clusterFirst ? [cluster, trackEl] : [trackEl, cluster]);
  return Buffer.concat([ebml('1a45dfa3', ebml('4282', 'matroska')), ebml('18538067', Buffer.concat(body))]);
};
const readerOf = (buf) => (pos, len) => buf.slice(pos, pos + len);
const headerOf = (mkvTracks) => mkvHeader(mkvTracks.map((t) => ({ type: t.type, codec: (t.properties || {}).codec_id })));

test('readTrackEntries: lists every TrackEntry in order with its type name and codec', () => {
  const h = mkvHeader([{ type: 'video', codec: 'V_MPEG4/ISO/AVC' }, { type: 'buttons', codec: 'B_VOBBTN' }, { type: 'audio', codec: 'A_AAC' }, { type: 'metadata', codec: 'S_TEXT/UTF8' }]);
  assert.deepStrictEqual(readTrackEntries(readerOf(h)), [
    { type: 'video', codec: 'V_MPEG4/ISO/AVC' }, { type: 'buttons', codec: 'B_VOBBTN' },
    { type: 'audio', codec: 'A_AAC' }, { type: 'metadata', codec: 'S_TEXT/UTF8' }]);
});

test('readTrackEntries: reads only element headers until Tracks (never the clusters)', () => {
  const h = mkvHeader([{ type: 'video', codec: 'V' }]);
  const big = Buffer.concat([h, Buffer.alloc(1000000)]);
  let bytes = 0;
  const entries = readTrackEntries((pos, len) => { bytes += len; return big.slice(pos, pos + len); });
  assert.strictEqual(entries.length, 1);
  assert.ok(bytes < 400, 'read ' + bytes + ' bytes');
});

test('readTrackEntries: fails clearly on a non-Matroska file, a Cluster before Tracks, or a truncated header', () => {
  assert.throws(() => readTrackEntries(readerOf(Buffer.from('not a matroska file at all'))), /not a Matroska file/);
  assert.throws(() => readTrackEntries(readerOf(mkvHeader([{ type: 'video' }], { clusterFirst: true }))), /no Tracks element before the first Cluster/);
  const h = mkvHeader([{ type: 'video' }]);
  assert.throws(() => readTrackEntries(readerOf(h.slice(0, 80))), /truncated|no Tracks element/);
});

test('readTrackEntries: refuses a Tracks element claiming more than 16 MB', () => {
  const h = mkvHeader([{ type: 'video', codec: 'V' }]);
  // Rewrite the Tracks element's 8-byte size to 1 GB.
  const at = h.indexOf(Buffer.from('1654ae6b', 'hex'));
  const bad = Buffer.from(h);
  bad.writeUIntBE(1024 * 1024 * 1024, at + 4 + 2, 6);
  let asked = 0;
  assert.throws(() => readTrackEntries((pos, len) => { asked = Math.max(asked, len); return bad.slice(pos, pos + len); }),
    /Tracks element claims 1073741824 bytes; the file looks corrupt/);
  assert.ok(asked <= 16, 'never asked for the claimed size');
});

test('mapTracks: Good Boy maps 1:1; cover art and attachments are ignored', () => {
  const streams = goodBoyStreams.concat([
    { index: 3, codec_type: 'video', codec_name: 'mjpeg', disposition: { attached_pic: 1 } },
    { index: 4, codec_type: 'attachment', codec_name: 'ttf' }]);
  const m = mapTracks(readTrackEntries(readerOf(headerOf(goodBoyTracks))), streams, goodBoyTracks);
  assert.strictEqual(m.error, undefined);
  assert.deepStrictEqual(m.ffIndex, { 0: 0, 1: 1, 2: 2 });
  assert.deepStrictEqual(m.mkvId, { 0: 0, 1: 1, 2: 2 });
  assert.deepStrictEqual(m.others, []);
});

test('mapTracks: a buttons track in the middle (ffprobe renumbers, mkvmerge leaves a gap) maps by order and is reported', () => {
  const entries = [{ type: 'video', codec: 'V_MPEG4/ISO/AVC' }, { type: 'buttons', codec: 'B_VOBBTN' }, { type: 'audio', codec: 'A_AAC' }, { type: 'subtitles', codec: 'S_TEXT/WEBVTT' }];
  const mkv = [goodBoyTracks[0], Object.assign({}, goodBoyTracks[1], { id: 2 }), Object.assign({}, goodBoyTracks[2], { id: 3 })];
  const m = mapTracks(entries, goodBoyStreams, mkv);
  assert.strictEqual(m.error, undefined);
  assert.deepStrictEqual(m.ffIndex, { 0: 0, 2: 1, 3: 2 });
  assert.deepStrictEqual(m.mkvId, { 0: 0, 1: 2, 2: 3 });
  assert.deepStrictEqual(m.others, [{ id: 1, type: 'buttons', codec: 'B_VOBBTN' }]);
});

test('mapTracks: a metadata track ffprobe lists without a codec_type keeps the indexes aligned and is reported', () => {
  const entries = [{ type: 'video', codec: 'V' }, { type: 'metadata', codec: 'S_TEXT/UTF8' }, { type: 'audio', codec: 'A' }, { type: 'subtitles', codec: 'S_TEXT/WEBVTT' }];
  const streams = [goodBoyStreams[0], { index: 1, codec_name: 'subrip' }, Object.assign({}, goodBoyStreams[1], { index: 2 }), Object.assign({}, goodBoyStreams[2], { index: 3 })];
  const mkv = [goodBoyTracks[0], Object.assign({}, goodBoyTracks[1], { id: 2 }), Object.assign({}, goodBoyTracks[2], { id: 3 })];
  const m = mapTracks(entries, streams, mkv);
  assert.strictEqual(m.error, undefined);
  assert.deepStrictEqual(m.ffIndex, { 0: 0, 2: 2, 3: 3 });
  assert.deepStrictEqual(m.others, [{ id: 1, type: 'metadata', codec: 'S_TEXT/UTF8' }]);
});

test('mapTracks: a metadata track ffprobe lists as a subtitle stream (seen with S_TEXT/UTF8) is told apart by alignment', () => {
  // Measured: [video, audio, metadata (S_TEXT/UTF8), WebVTT] -> ffprobe 0 video, 1 audio, 2 subtitle/subrip, 3 subtitle.
  const entries = [{ type: 'video', codec: 'V' }, { type: 'audio', codec: 'A' }, { type: 'metadata', codec: 'S_TEXT/UTF8' }, { type: 'subtitles', codec: 'S_TEXT/WEBVTT' }];
  const streams = [goodBoyStreams[0], goodBoyStreams[1], { index: 2, codec_type: 'subtitle', codec_name: 'subrip' }, { index: 3, codec_type: 'subtitle' }];
  const mkv = [goodBoyTracks[0], goodBoyTracks[1], Object.assign({}, goodBoyTracks[2], { id: 3 })];
  const m = mapTracks(entries, streams, mkv);
  assert.strictEqual(m.error, undefined);
  assert.deepStrictEqual(m.ffIndex, { 0: 0, 1: 1, 3: 3 });
  assert.deepStrictEqual(m.mkvId, { 0: 0, 1: 1, 3: 3 });
  assert.deepStrictEqual(m.others, [{ id: 2, type: 'metadata', codec: 'S_TEXT/UTF8' }]);
});

test('mapTracks: disagreements fail with a precise message', () => {
  const entries = readTrackEntries(readerOf(headerOf(goodBoyTracks)));
  assert.match(mapTracks(entries, goodBoyStreams, goodBoyTracks.slice(0, 2)).error,
    /mkvmerge lists 2 tracks, the file header has 3 video, audio and subtitle tracks/);
  assert.match(mapTracks(entries, goodBoyStreams.slice(0, 2), goodBoyTracks).error,
    /ffprobe streams \[0 video, 1 audio\] cannot be matched to the file's tracks \[video, audio, subtitles\]/);
  const swapped = [goodBoyStreams[1], goodBoyStreams[0], goodBoyStreams[2]].map((x, i) => Object.assign({}, x, { index: i }));
  assert.match(mapTracks(entries, swapped, goodBoyTracks).error, /ffprobe streams \[0 audio, 1 video, 2 subtitle\] cannot be matched/);
  const wrongId = [goodBoyTracks[0], Object.assign({}, goodBoyTracks[1], { id: 5 }), goodBoyTracks[2]];
  assert.match(mapTracks(entries, goodBoyStreams, wrongId).error, /mkvmerge track 5 is audio, header track 1 is audio/);
  const extra = goodBoyStreams.concat([{ index: 3, codec_type: 'data', codec_name: 'bin_data' }]);
  assert.match(mapTracks(entries, extra, goodBoyTracks).error, /\[0 video, 1 audio, 2 subtitle, 3 data\] cannot be matched/);
});

test('mapTracks: two different pairings that both fit are refused', () => {
  // [metadata, subtitles, metadata] with two subtitle streams: the subtitle track could be either.
  const entries = [{ type: 'metadata', codec: 'S_TEXT/UTF8' }, { type: 'subtitles', codec: 'S_TEXT/WEBVTT' }, { type: 'metadata', codec: 'S_TEXT/UTF8' }];
  const streams = [{ index: 0, codec_type: 'subtitle', codec_name: 'subrip' }, { index: 1, codec_type: 'subtitle', codec_name: 'subrip' }];
  const m = mapTracks(entries, streams, [{ id: 1, type: 'subtitles', properties: { codec_id: 'S_TEXT/WEBVTT' } }]);
  assert.match(m.error, /match the file's tracks in more than one way/);
});

test('planTracks: S_TEXT/WEBVTT is converted, other unreadable subtitles are dropped', () => {
  const tracks = goodBoyTracks.concat([
    { id: 3, type: 'subtitles', codec: 'HDMV TextST', properties: { codec_id: 'S_HDMV/TEXTST' } },
  ]);
  const plan = planTracks(tracks, [2, 3]);
  assert.deepStrictEqual(plan.convert.map((t) => t.id), [2]);
  assert.deepStrictEqual(plan.drop.map((t) => t.id), [3]);
});

test('planTracks: throws when an ID is not an mkvmerge subtitle track', () => {
  assert.throws(() => planTracks(goodBoyTracks, [1]), /mkvmerge track 1, which is not a subtitle track/);
  assert.throws(() => planTracks(goodBoyTracks, [7]), /mkvmerge track 7, which is not a subtitle track/);
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

test('buildMerge: nothing to convert or drop gives a plain remux (no empty --subtitle-tracks)', () => {
  const tracks = goodBoyTracks.slice(0, 2);
  const built = buildMerge('/in/f.mkv', '/out/f.mkv', tracks, { convert: [], drop: [] }, {});
  assert.deepStrictEqual(built.args, ['-o', '/out/f.mkv', '/in/f.mkv', '--track-order', '0:0,0:1']);
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

test('cueStats: mkvmerge treats only space, tab, CR and LF as blank (NBSP, form feed, vertical tab are kept)', () => {
  const srt = '1\n00:00:01,000 --> 00:00:02,000\n \t \n\n2\n00:00:03,000 --> 00:00:04,000\n\u00a0\n\n'
    + '3\n00:00:05,000 --> 00:00:06,000\nX\n\n4\n00:00:07,000 --> 00:00:08,000\n\f\n\n5\n00:00:09,000 --> 00:00:10,000\n\v\n\n';
  const s = cueStats(srt, 'srt');
  assert.strictEqual(s.content, 1);
  assert.strictEqual(s.muxed, 4);
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

// --- kept text subtitle tracks that mkvmerge filters ---

test('filtersBlankBlocks: only S_TEXT/UTF8 and S_TEXT/ASCII', () => {
  ['S_TEXT/UTF8', 'S_TEXT/ASCII'].forEach((c) => assert.ok(filtersBlankBlocks(c), c));
  ['S_TEXT/ASS', 'S_TEXT/SSA', 'S_TEXT/USF', 'S_TEXT/WEBVTT', 'S_HDMV/PGS', 'S_VOBSUB', 'S_DVBSUB', 'A_AAC', undefined]
    .forEach((c) => assert.ok(!filtersBlankBlocks(c), c));
});

// The reviewer's reproducer: an FFmpeg-muxed, stream-copied SRT track with a "   " cue (4 packets),
// as mkvextract writes it. mkvmerge keeps 3 blocks.
const keptSrt4 = '\uFEFF1\n00:00:01,000 --> 00:00:02,000\nOne\n\n2\n00:00:03,000 --> 00:00:04,000\n   \n\n'
  + '3\n00:00:05,000 --> 00:00:06,000\nThree\n\n4\n00:00:07,000 --> 00:00:08,000\nFour\n\n';

test('keptTextStats: reviewer reproducer, 4 blocks extracted, 3 kept', () => {
  assert.deepStrictEqual(keptTextStats(keptSrt4), { entries: 4, kept: 3 });
});

test('keptTextStats: the measured block rule (blank = only space, tab, CR, LF)', () => {
  // The blocks measured in the container: "Normal", "   ", tab, NBSP, "<i></i>", "<i> </i>",
  // "{\an8}", " \n ", "End" -> mkvmerge kept Normal, NBSP, <i></i>, <i> </i>, {\an8}, End.
  const texts = ['Normal', '   ', '\t', '\u00a0', '<i></i>', '<i> </i>', '{\\an8}', ' \n ', 'End'];
  const srt = texts.map((t, i) => (i + 1) + '\n00:00:0' + i + ',000 --> 00:00:0' + i + ',500\n' + t + '\n\n').join('');
  assert.deepStrictEqual(keptTextStats(srt), { entries: 9, kept: 6 });
  assert.deepStrictEqual(keptTextStats('1\n00:00:01,000 --> 00:00:02,000\n\f\n\n'), { entries: 1, kept: 1 });
});

test('parseExtractedSrt: entries split on the numbered headers, so blank lines inside a block stay in it', () => {
  const srt = '\uFEFF1\n00:00:01,000 --> 00:00:01,500\nA\n\n2\n00:00:02,000 --> 00:00:02,500\nfirst\n\nsecond\n\n'
    + '3\n00:00:03,000 --> 00:00:03,500\n\n\nlate\n\n4\n00:00:04,000 --> 00:00:04,500\n\n\n';
  const e = parseExtractedSrt(srt);
  assert.strictEqual(e.length, 4);
  assert.match(e[1], /first\n\nsecond/);
  assert.match(e[2], /late/);
  assert.deepStrictEqual(keptTextStats(srt), { entries: 4, kept: 3 });
  // A block whose text looks like a number but isn't the next header stays text.
  assert.strictEqual(parseExtractedSrt('1\n00:00:01,000 --> 00:00:02,000\n7\n\n2\n00:00:03,000 --> 00:00:04,000\nB\n\n').length, 2);
  assert.deepStrictEqual(parseExtractedSrt(''), []);
  assert.deepStrictEqual(keptTextStats(null), { entries: 0, kept: 0 });
});

// --- verifyOutput ---

const layoutGB = [
  { track: goodBoyTracks[0], converted: false },
  { track: goodBoyTracks[1], converted: false },
  { track: goodBoyTracks[2], converted: true },
];
const srtOut = { codec_id: 'S_TEXT/UTF8', language: 'eng', language_ietf: 'en', default_track: true, forced_track: false };
const outTracksGB = [
  { type: 'video', properties: { codec_id: 'V_MPEG4/ISO/AVC' } },
  { type: 'audio', properties: { codec_id: 'A_AAC' } },
  { type: 'subtitles', properties: srtOut },
];
const outStreamsGB = [
  { index: 0, codec_type: 'video', codec_name: 'h264' },
  { index: 1, codec_type: 'audio', codec_name: 'aac' },
  { index: 2, codec_type: 'subtitle', codec_name: 'subrip' },
];
const okOutput = (over) => Object.assign({
  layout: layoutGB,
  outTracks: outTracksGB,
  outStreams: outStreamsGB,
  srcCounts: { 0: { packets: 108595 }, 1: { packets: 212102 } },
  outCounts: { 0: { packets: 108595 }, 1: { packets: 212102 }, 2: { packets: 285 } },
  expectedPackets: { 2: 285 },
  extractedEntries: {},
  inDuration: 100,
  outDuration: 100.2,
  lossy: false,
}, over);
const withOut = (pos, counts) => Object.assign({}, okOutput({}).outCounts, { [pos]: counts });
const withOutTrack = (props) => [outTracksGB[0], outTracksGB[1], { type: 'subtitles', properties: Object.assign({}, srtOut, props) }];

test('verifyOutput: passes a correct conversion (equal packet counts)', () => {
  assert.strictEqual(verifyOutput(okOutput({})), null);
});

test('verifyOutput: wrong track count', () => {
  assert.match(verifyOutput(okOutput({ outTracks: outTracksGB.slice(0, 2) })), /2 tracks, expected 3/);
});

test('verifyOutput: wrong type or codec at a position', () => {
  const swapped = [outTracksGB[1], outTracksGB[0], outTracksGB[2]];
  assert.match(verifyOutput(okOutput({ outTracks: swapped })), /output track 0 is audio/);
  const stillVtt = withOutTrack({ codec_id: 'S_TEXT/WEBVTT' });
  assert.match(verifyOutput(okOutput({ outTracks: stillVtt })), /track 2 .*expected subtitles\/S_TEXT\/UTF8/);
});

test('verifyOutput: converted track metadata must match the source', () => {
  assert.match(verifyOutput(okOutput({ outTracks: withOutTrack({ language_ietf: 'fr' }) })), /output track 2 language is fr, source has en/);
  assert.match(verifyOutput(okOutput({ outTracks: withOutTrack({ default_track: false }) })), /output track 2 default_track is false, source has true/);
  assert.match(verifyOutput(okOutput({ outTracks: withOutTrack({ forced_track: true }) })), /forced_track is true, source has false/);
});

test('verifyOutput: converted metadata compares only what the source defines, with mkvmerge defaults', () => {
  const src = {
    codec_id: 'S_TEXT/WEBVTT', language: 'spa', track_name: 'Spanish CC', forced_track: true,
    flag_hearing_impaired: true, flag_commentary: false, enabled_track: false,
  };
  const layout = [layoutGB[0], layoutGB[1], { track: { id: 2, type: 'subtitles', properties: src }, converted: true }];
  // What mkvmerge -J reports for the muxed track: language "spa" also gets language_ietf "es".
  const out = {
    codec_id: 'S_TEXT/UTF8', language: 'spa', language_ietf: 'es', track_name: 'Spanish CC', default_track: false,
    forced_track: true, flag_hearing_impaired: true, flag_commentary: false, enabled_track: false,
  };
  const v = (props) => okOutput({ layout, outTracks: [outTracksGB[0], outTracksGB[1], { type: 'subtitles', properties: Object.assign({}, out, props) }] });
  assert.strictEqual(verifyOutput(v({})), null);
  assert.match(verifyOutput(v({ track_name: 'Other' })), /track_name is Other, source has Spanish CC/);
  assert.match(verifyOutput(v({ language: 'eng' })), /language is eng, source has spa/);
  assert.match(verifyOutput(v({ flag_hearing_impaired: false })), /flag_hearing_impaired is false, source has true/);
  assert.match(verifyOutput(v({ flag_commentary: undefined })), /flag_commentary is undefined, source has false/);
  assert.match(verifyOutput(v({ enabled_track: true })), /enabled_track is true, source has false/);
  // Flags the source doesn't define are not compared.
  assert.strictEqual(verifyOutput(v({ flag_original: true })), null);
  // A source with no language at all must come out as und.
  const bare = [layoutGB[0], layoutGB[1], { track: { id: 2, type: 'subtitles', properties: { codec_id: 'S_TEXT/WEBVTT' } }, converted: true }];
  const und = { codec_id: 'S_TEXT/UTF8', language: 'und', language_ietf: 'und', default_track: false, forced_track: false };
  assert.strictEqual(verifyOutput(okOutput({ layout: bare, outTracks: [outTracksGB[0], outTracksGB[1], { type: 'subtitles', properties: und }] })), null);
  const eng = Object.assign({}, und, { language: 'eng', language_ietf: 'en' });
  assert.match(verifyOutput(okOutput({ layout: bare, outTracks: [outTracksGB[0], outTracksGB[1], { type: 'subtitles', properties: eng }] })), /language is eng, source has und/);
});

test('verifyOutput: ffprobe must see one subtitle stream per layout subtitle', () => {
  assert.match(verifyOutput(okOutput({ outStreams: outStreamsGB.slice(0, 2) })), /0 subtitle streams in the output, expected 1/);
});

test('verifyOutput: unreadable output subtitle stream', () => {
  const s = outStreamsGB.slice(0, 2).concat([{ index: 2, codec_type: 'subtitle' }]);
  assert.match(verifyOutput(okOutput({ outStreams: s })), /stream 2 is still unreadable/);
});

test('verifyOutput: subtitle stream that is not a subtitle in the layout', () => {
  const odd = [outStreamsGB[0], { index: 1, codec_type: 'subtitle', codec_name: 'subrip' }, { index: 2, codec_type: 'audio', codec_name: 'aac' }];
  assert.match(verifyOutput(okOutput({ outStreams: odd })), /stream 1 .*not a subtitle/);
});

test('verifyOutput: converted cue count mismatch; a missing count fails', () => {
  assert.match(verifyOutput(okOutput({ outCounts: withOut(2, { packets: 284 }) })), /284 cues, expected 285/);
  assert.match(verifyOutput(okOutput({ outCounts: withOut(2, { packets: NaN }) })), /output stream 2 has no packet count/);
});

test('verifyOutput: a kept video or audio stream short by one packet fails', () => {
  assert.strictEqual(verifyOutput(okOutput({ outCounts: withOut(0, { packets: 108594 }) })),
    'output stream 0 (video) has 108594 packets, source has 108595');
  assert.strictEqual(verifyOutput(okOutput({ outCounts: withOut(1, { packets: 212101 }) })),
    'output stream 1 (audio) has 212101 packets, source has 212102');
  assert.match(verifyOutput(okOutput({ outCounts: withOut(0, { packets: 108596 }) })), /108596 packets, source has 108595/);
});

test('verifyOutput: sub-1s truncation is caught by packet counts even when the duration is in tolerance', () => {
  assert.match(verifyOutput(okOutput({ outCounts: withOut(0, { packets: 108570 }), outDuration: 99.2 })), /output stream 0 \(video\) has 108570 packets/);
});

// Source: video, audio, dropped HDMV (2), kept ASS (3), converted WebVTT (4). Output positions 0..3.
const mixedTracks = [
  { id: 0, type: 'video', properties: { codec_id: 'V_MPEG4/ISO/AVC' } },
  { id: 1, type: 'audio', properties: { codec_id: 'A_AAC' } },
  { id: 2, type: 'subtitles', properties: { codec_id: 'S_HDMV/TEXTST' } },
  { id: 3, type: 'subtitles', properties: { codec_id: 'S_TEXT/ASS' } },
  { id: 4, type: 'subtitles', properties: { codec_id: 'S_TEXT/WEBVTT' } },
];
const mixed = (outSubPackets) => {
  const built = buildMerge('/in/m.mkv', '/out/m.mkv', mixedTracks, planTracks(mixedTracks, [2, 4]), { 4: '/w/track4.srt' });
  return {
    layout: built.layout,
    outTracks: [mixedTracks[0], mixedTracks[1], mixedTracks[3], { type: 'subtitles', properties: { codec_id: 'S_TEXT/UTF8', language: 'und', language_ietf: 'und', default_track: false, forced_track: false } }],
    outStreams: [
      { index: 0, codec_type: 'video', codec_name: 'h264' },
      { index: 1, codec_type: 'audio', codec_name: 'aac' },
      { index: 2, codec_type: 'subtitle', codec_name: 'ass' },
      { index: 3, codec_type: 'subtitle', codec_name: 'subrip' },
      { index: 4, codec_type: 'attachment' },
    ],
    srcCounts: { 0: { packets: 250 }, 1: { packets: 432 }, 3: { packets: 17 } },
    outCounts: { 0: { packets: 250 }, 1: { packets: 432 }, 2: { packets: outSubPackets }, 3: { packets: 4 } },
    expectedPackets: { 4: 4 },
    extractedEntries: {},
    inDuration: 120,
    outDuration: 10.03,
    lossy: true,
  };
};

test('verifyOutput: kept readable subtitle (ASS: kept 1:1) is compared with its own source stream via the layout', () => {
  assert.strictEqual(verifyOutput(mixed(17)), null);
  assert.strictEqual(verifyOutput(mixed(16)), 'output stream 2 (subtitle) has 16 packets, source has 17');
});

// Kept FFmpeg-muxed SRT (the reviewer's reproducer): 4 source packets, mkvmerge keeps 3.
const keptSrtTracks = goodBoyTracks.concat([{ id: 3, type: 'subtitles', properties: { codec_id: 'S_TEXT/UTF8' } }]);
const keptSrt = (over) => {
  const built = buildMerge('/in/k.mkv', '/out/k.mkv', keptSrtTracks, planTracks(keptSrtTracks, [2]), { 2: '/w/track2.srt' });
  return okOutput(Object.assign({
    layout: built.layout,
    outTracks: [outTracksGB[0], outTracksGB[1], outTracksGB[2], { type: 'subtitles', properties: { codec_id: 'S_TEXT/UTF8' } }],
    outStreams: outStreamsGB.slice(0, 2).concat([
      { index: 2, codec_type: 'subtitle', codec_name: 'subrip' }, { index: 3, codec_type: 'subtitle', codec_name: 'subrip' }]),
    srcCounts: { 0: { packets: 108595 }, 1: { packets: 212102 }, 3: { packets: 4 } },
    outCounts: { 0: { packets: 108595 }, 1: { packets: 212102 }, 2: { packets: 285 }, 3: { packets: 3 } },
    expectedPackets: { 2: 285, 3: 3 },
    extractedEntries: { 3: 4 },
  }, over));
};

test('verifyOutput: kept SRT with a blank block passes with the count mkvmerge keeps', () => {
  assert.strictEqual(verifyOutput(keptSrt({})), null);
});

test('verifyOutput: kept SRT fails on any other count, or when the extraction is incomplete', () => {
  const v = keptSrt({});
  assert.strictEqual(verifyOutput(keptSrt({ outCounts: Object.assign({}, v.outCounts, { 3: { packets: 4 } }) })),
    'output stream 3 (subtitle) has 4 packets, expected 3 (source 4, minus the blank blocks mkvmerge drops)');
  assert.match(verifyOutput(keptSrt({ outCounts: Object.assign({}, v.outCounts, { 3: { packets: 2 } }) })), /has 2 packets, expected 3/);
  assert.strictEqual(verifyOutput(keptSrt({ extractedEntries: { 3: 3 } })),
    'extracted track 3 has 3 entries, source stream has 4 packets');
  assert.match(verifyOutput(keptSrt({ extractedEntries: {} })), /extracted track 3 has no entry count/);
});

test('verifyOutput: a missing count on either side fails', () => {
  assert.match(verifyOutput(okOutput({ outCounts: withOut(0, undefined) })), /output stream 0 \(video\) has no packet count/);
  assert.match(verifyOutput(okOutput({ srcCounts: { 1: { packets: 212102 } } })), /source stream 0 has no packet count/);
  assert.match(verifyOutput(okOutput({ srcCounts: { 0: { packets: NaN }, 1: { packets: 212102 } } })), /source stream 0 has no packet count/);
  // A resolved count of 0 on both sides (an empty kept track) passes.
  assert.strictEqual(verifyOutput(okOutput({ srcCounts: { 0: { packets: 108595 }, 1: { packets: 0 } }, outCounts: withOut(1, { packets: 0 }) })), null);
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
  assert.deepStrictEqual(sumPacketCsv('7680\n3840'), { packets: 2, bytes: 11520 });
  assert.deepStrictEqual(sumPacketCsv(''), { packets: 0, bytes: 0 });
  assert.deepStrictEqual(sumPacketCsv(undefined), { packets: 0, bytes: 0 });
  assert.deepStrictEqual(sumPacketCsv('12\nN/A\n'), { packets: 2, bytes: NaN });
  // Streams through a large listing without splitting it.
  assert.deepStrictEqual(sumPacketCsv('1\n'.repeat(200000)), { packets: 200000, bytes: 200000 });
});

test('comparesBytes: PCM is compared by payload bytes, everything else by packets', () => {
  ['pcm_s16le', 'pcm_s24le', 'pcm_s32le', 'pcm_f32le', 'pcm_s16be', 'pcm_u8'].forEach((c) => assert.ok(comparesBytes(c), c));
  ['flac', 'truehd', 'dts', 'mp3', 'opus', 'vorbis', 'ac3', 'eac3', 'aac', 'alac', 'h264', 'subrip', undefined].forEach((c) => assert.ok(!comparesBytes(c), c));
});

// PCM from an FFmpeg-muxed source: mkvmerge re-packetizes (2813 -> 1500 packets), bytes are equal.
const pcmOutput = (outBytes, over) => okOutput(Object.assign({
  outStreams: [outStreamsGB[0], { index: 1, codec_type: 'audio', codec_name: 'pcm_s16le' }, outStreamsGB[2]],
  srcCounts: { 0: { packets: 108595 }, 1: { packets: 2813, bytes: 11520000 } },
  outCounts: withOut(1, { packets: 1500, bytes: outBytes }),
}, over));

test('verifyOutput: PCM passes on equal bytes despite different packet counts', () => {
  assert.strictEqual(verifyOutput(pcmOutput(11520000)), null);
});

test('verifyOutput: PCM short by one byte, or with bytes not measured, fails', () => {
  assert.strictEqual(verifyOutput(pcmOutput(11519999)), 'output stream 1 (audio, pcm_s16le) has 11519999 bytes, source has 11520000');
  assert.match(verifyOutput(pcmOutput(undefined)), /output stream 1 \(audio, pcm_s16le\) has no byte count/);
  assert.match(verifyOutput(pcmOutput(11520000, { srcCounts: { 0: { packets: 108595 }, 1: { packets: 2813 } } })), /source stream 1 has no byte count/);
});

test('verifyOutput: strict +-1s duration when nothing was lost; input duration is required', () => {
  assert.match(verifyOutput(okOutput({ outDuration: 98.5 })), /duration mismatch/);
  assert.match(verifyOutput(okOutput({ outDuration: 101.5 })), /longer than the input/);
  assert.match(verifyOutput(okOutput({ inDuration: 0, outDuration: 5 })), /input duration/);
  assert.match(verifyOutput(okOutput({ inDuration: NaN, outDuration: 5 })), /input duration/);
});

test('verifyOutput: a dropped track that ran longest may shorten the output, but never lengthen it', () => {
  assert.strictEqual(verifyOutput(okOutput({ inDuration: 120, outDuration: 100.04, lossy: true })), null);
  assert.match(verifyOutput(okOutput({ inDuration: 120, outDuration: 122, lossy: true })), /longer than the input/);
  assert.strictEqual(verifyOutput(mixed(17)), null);
});

test('pickFfprobe: posix paths: bundled, then next to an absolute ffmpegPath, then PATH', () => {
  const p = path.posix;
  const bundled = '/app/Tdarr_Node/assets/app/ffmpeg/linux_x64/ffprobe';
  assert.strictEqual(pickFfprobe('/opt/ff/ffmpeg', () => true, p), bundled);
  assert.strictEqual(pickFfprobe('/opt/ff/ffmpeg', (x) => x === '/opt/ff/ffprobe', p), '/opt/ff/ffprobe');
  assert.strictEqual(pickFfprobe('/opt/ff/ffmpeg', () => false, p), 'ffprobe');
  assert.strictEqual(pickFfprobe('tdarr-ffmpeg', (x) => x === '/opt/ff/ffprobe', p), 'ffprobe');
  assert.strictEqual(pickFfprobe(undefined, () => false, p), 'ffprobe');
});

test('pickFfprobe: windows paths: ffprobe.exe next to an absolute ffmpeg.exe', () => {
  const w = path.win32;
  const seen = [];
  const exists = (x) => { seen.push(x); return x === 'C:\\ff\\ffprobe.exe'; };
  assert.strictEqual(pickFfprobe('C:\\ff\\ffmpeg.exe', exists, w), 'C:\\ff\\ffprobe.exe');
  assert.deepStrictEqual(seen, ['/app/Tdarr_Node/assets/app/ffmpeg/linux_x64/ffprobe', 'C:\\ff\\ffprobe.exe']);
  assert.strictEqual(pickFfprobe('ffmpeg.exe', () => true, w), '/app/Tdarr_Node/assets/app/ffmpeg/linux_x64/ffprobe');
  assert.strictEqual(pickFfprobe('ffmpeg.exe', () => false, w), 'ffprobe');
});

// --- the plugin, with stubbed fs / child_process ---

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

const W = (name) => path.join('/w', name);

// A stubbed run. Defaults are the Good Boy case (video, audio, WebVTT track 2 -> SRT); cfg overrides:
// srcStreams (Tdarr probe data), srcTracks / outTracks (mkvmerge -J), inCounts / outStreams (ffprobe
// -count_packets rows), outDuration, inFormat, durationProbe (stdout for "format=duration"),
// listings ("<file>#<stream>" -> "packet=size" stdout), files (path -> text; null = missing),
// merge (the mkvmerge mux result).
const run = (cfg) => {
  const c = Object.assign({
    srcStreams: goodBoyStreams,
    srcTracks: goodBoyTracks,
    outTracks: [outTracksGB[0], outTracksGB[1], { id: 2, type: 'subtitles', properties: srtOut }],
    inCounts: [{ index: 0, nb_read_packets: '2500' }, { index: 1, nb_read_packets: '4300' }],
    outStreams: [
      { index: 0, codec_type: 'video', codec_name: 'h264', nb_read_packets: '2500' },
      { index: 1, codec_type: 'audio', codec_name: 'aac', nb_read_packets: '4300' },
      { index: 2, codec_type: 'subtitle', codec_name: 'subrip', nb_read_packets: '2' },
    ],
    outDuration: '100.2',
    inFormat: { duration: '100' },
    listings: {},
    merge: { status: 0, stdout: '', stderr: '' },
  }, cfg);
  const header = c.header || headerOf(c.srcTracks);
  const files = Object.assign({}, { [W('track2.vtt')]: vtt4, [W('track2.srt')]: srt4 }, c.files);
  const calls = [];
  const unlinked = [];
  stubs = {
    fs: {
      existsSync: (p) => !(p in files) || files[p] !== null,
      openSync: (p) => { if (p !== '/m/a.mkv') throw new Error('unexpected open ' + p); return 42; },
      readSync: (fd, buf, off, len, pos) => header.copy(buf, off, pos, Math.min(pos + len, header.length)),
      closeSync: () => {},
      unlinkSync: (p) => { unlinked.push(p); },
      readFileSync: (p) => {
        if (!(p in files) || files[p] === null) throw new Error('unexpected read ' + p);
        return files[p];
      },
    },
    child_process: {
      spawnSync: (cmd, args) => {
        calls.push([cmd].concat(args));
        if (cmd === 'mkvmerge' && args[0] === '-J') {
          return { status: 0, stdout: JSON.stringify({ tracks: args[1] === '/w/out.mkv' ? c.outTracks : c.srcTracks }) };
        }
        if (cmd === 'mkvmerge') return c.merge;
        if (/ffprobe$/.test(cmd)) {
          if (args.includes('format=duration')) return { status: 0, stdout: c.durationProbe };
          if (args.includes('packet=size')) {
            const key = args[args.length - 1] + '#' + args[args.indexOf('-select_streams') + 1];
            if (!(key in c.listings)) throw new Error('unexpected listing ' + key);
            return { status: 0, stdout: c.listings[key] };
          }
          const out = args[args.length - 1] === '/w/out.mkv';
          return { status: 0, stdout: JSON.stringify(out ? { streams: c.outStreams, format: { duration: c.outDuration } } : { streams: c.inCounts }) };
        }
        return { status: 0, stdout: '', stderr: '' };
      },
    },
  };
  try {
    const res = call(
      { _id: '/m/a.mkv', container: 'mkv', ffProbeData: { streams: c.srcStreams, format: c.inFormat } },
      { cacheFilePath: '/w/out.mkv', ffmpegPath: 'tdarr-ffmpeg', mkvpropeditPath: 'mkvpropedit' },
    );
    return { res, calls, unlinked };
  } finally {
    stubs = null;
  }
};
const cmds = (calls, name) => calls.filter((x) => x[0] === name || (name === 'ffprobe' && /ffprobe$/.test(x[0])));
const listingCalls = (calls) => calls.filter((x) => x.includes('packet=size'))
  .map((x) => x[x.length - 1] + '#' + x[x.indexOf('-select_streams') + 1]).sort();

test('plugin: verifies kept tracks by packet counts, hands on the output and removes its temp files', () => {
  const { res, calls, unlinked } = run({});
  assert.strictEqual(res.error, undefined, res.infoLog);
  assert.strictEqual(res.file._id, '/w/out.mkv');
  const probes = cmds(calls, 'ffprobe');
  assert.deepStrictEqual(probes.map((x) => x[x.length - 1]), ['/m/a.mkv', '/w/out.mkv']);
  probes.forEach((x) => assert.ok(x.includes('-count_packets'), x.join(' ')));
  assert.ok(!probes[1].includes('-select_streams'), 'output pass covers every stream');
  assert.match(res.infoLog, /kept streams match the source exactly \(packets, or bytes for PCM\): 0 \(video\) 2500, 1 \(audio\) 4300\./);
  assert.deepStrictEqual(listingCalls(calls), []);
  assert.deepStrictEqual(unlinked.slice().sort(), [W('track2.srt'), W('track2.vtt')].sort());
});

test('plugin: converted-cue log separates left-out cues from invisible entries that are kept', () => {
  // vtt4: 4 cues; SRT keeps 2 with text; nothing invisible is muxed.
  assert.match(run({}).res.infoLog, /Converted WebVTT track 2 \(en\) to SRT: 2 cues with text, 2 left out \(empty or blank\)\./);
  const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi\n\n00:00:03.000 --> 00:00:04.000\n<i> </i>\n\n00:00:05.000 --> 00:00:06.000\n\n';
  const srt = '1\n00:00:01,000 --> 00:00:02,000\nHi\n\n2\n00:00:03,000 --> 00:00:04,000\n<i> </i>\n\n';
  const outStreams = [
    { index: 0, codec_type: 'video', codec_name: 'h264', nb_read_packets: '2500' },
    { index: 1, codec_type: 'audio', codec_name: 'aac', nb_read_packets: '4300' },
    { index: 2, codec_type: 'subtitle', codec_name: 'subrip', nb_read_packets: '2' },
  ];
  const { res } = run({ files: { [W('track2.vtt')]: vtt, [W('track2.srt')]: srt }, outStreams });
  assert.strictEqual(res.error, undefined, res.infoLog);
  assert.match(res.infoLog, /to SRT: 1 cue with text, 1 left out \(empty or blank\), 1 kept as an invisible entry\./);
});

test('plugin: mkvmerge exit 1 (warnings) passes and logs the warning', () => {
  const { res } = run({ merge: { status: 1, stdout: 'Warning: something odd', stderr: '' } });
  assert.strictEqual(res.error, undefined, res.infoLog);
  assert.match(res.infoLog, /mkvmerge warnings: Warning: something odd/);
  assert.strictEqual(res.file._id, '/w/out.mkv');
});

test('plugin: drop-only plan: no extraction, the track is removed, a shorter output is allowed', () => {
  const srcTracks = goodBoyTracks.slice(0, 2).concat([{ id: 2, type: 'subtitles', properties: { codec_id: 'S_HDMV/TEXTST' } }]);
  const { res, calls } = run({
    srcTracks,
    inFormat: { duration: '120' },
    outTracks: [outTracksGB[0], outTracksGB[1]],
    outStreams: [
      { index: 0, codec_type: 'video', codec_name: 'h264', nb_read_packets: '2500' },
      { index: 1, codec_type: 'audio', codec_name: 'aac', nb_read_packets: '4300' },
    ],
  });
  assert.strictEqual(res.error, undefined, res.infoLog);
  assert.deepStrictEqual(cmds(calls, 'mkvextract'), []);
  const merge = cmds(calls, 'mkvmerge').find((x) => x[1] === '-o');
  assert.deepStrictEqual(merge.slice(1), ['-o', '/w/out.mkv', '--subtitle-tracks', '!2', '/m/a.mkv', '--track-order', '0:0,0:1']);
  assert.match(res.infoLog, /Subtitle track 2 \(S_HDMV\/TEXTST\) is unreadable and not convertible, dropping it/);
});

// Good Boy plus a kept, FFmpeg-muxed SRT track 3 with a "   " block (the reviewer's reproducer).
const keptCfg = (outKeptPackets, extracted) => ({
  srcStreams: goodBoyStreams.concat([{ index: 3, codec_type: 'subtitle', codec_name: 'subrip' }]),
  srcTracks: keptSrtTracks,
  inCounts: [{ index: 0, nb_read_packets: '2500' }, { index: 1, nb_read_packets: '4300' }, { index: 3, nb_read_packets: '4' }],
  outTracks: [outTracksGB[0], outTracksGB[1], { id: 2, type: 'subtitles', properties: srtOut }, { id: 3, type: 'subtitles', properties: { codec_id: 'S_TEXT/UTF8' } }],
  outStreams: [
    { index: 0, codec_type: 'video', codec_name: 'h264', nb_read_packets: '2500' },
    { index: 1, codec_type: 'audio', codec_name: 'aac', nb_read_packets: '4300' },
    { index: 2, codec_type: 'subtitle', codec_name: 'subrip', nb_read_packets: '2' },
    { index: 3, codec_type: 'subtitle', codec_name: 'subrip', nb_read_packets: outKeptPackets },
  ],
  files: { [W('kept3.srt')]: extracted === undefined ? keptSrt4 : extracted },
});

test('plugin: kept SRT with a blank block: extracted in the same mkvextract call, expected count is 3', () => {
  const { res, calls, unlinked } = run(keptCfg('3'));
  assert.strictEqual(res.error, undefined, res.infoLog);
  const ex = cmds(calls, 'mkvextract');
  assert.strictEqual(ex.length, 1);
  assert.deepStrictEqual(ex[0].slice(1), ['/m/a.mkv', 'tracks', '2:' + W('track2.vtt'), '3:' + W('kept3.srt')]);
  assert.match(res.infoLog, /3 \(subtitle\) 3 of 4 \(1 blank block dropped by mkvmerge\)/);
  assert.ok(unlinked.includes(W('kept3.srt')));
});

test('plugin: kept SRT with the wrong output count, or an incomplete extraction, fails', () => {
  assert.match(run(keptCfg('4')).res.error, /output stream 3 \(subtitle\) has 4 packets, expected 3/);
  const short = keptSrt4.slice(0, keptSrt4.indexOf('4\n00:00:07'));
  assert.match(run(keptCfg('3', short)).res.error, /extracted track 3 has 3 entries, source stream has 4 packets/);
  assert.match(run(keptCfg('3', null)).res.error, /extracted track 3 is missing/);
});

test('plugin: drop-only plan with a kept SRT still extracts just that track', () => {
  const srcTracks = goodBoyTracks.slice(0, 2).concat([
    { id: 2, type: 'subtitles', properties: { codec_id: 'S_HDMV/TEXTST' } },
    { id: 3, type: 'subtitles', properties: { codec_id: 'S_TEXT/UTF8' } }]);
  const { res, calls } = run({
    srcTracks,
    srcStreams: goodBoyStreams.concat([{ index: 3, codec_type: 'subtitle', codec_name: 'subrip' }]),
    inCounts: [{ index: 0, nb_read_packets: '2500' }, { index: 1, nb_read_packets: '4300' }, { index: 3, nb_read_packets: '4' }],
    outTracks: [outTracksGB[0], outTracksGB[1], { id: 2, type: 'subtitles', properties: { codec_id: 'S_TEXT/UTF8' } }],
    outStreams: [
      { index: 0, codec_type: 'video', codec_name: 'h264', nb_read_packets: '2500' },
      { index: 1, codec_type: 'audio', codec_name: 'aac', nb_read_packets: '4300' },
      { index: 2, codec_type: 'subtitle', codec_name: 'subrip', nb_read_packets: '3' },
    ],
    files: { [W('kept3.srt')]: keptSrt4 },
  });
  assert.strictEqual(res.error, undefined, res.infoLog);
  assert.deepStrictEqual(cmds(calls, 'mkvextract').map((x) => x.slice(1)), [['/m/a.mkv', 'tracks', '3:' + W('kept3.srt')]]);
});

test('plugin: converted track metadata that differs in the output fails the job', () => {
  const { res } = run({ outTracks: [outTracksGB[0], outTracksGB[1], { id: 2, type: 'subtitles', properties: Object.assign({}, srtOut, { forced_track: true }) }] });
  assert.match(res.error, /output track 2 forced_track is true, source has false/);
});

test('plugin: ffprobe and mkvmerge disagreeing on the track layout fails before anything runs', () => {
  const { res, calls } = run({ srcTracks: goodBoyTracks.slice(0, 2).concat([goodBoyTracks[2], { id: 3, type: 'audio', properties: { codec_id: 'A_AAC' } }]) });
  assert.match(res.error, /ffprobe and mkvmerge disagree on the track layout: ffprobe streams \[0 video, 1 audio, 2 subtitle\] cannot be matched to the file's tracks \[video, audio, subtitles, audio\]/);
  assert.deepStrictEqual(cmds(calls, 'mkvextract'), []);
});

test('plugin: a video/audio/subtitle track mkvmerge cannot read would be lost, so the job fails', () => {
  const header = mkvHeader([{ type: 'video', codec: 'V_MPEG4/ISO/AVC' }, { type: 'audio', codec: 'A_AAC' }, { type: 'subtitles', codec: 'S_TEXT/WEBVTT' }, { type: 'audio', codec: 'A_WEIRD' }]);
  const { res } = run({ header });
  assert.match(res.error, /mkvmerge lists 3 tracks, the file header has 4 video, audio and subtitle tracks/);
});

test('plugin: a buttons track in the middle is dropped with a log line; IDs and stream indexes are mapped', () => {
  const header = mkvHeader([{ type: 'video', codec: 'V_MPEG4/ISO/AVC' }, { type: 'buttons', codec: 'B_VOBBTN' }, { type: 'audio', codec: 'A_AAC' }, { type: 'subtitles', codec: 'S_TEXT/WEBVTT' }]);
  const srcTracks = [goodBoyTracks[0], Object.assign({}, goodBoyTracks[1], { id: 2 }), Object.assign({}, goodBoyTracks[2], { id: 3 })];
  const { res, calls } = run({
    header,
    srcTracks,
    inFormat: { duration: '120' },
    files: { [W('track3.vtt')]: vtt4, [W('track3.srt')]: srt4 },
  });
  assert.strictEqual(res.error, undefined, res.infoLog);
  assert.match(res.infoLog, /Track 1 in the file \(buttons, B_VOBBTN\) is not a video, audio or subtitle track; mkvmerge can't read it, so it is dropped\./);
  assert.deepStrictEqual(cmds(calls, 'mkvextract').map((x) => x.slice(1)), [['/m/a.mkv', 'tracks', '3:' + W('track3.vtt')]]);
  const merge = cmds(calls, 'mkvmerge').find((x) => x[1] === '-o');
  assert.deepStrictEqual(merge.slice(1, 6), ['-o', '/w/out.mkv', '--subtitle-tracks', '!3', '/m/a.mkv']);
  assert.strictEqual(merge[merge.length - 1], '0:0,0:2,1:0');
  assert.match(res.infoLog, /0 \(video\) 2500, 1 \(audio\) 4300\./);
});

test('plugin: an unreadable subtitle stream that belongs to a non-AV track is dropped with that track', () => {
  // ffprobe shows a metadata-type TrackEntry with a codec it can't decode as an unreadable subtitle stream.
  const header = mkvHeader([{ type: 'video', codec: 'V_MPEG4/ISO/AVC' }, { type: 'audio', codec: 'A_AAC' }, { type: 'metadata', codec: 'S_TEXT/WEBVTT' }]);
  const { res, calls } = run({
    header,
    srcTracks: goodBoyTracks.slice(0, 2),
    inFormat: { duration: '120' },
    outTracks: [outTracksGB[0], outTracksGB[1]],
    outStreams: [
      { index: 0, codec_type: 'video', codec_name: 'h264', nb_read_packets: '2500' },
      { index: 1, codec_type: 'audio', codec_name: 'aac', nb_read_packets: '4300' },
    ],
  });
  assert.strictEqual(res.error, undefined, res.infoLog);
  assert.match(res.infoLog, /Track 2 in the file \(metadata, S_TEXT\/WEBVTT\) is not a video, audio or subtitle track; mkvmerge can't read it, so it is dropped\./);
  assert.doesNotMatch(res.infoLog, /undefined/);
  assert.deepStrictEqual(cmds(calls, 'mkvextract'), []);
  const merge = cmds(calls, 'mkvmerge').find((x) => x[1] === '-o');
  assert.deepStrictEqual(merge.slice(1), ['-o', '/w/out.mkv', '/m/a.mkv', '--track-order', '0:0,0:1']);
  assert.strictEqual(res.file._id, '/w/out.mkv');
});

test('plugin: a metadata track ffprobe lists without a type is dropped with a log line', () => {
  const header = mkvHeader([{ type: 'video', codec: 'V_MPEG4/ISO/AVC' }, { type: 'audio', codec: 'A_AAC' }, { type: 'subtitles', codec: 'S_TEXT/WEBVTT' }, { type: 'metadata', codec: 'S_TEXT/UTF8' }]);
  const { res } = run({ header, srcStreams: goodBoyStreams.concat([{ index: 3, codec_name: 'subrip' }]) });
  assert.strictEqual(res.error, undefined, res.infoLog);
  assert.match(res.infoLog, /Track 3 in the file \(metadata, S_TEXT\/UTF8\) is not a video, audio or subtitle track; mkvmerge can't read it, so it is dropped\./);
});

test('plugin: mkvmerge killed by a signal fails the job, keeps the input and cleans up', () => {
  const { res, calls, unlinked } = run({ merge: { status: null, signal: 'SIGKILL', stdout: '', stderr: '' } });
  assert.match(res.error, /mkvmerge failed \(signal SIGKILL\)/);
  assert.strictEqual(res.file._id, '/m/a.mkv');
  assert.ok(cmds(calls, 'mkvextract').length === 1, 'extracted');
  assert.ok(cmds(calls, 'tdarr-ffmpeg').length === 1, 'converted');
  assert.deepStrictEqual(unlinked.slice().sort(), [W('track2.srt'), W('track2.vtt'), '/w/out.mkv'].sort());
});

test('plugin: a WebVTT file mkvextract did not write fails the job instead of dropping the track', () => {
  const { res, calls } = run({ files: { [W('track2.vtt')]: null } });
  assert.match(res.error, /extracted track 2 is missing/);
  assert.strictEqual(res.file._id, '/m/a.mkv');
  assert.deepStrictEqual(cmds(calls, 'tdarr-ffmpeg'), []);
});

test('plugin: an extracted file without the WEBVTT signature fails the job', () => {
  const { res } = run({ files: { [W('track2.vtt')]: 'garbage\n00:00:01.000 --> 00:00:02.000\nHello\n' } });
  assert.match(res.error, /extracted track 2 is not a WebVTT file/);
});

test('plugin: a valid WebVTT file with no text cues is dropped (mkvmerge runs without it)', () => {
  const { res } = run({ files: { [W('track2.vtt')]: '\uFEFFWEBVTT\n' }, merge: { status: 2, stdout: 'stop here' } });
  assert.match(res.infoLog, /WebVTT track 2 has no cues with text \(0 cues\), dropping it/);
  assert.match(res.error, /mkvmerge failed/);
});

test('plugin: PCM is verified by payload bytes listed on both files', () => {
  const pcm = {
    inCounts: [{ index: 0, nb_read_packets: '2500' }, { index: 1, nb_read_packets: '2813' }],
    outStreams: [
      { index: 0, codec_type: 'video', codec_name: 'h264', nb_read_packets: '2500' },
      { index: 1, codec_type: 'audio', codec_name: 'pcm_s16le', nb_read_packets: '1500' },
      { index: 2, codec_type: 'subtitle', codec_name: 'subrip', nb_read_packets: '2' },
    ],
    listings: { '/m/a.mkv#1': '4000\n4000\n4000\n', '/w/out.mkv#1': '6000\n6000\n' },
  };
  const { res, calls } = run(pcm);
  assert.strictEqual(res.error, undefined, res.infoLog);
  assert.deepStrictEqual(listingCalls(calls), ['/m/a.mkv#1', '/w/out.mkv#1']);
  assert.match(res.infoLog, /: 0 \(video\) 2500, 1 \(audio\) 12000 bytes\./);
  const short = run(Object.assign({}, pcm, { listings: { '/m/a.mkv#1': '4000\n4000\n4000\n', '/w/out.mkv#1': '6000\n5999\n' } }));
  assert.match(short.res.error, /output stream 1 \(audio, pcm_s16le\) has 11999 bytes, source has 12000/);
});

test('plugin: an unknown (N/A) packet count is resolved by listing that stream, exactly', () => {
  const outStreams = (audioPackets) => [
    { index: 0, codec_type: 'video', codec_name: 'h264', nb_read_packets: '2500' },
    { index: 1, codec_type: 'audio', codec_name: 'aac', nb_read_packets: audioPackets },
    { index: 2, codec_type: 'subtitle', codec_name: 'subrip', nb_read_packets: '2' },
  ];
  // ffprobe leaves nb_read_packets out of JSON for a stream with no packets.
  const { res, calls } = run({
    inCounts: [{ index: 0, nb_read_packets: '2500' }, { index: 1 }],
    outStreams: outStreams(undefined),
    listings: { '/m/a.mkv#1': '', '/w/out.mkv#1': '' },
  });
  assert.strictEqual(res.error, undefined, res.infoLog);
  assert.deepStrictEqual(listingCalls(calls), ['/m/a.mkv#1', '/w/out.mkv#1']);
  assert.match(res.infoLog, /1 \(audio\) 0/);
  const lost = run({
    inCounts: [{ index: 0, nb_read_packets: '2500' }, { index: 1, nb_read_packets: 'N/A' }],
    outStreams: outStreams('2'),
    listings: { '/m/a.mkv#1': '9\n9\n9\n' },
  });
  assert.match(lost.res.error, /output stream 1 \(audio\) has 2 packets, source has 3/);
});

test('plugin: a kept stream short by one packet fails the job and removes the output', () => {
  const { res, unlinked } = run({
    outStreams: [
      { index: 0, codec_type: 'video', codec_name: 'h264', nb_read_packets: '2499' },
      { index: 1, codec_type: 'audio', codec_name: 'aac', nb_read_packets: '4300' },
      { index: 2, codec_type: 'subtitle', codec_name: 'subrip', nb_read_packets: '2' },
    ],
  });
  assert.match(res.error, /output stream 0 \(video\) has 2499 packets, source has 2500/);
  assert.strictEqual(res.file._id, '/m/a.mkv');
  assert.ok(unlinked.includes('/w/out.mkv'));
});

const durationProbes = (calls) => calls.filter((x) => /ffprobe$/.test(x[0]) && x.includes('format=duration'));

test('plugin: no duration in the probe data: measures it with ffprobe and uses the result', () => {
  const { res, calls } = run({ inFormat: {}, durationProbe: JSON.stringify({ format: { duration: '100.000000' } }) });
  assert.strictEqual(res.error, undefined, res.infoLog);
  const d = durationProbes(calls);
  assert.strictEqual(d.length, 1);
  assert.strictEqual(d[0][d[0].length - 1], '/m/a.mkv');
  const short = run({ inFormat: { duration: '0' }, durationProbe: JSON.stringify({ format: { duration: '50' } }) });
  assert.match(short.res.error, /output is longer than the input: 100.2s vs 50s/);
});

test('plugin: no duration in the probe data and ffprobe returns nothing: the job fails before muxing', () => {
  ['', '{}', JSON.stringify({ format: {} }), JSON.stringify({ format: { duration: 'N/A' } })].forEach((out) => {
    const { res, calls } = run({ inFormat: {}, durationProbe: out });
    assert.match(res.error, /could not measure the input duration/, JSON.stringify(out));
    assert.strictEqual(res.file._id, '/m/a.mkv');
    assert.deepStrictEqual(cmds(calls, 'mkvextract'), []);
  });
});

test('source files contain no raw invisible characters (BOM, NBSP, zero-width, bidi marks)', () => {
  const fs = require('fs');
  const invisible = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u00a0\u00ad\u200b-\u200f\u2028-\u202f\u2060-\u2064\ufeff]/;
  [path.join(__dirname, '..', 'plugins', 'Tdarr_Plugin_the1nk_convert_unsupported_subs.js'), __filename].forEach((f) => {
    fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      assert.ok(!invisible.test(line), path.basename(f) + ':' + (i + 1) + ' has a raw invisible character; use an escape');
    });
  });
});

test('details: id matches the filename', () => {
  assert.strictEqual(pluginModule.details().id, 'Tdarr_Plugin_the1nk_convert_unsupported_subs');
});

test('details: description names the exact checks', () => {
  const d = pluginModule.details().Description;
  assert.match(d, /exact packet count for every kept track except PCM, which is checked by exact payload bytes/);
  assert.match(d, /blank blocks mkvmerge drops/);
  assert.match(d, /Cues that are empty or only whitespace are left out/);
});
