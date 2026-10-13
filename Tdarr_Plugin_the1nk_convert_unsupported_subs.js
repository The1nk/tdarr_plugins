/* eslint-disable */

// tdarrSkipTest
const details = () => {
  return {
    id: "Tdarr_Plugin_the1nk_convert_unsupported_subs",
    Stage: "Pre-processing",
    Name: "Convert unsupported subtitles",
    Type: "Video",
    Operation: "Transcode",
    Description: `Fixes MKV subtitle tracks that FFmpeg can't read (ffprobe reports no codec), which make every later "-map 0 -c copy" step fail with "Subtitle codec 0 is not supported". WebVTT tracks stored with the newer S_TEXT/WEBVTT codec ID are extracted with mkvextract, converted to SRT, and muxed back in their original position with their language, name and flags. Cues that are empty or only whitespace are left out, as are cues whose only content is markup SRT can't carry (such as <c> tags); cues holding only SRT formatting or a non-breaking space stay as invisible entries. A WebVTT track with no cue text at all is dropped, as is any other unreadable subtitle track and any Matroska track that is not video, audio or subtitles (such as DVD buttons), which mkvmerge cannot keep. The result is verified before it is used: track layout, codecs and the converted tracks' language, name and flags; the cue count of each converted track; an exact packet count for every kept track except PCM, which is checked by exact payload bytes, and kept SRT tracks, whose expected count leaves out the blank blocks mkvmerge drops; and the duration. If anything fails, the job fails with the reason and the library file is left untouched. Flow-only: runs mkvtoolnix itself and hands the new file to the next flow plugin.`,
    Version: "1.05",
    Tags: "pre-processing,mkvmerge,subtitle",
    Inputs: [],
  };
};

var path = require('path');

var WEBVTT_CODEC_ID = 'S_TEXT/WEBVTT';
var SRT_CODEC_ID = 'S_TEXT/UTF8';
// Tdarr's bundled ffprobe (not on PATH in the Tdarr container).
var BUNDLED_FFPROBE = '/app/Tdarr_Node/assets/app/ffmpeg/linux_x64/ffprobe';

// ffprobe leaves codec_name unset (or 'unknown'/'none') for codecs it can't demux.
var isUnreadable = function (stream) {
  return !stream.codec_name || stream.codec_name === 'unknown' || stream.codec_name === 'none';
};

// spawnSync result: launch error, killed by a signal (status null), or exit >= 2.
// mkvtoolnix: 0 = ok, 1 = ok with warnings, 2 = error.
var toolFailed = function (r) {
  return !!r.error || r.status === null || r.status > 1;
};

// The bundled ffprobe, then one next to an absolute ffmpegPath, then PATH.
// pathOps defaults to Node's path module (tests pass path.posix / path.win32).
var pickFfprobe = function (ffmpegPath, exists, pathOps) {
  var p = pathOps || path;
  var candidates = [BUNDLED_FFPROBE];
  if (ffmpegPath && p.isAbsolute(ffmpegPath)) {
    candidates.push(p.join(p.dirname(ffmpegPath), 'ffprobe' + p.extname(ffmpegPath)));
  }
  candidates.push('ffprobe');
  return candidates.find(function (c) { return !p.isAbsolute(c) || exists(c); });
};

var findUnreadableSubs = function (streams) {
  return (streams || [])
    .filter(function (s) { return s.codec_type === 'subtitle' && isUnreadable(s); })
    .map(function (s) { return s.index; });
};

// --- which track is which ---
// Measured in the Tdarr node (ffprobe 7.1.4, mkvmerge v99) with Matroska TrackType values other
// than video/audio/subtitle (buttons 0x12, logo 0x10, complex 0x03, control 0x20, metadata 0x21):
//  - FFmpeg cannot write such tracks into Matroska ("Only audio, video, and subtitles are supported").
//  - mkvmerge -J leaves them out, but its track IDs are positions in the Tracks element, so one in
//    the middle leaves a gap (0, 2, 3); a remux drops them.
//  - ffprobe skips them and renumbers its streams (0, 1, 2), except a track whose codec it knows:
//    a metadata track with S_TEXT/UTF8 is listed as subrip, with no codec_type or as "subtitle".
//  - ffprobe lists cover art as a "video" stream with disposition.attached_pic and other
//    attachments as "attachment", after the tracks; mkvmerge -J lists neither as tracks.
// So the Matroska Tracks header is read to know every track, ffprobe streams are aligned with it
// (mapTracks), and other track types are dropped (logged), since mkvmerge cannot keep them and
// they are not playable media.
var TRACK_TYPES = { 1: 'video', 2: 'audio', 3: 'complex', 16: 'logo', 17: 'subtitles', 18: 'buttons', 32: 'control', 33: 'metadata' };
var STREAM_TYPE = { video: 'video', audio: 'audio', subtitle: 'subtitles' };

