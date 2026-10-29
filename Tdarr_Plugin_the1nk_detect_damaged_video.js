/* eslint-disable */

// tdarrSkipTest
const details = () => {
  return {
    id: "Tdarr_Plugin_the1nk_detect_damaged_video",
    Stage: "Pre-processing",
    Name: "Detect damaged video",
    Type: "Video",
    Operation: "Transcode",
    Description: `Fails the job when the video stream is missing frames, so a damaged download never replaces the library file. Only files whose video frame rate is not a standard one are checked (frames lost from a 24 fps file give odd rates like 7016/301). Their video timestamps are listed with ffprobe (this reads the whole file, without decoding it), and an interval of at least 1.5x the normal frame interval counts as a gap. If there are gaps, the video is decoded once: frames cut out of the stream leave decoder errors ("Missing reference picture"), while a file made variable-frame-rate on purpose (a still scene stored as one long frame) decodes cleanly and is let through. Gaps plus decoder errors fail the job with the number of gaps, the largest one and where it is, the time missing, the error count and the first decoder error. The file is only read, never changed. The timestamp listing reads (demuxes) the whole file for every file whose frame rate is not standard. The decode runs only when there are gaps; it reads and decodes the whole file using all cores, and can take several minutes on long or 4K files.`,
    Version: "1.00",
    Tags: "pre-processing,ffprobe,video only",
    Inputs: [],
  };
};

var path = require('path');

// Rates a display can actually lock to (the same list as Repair Frame Rate).
var STD = ['24000/1001', '24/1', '25/1', '30000/1001', '30/1', '50/1', '60000/1001', '60/1', '24000/1000'];
// Tdarr's bundled ffprobe (not on PATH in the Tdarr container).
var BUNDLED_FFPROBE = '/app/Tdarr_Node/assets/app/ffmpeg/linux_x64/ffprobe';

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

// First video stream that isn't cover art.
var pickVideo = function (streams) {
  return (streams || []).find(function (s) {
    return s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic);
  });
};

// --- Gaps in the frame timing. Keep identical to the copy in Tdarr_Plugin_the1nk_repair_framerate.js. ---

// ffprobe "packet=pts_time" CSV -> timestamps in seconds, ascending (B-frames arrive out of display
// order). Packets without a timestamp (N/A) are dropped.
var parseTimes = function (csv) {
  return String(csv || '').split(/\r?\n/)
    .map(function (line) { return line.split(',')[0].trim(); })
    .filter(function (v) { return v !== ''; })
    .map(Number)
    .filter(Number.isFinite)
    .sort(function (a, b) { return a - b; });
};

// normal: the most common interval between frames, to the millisecond (ties go to the shorter interval:
// the keys are integers, so they are visited in ascending order and only a strictly higher count replaces the pick).
// A gap is an interval of at least 1.5x normal: millisecond timebases make 24 fps alternate 41/42 ms,
// so one lost frame shows as 83 ms, only 1.98x the 42 ms mode.
// Each gap: at (seconds from the first frame, like a player clock) and length (seconds).
// missing: seconds of video lost (each gap minus one normal interval).
var findGaps = function (times) {
  var counts = {};
  var deltas = [];
  for (var i = 1; i < times.length; i++) {
    var ms = Math.round((times[i] - times[i - 1]) * 1000);
    deltas.push(ms);
    if (ms > 0) counts[ms] = (counts[ms] || 0) + 1;
  }
  var normal = 0;
  var best = 0;
  Object.keys(counts).forEach(function (k) {
    var ms = Number(k);
    if (counts[k] > best) { best = counts[k]; normal = ms; }
  });
  var gaps = [];
  var missingMs = 0;
  if (normal > 0) {
    deltas.forEach(function (ms, j) {
      if (ms >= normal * 1.5) {
        gaps.push({ at: times[j] - times[0], length: ms / 1000 });
        missingMs += ms - normal;
      }
    });
  }
  return { normal: normal / 1000, gaps: gaps, missing: missingMs / 1000 };
};

// 75 -> "01:15", 3725 -> "1:02:05"
var clock = function (seconds) {
  var t = Math.floor(seconds);
  var h = Math.floor(t / 3600);
  var m = Math.floor((t % 3600) / 60);
  var s = t % 60;
  var two = function (n) { return (n < 10 ? '0' : '') + n; };
  return (h ? h + ':' : '') + two(m) + ':' + two(s);
};

var plural = function (n, one, many) { return n + ' ' + (n === 1 ? one : many); };

// "7 timing gaps (largest 4.17s at 04:00), about 8.7s of video missing"
var describeGaps = function (g) {
  var largest = g.gaps.reduce(function (a, b) { return b.length > a.length ? b : a; });
  return plural(g.gaps.length, 'timing gap', 'timing gaps') + ' (largest ' + largest.length.toFixed(2) + 's at '
    + clock(largest.at) + '), about ' + g.missing.toFixed(g.missing < 0.995 ? 2 : 1) + 's of video missing';
};

// --- end of the shared gap code ---

var damagedMessage = function (g, decodeErrors) {
  return 'Damaged video: ' + describeGaps(g) + ', and ' + plural(decodeErrors, 'decode error', 'decode errors')
    + '. The source is missing frames; replace it with a clean copy.';
};

// ffprobe -v error prints one line per decoder error.
var countLines = function (text) {
  return String(text || '').split(/\r?\n/).filter(function (line) { return line.trim() !== ''; }).length;
};

