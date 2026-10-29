/* eslint-disable */

// tdarrSkipTest
const details = () => {
  return {
    id: "Tdarr_Plugin_the1nk_detect_damaged_video",
    Stage: "Pre-processing",
    Name: "Detect damaged video",
    Type: "Video",
    Operation: "Transcode",
    Description: `Fails the job when the video stream is missing frames, so a damaged download never replaces the library file. Only files whose video frame rate is not a standard one are checked (frames lost from a 24 fps file give odd rates like 7016/301). Their video timestamps are listed with ffprobe, and an interval of at least 1.5x the normal frame interval counts as a gap. If there are gaps, the video is decoded once: frames cut out of the stream leave decoder errors ("Missing reference picture"), while a file made variable-frame-rate on purpose (a still scene stored as one long frame) decodes cleanly and is let through. Gaps plus decoder errors fail the job with the number of gaps, the largest one and where it is, the time missing and the error count. The file is only read, never changed.`,
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

module.exports.details = details;
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
};