// The TrackEntries of a Matroska file, in order: [{type, codec}]. read(pos, len) returns up to
// len bytes at pos. Only element headers are read until the Tracks element (clusters are skipped
// by size, never read).
var readTrackEntries = function (read) {
  var vint = function (buf, at, keepMarker) {
    if (at >= buf.length) throw new Error('Matroska header is truncated');
    var first = buf[at];
    var len = 1;
    while (len <= 8 && !(first & (0x100 >> len))) len += 1;
    if (len > 8 || at + len > buf.length) throw new Error('Matroska header is truncated or invalid');
    var value = keepMarker ? first : first & (0xff >> len);
    var unknown = !keepMarker && value === (0xff >> len);
    for (var i = 1; i < len; i += 1) {
      value = value * 256 + buf[at + i];
      if (buf[at + i] !== 0xff) unknown = false;
    }
    return { len: len, value: value, unknown: unknown };
  };
  // The element header at pos: {id (hex), data (offset of its data), size (null if unknown)}.
  var header = function (pos) {
    var buf = read(pos, 12);
    var id = vint(buf, 0, true);
    var size = vint(buf, id.len, false);
    return { id: buf.slice(0, id.len).toString('hex'), data: pos + id.len + size.len, size: size.unknown ? null : size.value };
  };
  var children = function (buf) {
    var out = [];
    var at = 0;
    while (at < buf.length) {
      var id = vint(buf, at, true);
      var size = vint(buf, at + id.len, false);
      var start = at + id.len + size.len;
      if (start + size.value > buf.length) throw new Error('Matroska Tracks element is truncated');
      out.push({ id: buf.slice(at, at + id.len).toString('hex'), data: buf.slice(start, start + size.value) });
      at = start + size.value;
    }
    return out;
  };
  var ebmlHead = header(0);
  if (ebmlHead.id !== '1a45dfa3' || ebmlHead.size === null) throw new Error('not a Matroska file (no EBML header)');
  var segment = header(ebmlHead.data + ebmlHead.size);
  if (segment.id !== '18538067') throw new Error('not a Matroska file (no Segment)');
  var pos = segment.data;
  for (var guard = 0; guard < 10000; guard += 1) {
    var el = header(pos);
    if (el.id === '1f43b675') throw new Error('no Tracks element before the first Cluster');
    if (el.size === null) throw new Error('element ' + el.id + ' of unknown size before the Tracks element');
    if (el.id === '1654ae6b') {
      var tracks = read(el.data, el.size);
      if (tracks.length < el.size) throw new Error('Matroska Tracks element is truncated');
      return children(tracks).filter(function (c) { return c.id === 'ae'; }).map(function (entry) {
        var fields = {};
        children(entry.data).forEach(function (c) { fields[c.id] = c.data; });
        var type = fields['83'] ? fields['83'].reduce(function (v, byte) { return v * 256 + byte; }, 0) : 0;
        return { type: TRACK_TYPES[type] || 'type ' + type, codec: fields['86'] ? fields['86'].toString() : '' };
      });
    }
    pos = el.data + el.size;
  }
  throw new Error('no Tracks element found');
};

// Pairs the file's tracks (entries, from readTrackEntries) with mkvmerge's tracks (ID = position
// in entries) and ffprobe's streams. ffprobe lists the streams in track order, one per video,
// audio and subtitle track, and may or may not list a track of another type (see above), so each
// video/audio/subtitle entry takes the next stream, which must have its type, and each other entry
// takes one stream or none. The media pairing must be the only one that accounts for every stream.
// Returns {ffIndex: mkvmerge ID -> ffprobe index, mkvId: ffprobe index -> mkvmerge ID,
// others: [{id, type, codec}] tracks mkvmerge can't read}, or {error}.
var mapTracks = function (entries, streams, mkvTracks) {
  var isMedia = function (e) { return e.type === 'video' || e.type === 'audio' || e.type === 'subtitles'; };
  var media = [];
  var others = [];
  entries.forEach(function (e, id) {
    if (isMedia(e)) media.push({ id: id, type: e.type });
    else others.push({ id: id, type: e.type, codec: e.codec });
  });
  if (mkvTracks.length !== media.length) {
    return { error: 'mkvmerge lists ' + mkvTracks.length + ' tracks, the file header has ' + media.length + ' video, audio and subtitle tracks' };
  }
  for (var i = 0; i < media.length; i += 1) {
    if (mkvTracks[i].id !== media[i].id || mkvTracks[i].type !== media[i].type) {
      return { error: 'mkvmerge track ' + mkvTracks[i].id + ' is ' + mkvTracks[i].type + ', header track ' + media[i].id + ' is ' + media[i].type };
    }
  }
  var list = (streams || []).filter(function (st) { return !(st.disposition && st.disposition.attached_pic) && st.codec_type !== 'attachment'; });
  // Every alignment of entries[e..] with list[k..], as media pairings "id:index,..." (at most 2 kept).
  var memo = {};
  var align = function (e, k) {
    var key = e + ',' + k;
    if (memo[key]) return memo[key];
    var out = [];
    var add = function (rest, pair) {
      rest.forEach(function (r) {
        var x = pair ? (r ? pair + ',' + r : pair) : r;
        if (out.length < 2 && out.indexOf(x) === -1) out.push(x);
      });
    };
    if (e === entries.length) {
      if (k === list.length) out.push('');
    } else if (isMedia(entries[e])) {
      if (k < list.length && STREAM_TYPE[list[k].codec_type] === entries[e].type) add(align(e + 1, k + 1), e + ':' + list[k].index);
    } else {
      add(align(e + 1, k), '');
      if (k < list.length) add(align(e + 1, k + 1), '');
    }
    memo[key] = out;
    return out;
  };
  var found = align(0, 0);
  var describe = '[' + list.map(function (st) { return st.index + ' ' + (st.codec_type || 'untyped'); }).join(', ') + ']';
  if (found.length === 0) {
    return { error: 'ffprobe streams ' + describe + ' cannot be matched to the file\'s tracks ['
      + entries.map(function (e) { return e.type; }).join(', ') + ']' };
  }
  if (found.length > 1) return { error: 'ffprobe streams ' + describe + ' match the file\'s tracks in more than one way' };
  var ffIndex = {};
  var mkvId = {};
  (found[0] ? found[0].split(',') : []).forEach(function (pair) {
    var ids = pair.split(':');
    ffIndex[ids[0]] = Number(ids[1]);
    mkvId[ids[1]] = Number(ids[0]);
  });
  return { ffIndex: ffIndex, mkvId: mkvId, others: others };
};

