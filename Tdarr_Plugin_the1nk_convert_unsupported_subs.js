/* eslint-disable */

// tdarrSkipTest
const details = () => {
  return {
    id: "Tdarr_Plugin_the1nk_convert_unsupported_subs",
    Stage: "Pre-processing",
    Name: "Convert unsupported subtitles",
    Type: "Video",
    Operation: "Transcode",
    Description: `Fixes MKV subtitle tracks that FFmpeg can't read (ffprobe reports no codec), which make every later "-map 0 -c copy" step fail with "Subtitle codec 0 is not supported". WebVTT tracks stored with the newer S_TEXT/WEBVTT codec ID are extracted with mkvextract, converted to SRT, and muxed back in their original position with their language, name and flags. Cues with no visible text are left out; a WebVTT track with no cue text at all is dropped, as is any other unreadable subtitle track. The result is verified before it is used (track layout and codecs, cue counts of converted tracks, an exact packet count for every kept track, duration); if anything fails the job fails with the reason and the library file is left untouched. Flow-only: runs mkvtoolnix itself and hands the new file to the next flow plugin.`,
    Version: "1.02",
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
  return !!r.error || r.status === null || r.status === undefined || r.status > 1;
};

// The bundled ffprobe, then one next to an absolute ffmpegPath, then PATH.
var pickFfprobe = function (ffmpegPath, exists) {
  var candidates = [BUNDLED_FFPROBE];
  if (ffmpegPath && path.isAbsolute(ffmpegPath)) {
    candidates.push(path.join(path.dirname(ffmpegPath), 'ffprobe' + path.extname(ffmpegPath)));
  }
  candidates.push('ffprobe');
  return candidates.find(function (c) { return !path.isAbsolute(c) || exists(c); });
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

// --- cue counting ---
// Measured in the Tdarr node (FFmpeg 7.1.4, mkvmerge v99):
//  - FFmpeg's WebVTT -> SRT conversion leaves out empty cues, writes cues whose text is only
//    whitespace or unsupported tags (<c>, <v>, <ruby>...) as empty entries, keeps <i>/<b>/<u>,
//    turns &nbsp; into "\h" and &lt;/&gt;/&amp; into the bare characters.
//  - ffprobe packet counts don't help: it counts every WebVTT cue, but only SRT entries
//    with non-empty text (whitespace-only included).
//  - mkvmerge stores an SRT entry only when its text has something besides ASCII whitespace,
//    and ffprobe's packet count of the muxed track equals that.
// So the WebVTT and SRT files are compared by cues with visible text, and the muxed track
// by the SRT entries mkvmerge keeps.
var TIMING = /^\s*\d[\d:.,]*\s*-->\s*\d[\d:.,]*/;

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
    if (/[^ \t\r\n\f\v]/.test(cueText)) stats.muxed += 1;
  });
  return stats;
};

// An extracted track must be a real WebVTT file: a missing or foreign file means mkvextract
// lost the track, which must not pass for "no cues with text". mkvextract writes BOM + WEBVTT
// even for a track with no cues. Returns the problem, or null. text is null when the file is missing.
var vttProblem = function (text) {
  if (text === null || text === undefined) return 'is missing';
  if (!/^\uFEFF?WEBVTT(?:[ \t]|\r?\n|$)/.test(text)) return 'is not a WebVTT file (no WEBVTT signature)';
  return null;
};

// A packet count from ffprobe -count_packets ('N/A' means none were read), or NaN.
var packetCount = function (v) {
  if (v === 'N/A') return 0;
  return (typeof v === 'number' || /^\d+$/.test(String(v))) ? Number(v) : NaN;
};