// The first n non-empty stderr lines, "[h264 @ 0x55d1ffc77a00] msg" rewritten to "h264: msg", each cut to 200 characters.
var firstErrors = function (stderr, n) {
  return String(stderr || '').split(/\r?\n/)
    .map(function (line) { return line.trim().replace(/^\[([^\]@]*?)\s*@\s*0x[0-9a-fA-F]+\]\s*/, '$1: ').slice(0, 200); })
    .filter(function (line) { return line !== ''; })
    .slice(0, n);
};

// Last 20 non-empty lines and at most 2000 characters of tool output, so an error or log stays readable.
var tail = function (text) {
  var lines = String(text || '').split(/\r?\n/).filter(function (line) { return line.trim() !== ''; });
  var dropped = Math.max(0, lines.length - 20);
  var out = lines.slice(dropped).join('\n');
  if (out.length > 2000) out = out.slice(-2000);
  return (dropped ? '(' + dropped + ' earlier lines left out) ' : '') + out;
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars
var plugin = function (file, librarySettings, inputs, otherArguments) {
  var lib = require('../methods/lib')();
  // eslint-disable-next-line @typescript-eslint/no-unused-vars,no-param-reassign
  inputs = lib.loadDefaultValues(inputs, details);
  var fs = require('fs');
  var spawnSync = require('child_process').spawnSync;

  var response = {
    file: file,
    removeFromDB: false,
    updateDB: false,
    infoLog: '',
    processFile: false,
    preset: '',
    container: '.' + file.container,
    handBrakeMode: false,
    FFmpegMode: false,
  };

  // A badly damaged file can print thousands of error lines; leave room so maxBuffer never trips.
  var run = function (cmd, args) {
    return spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  };
  var exitOf = function (r) {
    if (r.signal) return 'signal ' + r.signal;
    return r.error && r.status == null ? 'not started' : 'exit ' + r.status;
  };
  var why = function (r) { return tail(r.error ? r.error.message : (r.stderr || r.stdout || exitOf(r))); };

  try {
    var video = pickVideo(file.ffProbeData && file.ffProbeData.streams);
    if (!video) {
      response.infoLog += 'No video stream found, skipping.\r\n';
      return response;
    }
    var rate = video.r_frame_rate || 'unknown';
    if (STD.indexOf(rate) !== -1) {
      response.infoLog += 'Frame rate already standard (' + rate + '), skipping.\r\n';
      return response;
    }

    var ffprobe = pickFfprobe((otherArguments || {}).ffmpegPath, fs.existsSync);
    var stream;
    if (typeof video.index === 'number') {
      stream = String(video.index);
    } else {
      // ffprobe's v:N counts cover art too.
      var before = file.ffProbeData.streams.slice(0, file.ffProbeData.streams.indexOf(video));
      stream = 'v:' + before.filter(function (s) { return s.codec_type === 'video'; }).length;
    }

    var list = run(ffprobe, ['-v', 'error', '-select_streams', stream, '-show_entries', 'packet=pts_time',
      '-of', 'csv=p=0', '--', file._id]);
    if (list.error || list.status !== 0) {
      throw new Error('ffprobe could not list the video timestamps (' + exitOf(list) + '): ' + why(list));
    }
    var times = parseTimes(list.stdout);
    if (times.length < 2) {
      throw new Error('ffprobe listed too few usable video timestamps (' + times.length + ' found)');
    }
    var g = findGaps(times);
    if (!g.gaps.length) {
      response.infoLog += 'Frame rate ' + rate + ' is not standard, but the frame timing is steady (no gaps). Continuing.\r\n';
      return response;
    }

    // Decode every frame. "repeat+" keeps ffmpeg from folding repeated errors into "Last message repeated
    // N times". "-threads 0" decodes on all cores (the error count is the same as with one thread, and
    // single-threaded decoding of a long 1080p episode takes several minutes). ffprobe has no muxer (unlike "ffmpeg -f null"), so it never complains about a variable-rate
    // file's timestamps: every stderr line is a decoder error.
    var dec = run(ffprobe, ['-v', 'repeat+error', '-threads', '0', '-select_streams', stream, '-count_frames',
      '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', '--', file._id]);
    if (dec.error || dec.status !== 0) {
      throw new Error('ffprobe could not decode the video (' + exitOf(dec) + '): ' + why(dec));
    }
    var errors = countLines(dec.stderr);
    if (errors === 0) {
      response.infoLog += 'Frame rate ' + rate + ': ' + describeGaps(g)
        + ', but the video decodes cleanly, so it was made variable-frame-rate on purpose. Continuing.\r\n';
      return response;
    }

    var msg = damagedMessage(g, errors);
    response.infoLog += msg + '\r\nFirst decoder errors:\r\n'
      + firstErrors(dec.stderr, 5).map(function (line) { return '  ' + line + '\r\n'; }).join('');
    response.error = msg + ' First error: ' + firstErrors(dec.stderr, 1)[0];
    return response;
  } catch (err) {
    console.log(err);
    response.infoLog += 'Error: ' + err.message + '\r\n';
    // Letting the file through unchecked would defeat the check, so fail the job with the reason.
    response.error = 'Detect damaged video: ' + err.message;
    return response;
  }
};

module.exports.details = details;
module.exports.plugin = plugin;
// Pure helpers, exported for tests/detect_damaged_video.test.js. Tdarr only uses details and plugin.
module.exports._test = {
  STD: STD,
  pickFfprobe: pickFfprobe,
  pickVideo: pickVideo,
  parseTimes: parseTimes,
  findGaps: findGaps,
  clock: clock,
  describeGaps: describeGaps,
  damagedMessage: damagedMessage,
  countLines: countLines,
  firstErrors: firstErrors,
  tail: tail,
};