// Splits the unreadable subtitle tracks (mkvmerge IDs) into WebVTT tracks to convert and others to drop.
var planTracks = function (mkvTracks, unreadableIds) {
  var convert = [];
  var drop = [];
  unreadableIds.forEach(function (idx) {
    var track = mkvTracks.find(function (t) { return t.id === idx; });
    if (!track || track.type !== 'subtitles') {
      throw new Error('unreadable subtitle maps to mkvmerge track ' + idx + ', which is not a subtitle track');
    }
    if ((track.properties || {}).codec_id === WEBVTT_CODEC_ID) convert.push(track);
    else drop.push(track);
  });
  return { convert: convert, drop: drop };
};

var yesNo = function (v) { return v ? 'yes' : 'no'; };

// mkvmerge -J flag properties that are copied to a converted track when the source sets them.
var OPTIONAL_FLAGS = [
  ['enabled_track', '--track-enabled-flag'],
  ['flag_hearing_impaired', '--hearing-impaired-flag'],
  ['flag_visual_impaired', '--visual-impaired-flag'],
  ['flag_text_descriptions', '--text-descriptions-flag'],
  ['flag_original', '--original-flag'],
  ['flag_commentary', '--commentary-flag'],
];

var trackLanguage = function (t) {
  var p = t.properties || {};
  return p.language_ietf || p.language || 'und';
};

// Builds the mkvmerge command: the source minus every unreadable subtitle track, plus one
// SRT input per converted track, ordered so converted tracks sit where the originals were.
// layout lists the expected output tracks in order.
var buildMerge = function (input, output, mkvTracks, plan, srtPaths) {
  var removed = plan.convert.concat(plan.drop).map(function (t) { return t.id; })
    .sort(function (a, b) { return a - b; });
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
    args.push('--language', '0:' + trackLanguage(t));
    if (p.track_name) args.push('--track-name', '0:' + p.track_name);
    args.push('--default-track-flag', '0:' + yesNo(p.default_track));
    args.push('--forced-display-flag', '0:' + yesNo(p.forced_track));
    OPTIONAL_FLAGS.forEach(function (f) {
      if (p[f[0]] !== undefined) args.push(f[1], '0:' + yesNo(p[f[0]]));
    });
    args.push('--sub-charset', '0:UTF-8', srtPaths[t.id]);
    fileNo += 1;
    order.push(fileNo + ':0');
    layout.push({ track: t, converted: true });
  });
  args.push('--track-order', order.join(','));
  return { args: args, layout: layout };
};

// The converted track's language, name and flags must come out as the source had them.
// mkvmerge -J reports what buildMerge set: language (also as IETF), the name, default/forced
// (always set) and each optional flag the source defines (unset ones are absent).
var metadataProblem = function (src, out) {
  var want;
  var got;
  if (src.language_ietf) { want = src.language_ietf; got = out.language_ietf; }
  else if (src.language) { want = src.language; got = out.language; }
  else { want = 'und'; got = out.language; }
  if (got !== want) return 'language is ' + got + ', source has ' + want;
  if (src.track_name && out.track_name !== src.track_name) return 'track_name is ' + out.track_name + ', source has ' + src.track_name;
  var flags = ['default_track', 'forced_track'].concat(OPTIONAL_FLAGS
    .filter(function (f) { return src[f[0]] !== undefined; })
    .map(function (f) { return f[0]; }));
  for (var i = 0; i < flags.length; i += 1) {
    if (out[flags[i]] !== !!src[flags[i]]) return flags[i] + ' is ' + out[flags[i]] + ', source has ' + !!src[flags[i]];
  }
  return null;
};

