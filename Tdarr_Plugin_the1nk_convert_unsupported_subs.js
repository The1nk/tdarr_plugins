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