// The verification gate. Returns why the output can't be used, or null.
// v: layout (from buildMerge; output position i holds layout[i]), outTracks (mkvmerge -J of the
// output), outStreams (every ffprobe stream of the output: index, codec_type, codec_name,
// nb_read_packets), inPackets (source stream index -> ffprobe nb_read_packets; source stream N
// is mkvmerge track N), expectedPackets (converted track id -> SRT entries mkvmerge keeps),
// inDuration / outDuration (container), lossy (a track was dropped or a converted cue left out).
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
  }
  var streams = v.outStreams || [];
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
    if (sl.converted && packetCount(s.nb_read_packets) !== v.expectedPackets[sl.track.id]) {
      return 'output stream ' + s.index + ' has ' + packetCount(s.nb_read_packets) + ' cues, expected ' + v.expectedPackets[sl.track.id];
    }
  }
  // A remux keeps every packet of every track it keeps, so each kept (not converted) track
  // must have exactly as many packets as its source stream. This catches any truncation,
  // however short, without relying on durations.
  for (var k = 0; k < v.layout.length; k += 1) {
    var kl = v.layout[k];
    if (kl.converted) continue;
    var os = streams.find(function (x) { return x.index === k; });
    var kind = os ? os.codec_type : kl.track.type;
    var got = packetCount(os && os.nb_read_packets);
    if (!(got >= 0)) return 'output stream ' + k + ' (' + kind + ') has no packet count';
    var src = packetCount((v.inPackets || {})[kl.track.id]);
    if (!(src >= 0)) return 'source stream ' + kl.track.id + ' has no packet count';
    if (got !== src) return 'output stream ' + k + ' (' + kind + ') has ' + got + ' packets, source has ' + src;
  }
  if (!(v.inDuration > 0)) return 'could not measure the input duration';
  if (v.outDuration > v.inDuration + 1.0) {
    return 'output is longer than the input: ' + v.outDuration + 's vs ' + v.inDuration + 's';
  }
  // When a track was dropped or a cue left out, the output may be legitimately shorter
  // (what was left out may have run longest); the packet counts above guard the kept tracks.
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

    var unreadable = findUnreadableSubs(file.ffProbeData && file.ffProbeData.streams);
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
      return JSON.parse(r.stdout);
    };

    // The input duration, measured if Tdarr's probe data lacks it (the duration check needs it).
    var inFormat = (file.ffProbeData && file.ffProbeData.format) || {};
    if (!(Number(inFormat.duration) > 0)) inFormat = probe(['-show_entries', 'format=duration'], file._id).format || {};
    var inDuration = Number(inFormat.duration) || 0;
    if (!(inDuration > 0)) throw new Error('could not measure the input duration');

    var mkvTracks = identify(file._id);
    var plan = planTracks(mkvTracks, unreadable);
    if (plan.error) throw new Error(plan.error);

    plan.drop.forEach(function (t) {
      response.infoLog += 'Subtitle track ' + t.id + ' (' + (t.properties || {}).codec_id + ') is unreadable and not convertible, dropping it.\r\n';
    });

    // Extract every WebVTT track in one pass, then convert each to SRT.
    var srtPaths = {};
    var expectedPackets = {};
    var lossy = plan.drop.length > 0;
    if (plan.convert.length > 0) {
      var extractArgs = [file._id, 'tracks'];
      plan.convert.forEach(function (t) {
        var vtt = path.join(workDir, 'track' + t.id + '.vtt');
        temps.push(vtt);
        extractArgs.push(t.id + ':' + vtt);
      });
      var ex = run(mkvextract, extractArgs);
      if (toolFailed(ex)) throw new Error('mkvextract failed (' + exitOf(ex) + '): ' + why(ex));

      var converted = [];
      plan.convert.forEach(function (t) {
        var vtt = path.join(workDir, 'track' + t.id + '.vtt');
        var vttText = readText(vtt);
        var bad = vttProblem(vttText);
        if (bad) throw new Error('extracted track ' + t.id + ' ' + bad);
        var vttStats = cueStats(vttText, 'vtt');
        if (vttStats.content === 0) {
          // Nothing to show: drop it like any other unconvertible track.
          plan.drop.push(t);
          lossy = true;
          response.infoLog += 'WebVTT track ' + t.id + ' has no cues with text (' + vttStats.total + ' cues), dropping it.\r\n';
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
        if (srtStats.muxed !== vttStats.total) lossy = true;
        converted.push(t);
        response.infoLog += 'Converted WebVTT track ' + t.id + ' (' + trackLanguage(t) + ') to SRT, ' + srtStats.content + ' cues with text'
          + (vttStats.total !== srtStats.content ? ' (' + (vttStats.total - srtStats.content) + ' empty cues left out)' : '') + '.\r\n';
      });
      plan.convert = converted;
    }

    var built = buildMerge(file._id, outPath, mkvTracks, plan, srtPaths);
    var merge = run(mkvmerge, built.args);
    if (toolFailed(merge) || !fs.existsSync(outPath)) throw new Error('mkvmerge failed (' + exitOf(merge) + '): ' + why(merge));
    if (merge.status === 1) response.infoLog += 'mkvmerge warnings: ' + merge.stdout + '\r\n';

    // --- verification gate ---
    var outTracks = identify(outPath);
    // Packets per stream, source and output (the -count_packets output is one small JSON row per stream).
    var inPackets = {};
    (probe(['-count_packets', '-show_entries', 'stream=index,nb_read_packets'], file._id).streams || [])
      .forEach(function (s) { inPackets[s.index] = s.nb_read_packets; });
    var outProbe = probe(['-count_packets',
      '-show_entries', 'stream=index,codec_type,codec_name,nb_read_packets:format=duration'], outPath);
    var outStreams = outProbe.streams || [];
    var problem = verifyOutput({
      layout: built.layout,
      outTracks: outTracks,
      outStreams: outStreams,
      inPackets: inPackets,
      expectedPackets: expectedPackets,
      inDuration: inDuration,
      outDuration: Number((outProbe.format || {}).duration) || 0,
      lossy: lossy,
    });
    if (problem) throw new Error(problem);

    var kept = [];
    built.layout.forEach(function (l, i) {
      if (l.converted) return;
      var s = outStreams.find(function (x) { return x.index === i; }) || {};
      kept.push(i + ' (' + s.codec_type + ') ' + packetCount(s.nb_read_packets));
    });
    response.infoLog += 'Verified: ' + outTracks.length + ' tracks, every subtitle track readable, cue counts match; '
      + 'packets per kept stream match the source: ' + (kept.join(', ') || 'none') + '.\r\n';
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
  planTracks: planTracks,
  buildMerge: buildMerge,
  toolFailed: toolFailed,
  cueStats: cueStats,
  vttProblem: vttProblem,
  verifyOutput: verifyOutput,
  pickFfprobe: pickFfprobe,
};