// --- text subtitle counting ---
// Measured in the Tdarr node (FFmpeg 7.1.4, mkvmerge v99):
//  - FFmpeg's WebVTT -> SRT conversion leaves out empty cues, writes cues whose text is only
//    whitespace or unsupported tags (<c>, <v>, <ruby>...) as empty entries, keeps <i>/<b>/<u>,
//    turns &nbsp; into "\h" and &lt;/&gt;/&amp; into the bare characters.
//  - ffprobe packet counts don't help: it counts every WebVTT cue, but only SRT entries
//    with non-empty text (whitespace-only included).
//  - mkvmerge stores an S_TEXT/UTF8 entry only when its text has a character other than space,
//    tab, CR or LF (NBSP, form feed and vertical tab count as text). The same rule applies to an
//    .srt input and to a kept S_TEXT/UTF8 or S_TEXT/ASCII track of a Matroska input.
// So the WebVTT and SRT files are compared by cues with visible text, and the muxed track
// by the SRT entries mkvmerge keeps.
var TIMING = /^\s*\d[\d:.,]*\s*-->\s*\d[\d:.,]*/;
var mkvmergeKeeps = function (text) { return /[^ \t\r\n]/.test(text); };

// WebVTT and SRT both start a cue with its timing line and end it at the first empty line;
// anything else outside a cue (header, numbers, ids, NOTE/STYLE blocks) is skipped.
var parseCues = function (text) {
  var cues = [];
  var cue = null;
  String(text || '').split(/\r?\n/).forEach(function (line) {
    if (cue) {
      if (line === '') cue = null;
      else cue.lines.push(line);
      return;
    }
    if (TIMING.test(line)) {
      cue = { lines: [] };
      cues.push(cue);
    }
  });
  return cues.map(function (c) { return c.lines.join('\n'); });
};

// Visible text after the markup FFmpeg removes: every WebVTT tag, the SRT tags it writes,
// and hard spaces (&nbsp; in WebVTT, "\h" in FFmpeg's SRT).
var hasText = function (text, format) {
  var t = text.replace(/\\h/g, ' ');
  if (format === 'vtt') t = t.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ');
  else t = t.replace(/<\/?(?:i|b|u|s|font)(?:\s[^>]*)?>/gi, '');
  return /\S/.test(t);
};

// total: cues; content: cues with visible text; muxed: (SRT) entries mkvmerge stores.
var cueStats = function (text, format) {
  var stats = { total: 0, content: 0, muxed: 0 };
  parseCues(text).forEach(function (cueText) {
    stats.total += 1;
    if (hasText(cueText, format)) stats.content += 1;
    if (mkvmergeKeeps(cueText)) stats.muxed += 1;
  });
  return stats;
};

// Kept tracks whose blocks mkvmerge filters: blank S_TEXT/UTF8 and S_TEXT/ASCII blocks are
// dropped on a remux (FFmpeg-muxed SRT with a "   " cue: 4 packets in, 3 out). S_TEXT/ASS,
// S_TEXT/SSA and S_TEXT/USF keep every block, empty or blank text included.
var filtersBlankBlocks = function (codecId) {
  return codecId === 'S_TEXT/UTF8' || codecId === 'S_TEXT/ASCII';
};

// The block texts of an SRT file written by mkvextract: entries are numbered 1, 2, 3... and each
// starts with its number and timing line after an empty line, so a block's own blank lines stay
// inside it. ffprobe and mkvextract both skip zero-size blocks, so entries equal ffprobe's count.
var parseExtractedSrt = function (text) {
  var lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/);
  var starts = [];
  for (var i = 0; i < lines.length; i += 1) {
    if (lines[i] === String(starts.length + 1) && TIMING.test(lines[i + 1] || '') && (i === 0 || lines[i - 1] === '')) {
      starts.push(i);
    }
  }
  return starts.map(function (s, k) {
    return lines.slice(s + 2, k + 1 < starts.length ? starts[k + 1] : lines.length).join('\n');
  });
};

// entries: blocks mkvextract wrote; kept: blocks mkvmerge will keep on the remux.
var keptTextStats = function (text) {
  var entries = parseExtractedSrt(text);
  return { entries: entries.length, kept: entries.filter(mkvmergeKeeps).length };
};

// An extracted track must be a real WebVTT file: a missing or foreign file means mkvextract
// lost the track, which must not pass for "no cues with text". mkvextract writes BOM + WEBVTT
// even for a track with no cues. Returns the problem, or null. text is null when the file is missing.
var vttProblem = function (text) {
  if (text === null || text === undefined) return 'is missing';
  if (!/^\uFEFF?WEBVTT(?:[ \t]|\r?\n|$)/.test(text)) return 'is not a WebVTT file (no WEBVTT signature)';
  return null;
};

// A packet count, or NaN. Tdarr's ffprobe (7.1.4) prints nb_read_packets as N/A (and leaves it
// out of JSON) both when packets weren't counted and when a counted stream has none, so N/A is
// never read as a number: the plugin lists that stream's packets instead (sumPacketCsv).
var packetCount = function (v) {
  return (typeof v === 'number' || /^\d+$/.test(String(v))) ? Number(v) : NaN;
};

// Packets and payload bytes from "-show_entries packet=size -of csv=p=0" (one row per packet),
// read line by line so a large listing never becomes a large array.
var sumPacketCsv = function (text) {
  var s = String(text || '');
  var r = { packets: 0, bytes: 0 };
  var pos = 0;
  while (pos < s.length) {
    var end = s.indexOf('\n', pos);
    if (end === -1) end = s.length;
    var line = s.slice(pos, end);
    pos = end + 1;
    if (line.charAt(line.length - 1) === '\r') line = line.slice(0, -1);
    if (line === '') continue;
    r.packets += 1;
    r.bytes += /^\d+$/.test(line) ? Number(line) : NaN;
  }
  return r;
};

// How a kept track is proven complete through an mkvmerge v99 remux, measured in the Tdarr node
// on library files muxed by FFmpeg (Lavf57/59/61), mkvmerge (v4.5 to v71), HandBrake and others,
// plus synthetic files from FFmpeg and mkvmerge, comparing per-stream packets (and bytes):
//  - kept 1:1 (exact packet count): video; ac3, eac3 (incl. Atmos), dts (core and DTS-HD MA),
//    truehd, mp3, opus, aac (real files) and flac, alac, vorbis (synthetic); S_TEXT/ASS,
//    S_TEXT/SSA, S_TEXT/USF; S_HDMV/PGS (including the small "clear" display sets), S_VOBSUB
//    and S_DVBSUB.
//  - PCM from an FFmpeg-muxed source is re-packetized (pcm_s16le/s24le 2813 -> 1500 packets)
//    with identical bytes: compared by payload bytes (comparesBytes).
//  - S_TEXT/UTF8 and S_TEXT/ASCII lose their blank blocks: compared with the count mkvmerge
//    keeps, from the extracted text (filtersBlankBlocks, keptTextStats).
//  - Zero-size blocks (FFmpeg's "text" encoder writes them) are skipped by ffprobe on both sides.
var comparesBytes = function (codecName) {
  return /^pcm_/.test(String(codecName || ''));
};

var plural = function (n, one, many) { return n + ' ' + (n === 1 ? one : many); };

// The verification gate. Returns why the output can't be used, or null.
// v: layout (from buildMerge; output position i holds layout[i]), outTracks (mkvmerge -J of the
// output), outStreams (ffprobe streams of the output: index, codec_type, codec_name),
// srcCounts (source track id -> {packets, bytes}; source stream N is mkvmerge track N),
// outCounts (output position -> {packets, bytes}), expectedPackets (track id -> blocks mkvmerge
// keeps, for converted tracks and kept S_TEXT/UTF8|ASCII tracks), extractedEntries (kept
// S_TEXT/UTF8|ASCII track id -> blocks mkvextract wrote), inDuration / outDuration (container),
// lossy (a track was dropped or a converted cue left out).
var verifyOutput = function (v) {
  if (v.outTracks.length !== v.layout.length) {
    return 'output has ' + v.outTracks.length + ' tracks, expected ' + v.layout.length;
  }
  for (var i = 0; i < v.layout.length; i += 1) {
    var l = v.layout[i];
    var o = v.outTracks[i];
    var want = l.converted ? SRT_CODEC_ID : (l.track.properties || {}).codec_id;
    if (o.type !== l.track.type || (o.properties || {}).codec_id !== want) {
      return 'output track ' + i + ' is ' + o.type + '/' + (o.properties || {}).codec_id + ', expected ' + l.track.type + '/' + want;
    }
    if (l.converted) {
      var meta = metadataProblem(l.track.properties || {}, o.properties || {});
      if (meta) return 'output track ' + i + ' ' + meta;
    }
  }
  var streams = v.outStreams || [];
  var byIndex = {};
  streams.forEach(function (s) { byIndex[s.index] = s; });
  var subs = streams.filter(function (s) { return s.codec_type === 'subtitle'; });
  var wantSubs = v.layout.filter(function (x) { return x.track.type === 'subtitles'; }).length;
  if (subs.length !== wantSubs) {
    return 'ffprobe sees ' + subs.length + ' subtitle streams in the output, expected ' + wantSubs;
  }
  for (var j = 0; j < subs.length; j += 1) {
    var s = subs[j];
    if (isUnreadable(s)) return 'output subtitle stream ' + s.index + ' is still unreadable';
    var sl = v.layout[s.index];
    if (!sl || sl.track.type !== 'subtitles') return 'output stream ' + s.index + ' is a subtitle stream but not a subtitle track in the layout';
  }
  // Every output track is proven complete against its source (see comparesBytes for the rules).
  // This catches any truncation, however short, without relying on durations.
  for (var k = 0; k < v.layout.length; k += 1) {
    var kl = v.layout[k];
    var id = kl.track.id;
    var os = byIndex[k];
    var kind = os ? os.codec_type : kl.track.type;
    var oc = (v.outCounts || {})[k] || {};
    var expected = (v.expectedPackets || {})[id];
    if (kl.converted) {
      if (!(oc.packets >= 0)) return 'output stream ' + k + ' has no packet count';
      if (oc.packets !== expected) return 'output stream ' + k + ' has ' + oc.packets + ' cues, expected ' + expected;
      continue;
    }
    var sc = (v.srcCounts || {})[id] || {};
    if (os && comparesBytes(os.codec_name)) {
      var label = 'output stream ' + k + ' (' + kind + ', ' + os.codec_name + ')';
      if (!(oc.bytes >= 0)) return label + ' has no byte count';
      if (!(sc.bytes >= 0)) return 'source stream ' + id + ' has no byte count';
      if (oc.bytes !== sc.bytes) return label + ' has ' + oc.bytes + ' bytes, source has ' + sc.bytes;
      continue;
    }
    if (!(oc.packets >= 0)) return 'output stream ' + k + ' (' + kind + ') has no packet count';
    if (!(sc.packets >= 0)) return 'source stream ' + id + ' has no packet count';
    if (filtersBlankBlocks((kl.track.properties || {}).codec_id)) {
      var entries = (v.extractedEntries || {})[id];
      if (!(entries >= 0)) return 'extracted track ' + id + ' has no entry count';
      if (entries !== sc.packets) return 'extracted track ' + id + ' has ' + entries + ' entries, source stream has ' + sc.packets + ' packets';
      if (oc.packets !== expected) {
        return 'output stream ' + k + ' (' + kind + ') has ' + oc.packets + ' packets, expected ' + expected
          + ' (source ' + sc.packets + ', minus the blank blocks mkvmerge drops)';
      }
      continue;
    }
    if (oc.packets !== sc.packets) return 'output stream ' + k + ' (' + kind + ') has ' + oc.packets + ' packets, source has ' + sc.packets;
  }
  if (!(v.inDuration > 0)) return 'could not measure the input duration';
  if (v.outDuration > v.inDuration + 1.0) {
    return 'output is longer than the input: ' + v.outDuration + 's vs ' + v.inDuration + 's';
  }
  // When a track was dropped or a cue left out, the output may be legitimately shorter
  // (what was left out may have run longest); the counts above guard the kept tracks.
  if (!v.lossy && Math.abs(v.outDuration - v.inDuration) > 1.0) {
    return 'duration mismatch: ' + v.outDuration + 's vs ' + v.inDuration + 's';
  }
  return null;
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const plugin = (file, librarySettings, inputs, otherArguments) => {

  const lib = require('../methods/lib')();
  // eslint-disable-next-line @typescript-eslint/no-unused-vars,no-param-reassign
  inputs = lib.loadDefaultValues(inputs, details);
  var fs = require('fs');
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
  var exitOf = function (r) { return r.signal ? 'signal ' + r.signal : 'exit ' + r.status; };
  var why = function (r) { return r.error ? r.error.message : (r.stderr || r.stdout || exitOf(r)); };
  var readText = function (p) { return fs.existsSync(p) ? String(fs.readFileSync(p, 'utf8')) : null; };

  try {
    if (file.container !== 'mkv') {
      response.infoLog += 'File is not MKV (mkvtoolnix only), skipping.\r\n';
      return response;
    }

    var srcStreams = (file.ffProbeData && file.ffProbeData.streams) || [];
    var unreadable = findUnreadableSubs(srcStreams);
    if (unreadable.length === 0) {
      response.infoLog += 'All subtitle tracks are readable by FFmpeg, skipping.\r\n';
      return response;
    }

    if (!otherArguments || !otherArguments.cacheFilePath) {
      response.infoLog += 'No cacheFilePath provided (not running in a flow?), skipping.\r\n';
      return response;
    }
    if (path.resolve(otherArguments.cacheFilePath) === path.resolve(file._id)) {
      response.infoLog += 'Output path equals input path, skipping.\r\n';
      return response;
    }
    outPath = otherArguments.cacheFilePath;
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
    var ffprobe = pickFfprobe(otherArguments.ffmpegPath, fs.existsSync);

    var identify = function (p) {
      var r = run(mkvmerge, ['-J', p]);
      if (toolFailed(r)) throw new Error('mkvmerge identify failed on ' + p + ' (' + exitOf(r) + '): ' + why(r));
      return JSON.parse(r.stdout).tracks || [];
    };
    var probe = function (args, p) {
      var r = run(ffprobe, ['-v', 'error'].concat(args, ['-of', 'json', '--', p]));
      if (r.error || r.status !== 0) throw new Error('ffprobe failed on ' + p + ' (' + exitOf(r) + '): ' + why(r));
      try {
        return JSON.parse(r.stdout);
      } catch (e) {
        throw new Error('ffprobe returned no JSON for ' + p);
      }
    };
    // One stream's packets listed (exact, including none): for PCM bytes, and for any count
    // ffprobe printed as N/A (see packetCount). Only these streams are listed.
    var listPackets = function (p, idx) {
      var r = spawnSync(ffprobe, ['-v', 'error', '-select_streams', String(idx),
        '-show_entries', 'packet=size', '-of', 'csv=p=0', '--', p], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
      if (r.error || r.status !== 0) throw new Error('ffprobe packet listing failed on ' + p + ' stream ' + idx + ' (' + exitOf(r) + '): ' + why(r));
      return sumPacketCsv(r.stdout);
    };

    // The input duration, measured if Tdarr's probe data lacks it (the duration check needs it).
    var inFormat = (file.ffProbeData && file.ffProbeData.format) || {};
    if (!(Number(inFormat.duration) > 0)) {
      try {
        inFormat = probe(['-show_entries', 'format=duration'], file._id).format || {};
      } catch (e) {
        response.infoLog += e.message + '\r\n';
        inFormat = {};
      }
    }
    var inDuration = Number(inFormat.duration) || 0;
    if (!(inDuration > 0)) throw new Error('could not measure the input duration');

    var mkvTracks = identify(file._id);
    // Every track in the file, from its Tracks header (a few small reads).
    var fd = fs.openSync(file._id, 'r');
    var entries;
    try {
      entries = readTrackEntries(function (pos, len) {
        var buf = Buffer.alloc(len);
        return buf.slice(0, fs.readSync(fd, buf, 0, len, pos));
      });
    } finally {
      fs.closeSync(fd);
    }
    var map = mapTracks(entries, srcStreams, mkvTracks);
    if (map.error) throw new Error('ffprobe and mkvmerge disagree on the track layout: ' + map.error);
    var plan = planTracks(mkvTracks, unreadable.map(function (idx) { return map.mkvId[idx]; }));

    map.others.forEach(function (o) {
      response.infoLog += 'Track ' + o.id + ' in the file (' + o.type + ', ' + o.codec + ') is not a video, audio or subtitle track; mkvmerge can\'t read it, so it is dropped.\r\n';
    });
    plan.drop.forEach(function (t) {
      response.infoLog += 'Subtitle track ' + t.id + ' (' + (t.properties || {}).codec_id + ') is unreadable and not convertible, dropping it.\r\n';
    });

    // One mkvextract pass for every WebVTT track to convert and every kept SRT track whose
    // blank blocks mkvmerge will drop (to know how many it keeps).
    var keptText = mkvTracks.filter(function (t) {
      return plan.convert.indexOf(t) === -1 && plan.drop.indexOf(t) === -1 && filtersBlankBlocks((t.properties || {}).codec_id);
    });
    var vttPaths = {};
    var keptPaths = {};
    var extractArgs = [file._id, 'tracks'];
    plan.convert.forEach(function (t) {
      vttPaths[t.id] = path.join(workDir, 'track' + t.id + '.vtt');
      extractArgs.push(t.id + ':' + vttPaths[t.id]);
    });
    keptText.forEach(function (t) {
      keptPaths[t.id] = path.join(workDir, 'kept' + t.id + '.srt');
      extractArgs.push(t.id + ':' + keptPaths[t.id]);
    });
    if (extractArgs.length > 2) {
      temps = temps.concat(extractArgs.slice(2).map(function (a) { return a.slice(a.indexOf(':') + 1); }));
      var ex = run(mkvextract, extractArgs);
      if (toolFailed(ex)) throw new Error('mkvextract failed (' + exitOf(ex) + '): ' + why(ex));
    }

    // Convert each WebVTT track to SRT.
    var srtPaths = {};
    var expectedPackets = {};
    var lossy = plan.drop.length > 0 || map.others.length > 0;
    var converted = [];
    plan.convert.forEach(function (t) {
      var vtt = vttPaths[t.id];
      var vttText = readText(vtt);
      var bad = vttProblem(vttText);
      if (bad) throw new Error('extracted track ' + t.id + ' ' + bad);
      var vttStats = cueStats(vttText, 'vtt');
      if (vttStats.content === 0) {
        // Nothing to show: drop it like any other unconvertible track.
        plan.drop.push(t);
        lossy = true;
        response.infoLog += 'WebVTT track ' + t.id + ' has no cues with text (' + plural(vttStats.total, 'cue', 'cues') + '), dropping it.\r\n';
        return;
      }
      var srt = path.join(workDir, 'track' + t.id + '.srt');
      temps.push(srt);
      var conv = run(ffmpeg, ['-hide_banner', '-v', 'error', '-y', '-i', vtt, '-c:s', 'srt', srt]);
      if (conv.error || conv.status !== 0) throw new Error('ffmpeg could not convert track ' + t.id + ' to SRT (' + exitOf(conv) + '): ' + why(conv));
      var srtStats = cueStats(readText(srt), 'srt');
      if (srtStats.content !== vttStats.content) {
        throw new Error('cue count mismatch on track ' + t.id + ': WebVTT has ' + vttStats.content + ' cues with text, SRT ' + srtStats.content);
      }
      srtPaths[t.id] = srt;
      expectedPackets[t.id] = srtStats.muxed;
      var leftOut = vttStats.total - srtStats.muxed;
      var invisible = srtStats.muxed - srtStats.content;
      if (leftOut !== 0) lossy = true;
      converted.push(t);
      response.infoLog += 'Converted WebVTT track ' + t.id + ' (' + trackLanguage(t) + ') to SRT: ' + plural(srtStats.content, 'cue', 'cues') + ' with text'
        + (leftOut ? ', ' + leftOut + ' left out (empty or blank)' : '')
        + (invisible ? ', ' + invisible + ' kept as ' + (invisible === 1 ? 'an invisible entry' : 'invisible entries') : '') + '.\r\n';
    });
    plan.convert = converted;

    // Blocks each kept SRT track has, and how many of them mkvmerge keeps.
    var extractedEntries = {};
    keptText.forEach(function (t) {
      var text = readText(keptPaths[t.id]);
      if (text === null) throw new Error('extracted track ' + t.id + ' is missing');
      var st = keptTextStats(text);
      extractedEntries[t.id] = st.entries;
      expectedPackets[t.id] = st.kept;
    });

    var built = buildMerge(file._id, outPath, mkvTracks, plan, srtPaths);
    var merge = run(mkvmerge, built.args);
    if (toolFailed(merge) || !fs.existsSync(outPath)) throw new Error('mkvmerge failed (' + exitOf(merge) + '): ' + why(merge));
    if (merge.status === 1) response.infoLog += 'mkvmerge warnings: ' + merge.stdout + '\r\n';

    // --- verification gate ---
    var outTracks = identify(outPath);
    var byIndex = function (list) {
      var m = {};
      (list || []).forEach(function (s) { m[s.index] = s; });
      return m;
    };
    // Packets per stream, source and output (the -count_packets output is one small JSON row per stream).
    var inByIndex = byIndex(probe(['-count_packets', '-show_entries', 'stream=index,nb_read_packets'], file._id).streams);
    var outProbe = probe(['-count_packets',
      '-show_entries', 'stream=index,codec_type,codec_name,nb_read_packets:format=duration'], outPath);
    var outStreams = outProbe.streams || [];
    var outByIndex = byIndex(outStreams);
    // {packets} from ffprobe's count, or {packets, bytes} from a listing when bytes are needed
    // or the count is N/A.
    var countOf = function (p, idx, stream, needBytes) {
      var n = packetCount(stream && stream.nb_read_packets);
      if (needBytes || !(n >= 0)) return listPackets(p, idx);
      return { packets: n };
    };
    var srcCounts = {};
    var outCounts = {};
    built.layout.forEach(function (l, i) {
      var os = outByIndex[i];
      if (!os) return; // verifyOutput reports the missing stream
      var bytes = !l.converted && comparesBytes(os.codec_name);
      outCounts[i] = countOf(outPath, i, os, bytes);
      if (!l.converted) srcCounts[l.track.id] = countOf(file._id, map.ffIndex[l.track.id], inByIndex[map.ffIndex[l.track.id]], bytes);
    });
    var problem = verifyOutput({
      layout: built.layout,
      outTracks: outTracks,
      outStreams: outStreams,
      srcCounts: srcCounts,
      outCounts: outCounts,
      expectedPackets: expectedPackets,
      extractedEntries: extractedEntries,
      inDuration: inDuration,
      outDuration: Number((outProbe.format || {}).duration) || 0,
      lossy: lossy,
    });
    if (problem) throw new Error(problem);

    var kept = [];
    built.layout.forEach(function (l, i) {
      if (l.converted) return;
      var s = outByIndex[i];
      var c = outCounts[i];
      var src = srcCounts[l.track.id];
      var what = String(c.packets);
      if (comparesBytes(s.codec_name)) what = c.bytes + ' bytes';
      else if (src.packets !== c.packets) {
        what = c.packets + ' of ' + src.packets + ' (' + plural(src.packets - c.packets, 'blank block', 'blank blocks') + ' dropped by mkvmerge)';
      }
      kept.push(i + ' (' + s.codec_type + ') ' + what);
    });
    response.infoLog += 'Verified: ' + outTracks.length + ' tracks, every subtitle track readable, cue counts and metadata match; '
      + 'kept streams match the source exactly (packets, or bytes for PCM): ' + (kept.join(', ') || 'none') + '.\r\n';
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
module.exports._test = {
  findUnreadableSubs: findUnreadableSubs,
  readTrackEntries: readTrackEntries,
  mapTracks: mapTracks,
  planTracks: planTracks,
  buildMerge: buildMerge,
  toolFailed: toolFailed,
  cueStats: cueStats,
  filtersBlankBlocks: filtersBlankBlocks,
  parseExtractedSrt: parseExtractedSrt,
  keptTextStats: keptTextStats,
  vttProblem: vttProblem,
  packetCount: packetCount,
  sumPacketCsv: sumPacketCsv,
  comparesBytes: comparesBytes,
  verifyOutput: verifyOutput,
  pickFfprobe: pickFfprobe,
};
