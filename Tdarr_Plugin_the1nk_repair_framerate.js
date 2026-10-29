/* eslint-disable */

// tdarrSkipTest
const details = () => {
  return {
    id: "Tdarr_Plugin_the1nk_repair_framerate",
    Stage: "Pre-processing",
    Name: "Repair near-miss frame rate",
    Type: "Video",
    Operation: "Transcode",
    Description: `Losslessly repairs malformed MKV frame-rate metadata (e.g. 23185/967 instead of 24000/1001) that makes files stutter on devices like the Fire TV 4K Max. Remuxes with mkvmerge, setting the default duration to the nearest standard rate and fixing bitstream timing. Files whose frame timing has gaps (frames missing) are never repaired: forcing a constant rate would close the gaps by sliding the video out of sync with the audio. The result is verified (rate, codec, pixel format, duration, video packet count) before it is used; on any failure the file is left untouched. Flow-only: runs mkvmerge itself and hands the repaired file to the next flow plugin.`,
    Version: "1.02",
    Tags: "pre-processing,mkvmerge,video only",
    Inputs: [{
      name: 'max_delta_fps',
      type: 'number',
      defaultValue: 0.05,
      inputUI: {
        type: 'text'
      },
      tooltip: `Only repair rates within this many fps of a standard rate. Larger gaps would change playback SPEED, not just fix metadata (e.g. 500/21 = 23.81 fps is a real rate, not a near-miss).
            \\nExample:\\n
            0.05`,
    }]
  };
};

// Rates a display can actually lock to.
const STD = ['24000/1001', '24/1', '25/1', '30000/1001', '30/1', '50/1', '60000/1001', '60/1', '24000/1000'];
// Tdarr's bundled ffprobe (not on PATH in the Tdarr container), then PATH.
const FFPROBE_CANDIDATES = ['/app/Tdarr_Node/assets/app/ffmpeg/linux_x64/ffprobe', 'ffprobe'];

const toFps = (rate) => {
  const p = String(rate).split('/');
  if (p.length !== 2 || Number(p[1]) === 0) return 0;
  return Number(p[0]) / Number(p[1]);
};

// --- Gaps in the frame timing. Keep identical to the copy in Tdarr_Plugin_the1nk_detect_damaged_video.js. ---

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
  var cleanup = function () {
    if (outPath && fs.existsSync(outPath)) {
      try { fs.unlinkSync(outPath); } catch (e) { /* ignore */ }
    }
  };

  try {
    if (file.container !== 'mkv') {
      response.infoLog += 'File is not MKV (mkvmerge only), skipping.\r\n';
      return response;
    }

    var streams = (file.ffProbeData && file.ffProbeData.streams) || [];
    var video = streams.find(function (s) {
      return s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic);
    });
    if (!video) {
      response.infoLog += 'No video stream found, skipping.\r\n';
      return response;
    }

    var rate = video.r_frame_rate;
    if (STD.indexOf(rate) !== -1) {
      response.infoLog += 'Frame rate already standard (' + rate + '), skipping.\r\n';
      return response;
    }
    var fps = toFps(rate);
    if (fps <= 0) {
      response.infoLog += "Cannot parse frame rate '" + rate + "', skipping.\r\n";
      return response;
    }

    // Pick the standard rate closest IN VALUE to the file's own rate.
    var target = null;
    var delta = Number.MAX_VALUE;
    STD.forEach(function (s) {
      var d = Math.abs(toFps(s) - fps);
      if (d < delta) { delta = d; target = s; }
    });
    if (delta >= inputs.max_delta_fps) {
      response.infoLog += 'Frame rate ' + rate + ' (' + fps.toFixed(3) + ' fps) is ' + delta.toFixed(3)
        + ' fps from nearest standard ' + target + ' (limit ' + inputs.max_delta_fps + '). '
        + 'Not a near-miss; repairing would change playback speed. Skipping.\r\n';
      return response;
    }

    if (!otherArguments || !otherArguments.cacheFilePath) {
      response.infoLog += 'No cacheFilePath provided (not running in a flow?), skipping.\r\n';
      return response;
    }

    var ffprobe = FFPROBE_CANDIDATES.find(function (c) { return !path.isAbsolute(c) || fs.existsSync(c); });

    // Frames missing from the stream also give a near-miss rate (24 fps missing 1 frame in 600 is 23.96).
    // Forcing a constant rate would close those holes by sliding the video out of sync with the audio.
    var stream;
    if (typeof video.index === 'number') {
      stream = String(video.index);
    } else {
      // ffprobe's v:N counts cover art too.
      var earlier = streams.slice(0, streams.indexOf(video));
      stream = 'v:' + earlier.filter(function (s) { return s.codec_type === 'video'; }).length;
    }
    var list = spawnSync(ffprobe, ['-v', 'error', '-select_streams', stream, '-show_entries', 'packet=pts_time',
      '-of', 'csv=p=0', '--', file._id], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    if (list.error || list.status !== 0) {
      throw new Error('ffprobe could not list the video timestamps ('
        + (list.error && list.status === null && !list.signal ? 'not started'
          : list.signal ? 'signal ' + list.signal : 'exit ' + list.status) + '): '
        + String(list.error ? list.error.message : (list.stderr || list.stdout || 'no output')).trim().slice(-2000));
    }
    var times = parseTimes(list.stdout);
    if (times.length < 2) {
      response.infoLog += 'Near-miss rate ' + rate + ', but ffprobe listed too few usable video timestamps ('
        + times.length + ' found), so the timing cannot be checked. Skipping.\r\n';
      return response;
    }
    var timing = findGaps(times);
    if (timing.gaps.length) {
      response.infoLog += 'Near-miss rate ' + rate + ', but found ' + describeGaps(timing)
        + '. Forcing a constant rate would desync audio. Skipping.\r\n';
      return response;
    }

    // mkvmerge ships alongside mkvpropedit (mkvtoolnix).
    var propedit = (otherArguments.mkvpropeditPath || 'mkvpropedit');
    var mkvmerge = path.join(path.dirname(propedit), path.basename(propedit).replace('mkvpropedit', 'mkvmerge'));
    if (path.dirname(propedit) === '.') mkvmerge = path.basename(mkvmerge);

    // Find the mkvmerge track ID of the video track (also confirms mkvmerge runs).
    var ident = spawnSync(mkvmerge, ['-J', file._id], { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
    if (ident.error || ident.status !== 0) {
      response.infoLog += 'mkvmerge identify failed (' + mkvmerge + '): '
        + (ident.error ? ident.error.message : ident.stderr || ident.stdout) + '\r\n';
      return response;
    }
    var vTrack = (JSON.parse(ident.stdout).tracks || []).find(function (t) { return t.type === 'video'; });
    if (!vTrack) {
      response.infoLog += 'mkvmerge found no video track, skipping.\r\n';
      return response;
    }
    var tid = vTrack.id;

    outPath = otherArguments.cacheFilePath;
    if (path.resolve(outPath) === path.resolve(file._id)) {
      response.infoLog += 'Output path equals input path, skipping.\r\n';
      return response;
    }

    response.infoLog += 'Near-miss frame rate ' + rate + ' (' + fps.toFixed(5) + ' fps). Remuxing video track '
      + tid + ' to ' + target + ' (delta ' + delta.toFixed(5) + ').\r\n';
    var merge = spawnSync(mkvmerge, [
      '-o', outPath,
      '--default-duration', tid + ':' + target + 'p',
      '--fix-bitstream-timing-information', tid + ':1',
      file._id,
    ], { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
    // mkvmerge: 0 = ok, 1 = ok with warnings, 2 = error. status is null when it was killed by a signal.
    if (merge.error || merge.status === null || merge.status > 1 || !fs.existsSync(outPath)) {
      response.infoLog += 'mkvmerge failed (' + (merge.signal ? 'signal ' + merge.signal : 'exit ' + merge.status) + '): '
        + (merge.error ? merge.error.message : merge.stdout) + '\r\n';
      cleanup();
      return response;
    }
    if (merge.status === 1) response.infoLog += 'mkvmerge warnings: ' + merge.stdout + '\r\n';

    // --- verification gate ---
    var probe = function (args, p) {
      var r = spawnSync(ffprobe, ['-v', 'error'].concat(args, ['--', p]), { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
      if (r.error || r.status !== 0) throw new Error('ffprobe failed on ' + p + ': ' + (r.error ? r.error.message : r.stderr));
      return JSON.parse(r.stdout);
    };
    // Same selector for source and output: mkvmerge keeps the track order, so it names the same video in both.
    var info = function (p) {
      var j = probe(['-select_streams', stream, '-count_packets',
        '-show_entries', 'stream=codec_name,pix_fmt,r_frame_rate,nb_read_packets:format=duration', '-of', 'json'], p);
      var s = (j.streams || [])[0] || {};
      return {
        codec: s.codec_name, pixFmt: s.pix_fmt, rate: s.r_frame_rate,
        packets: s.nb_read_packets, duration: Number((j.format || {}).duration) || 0,
      };
    };
    var before = info(file._id);
    var after = info(outPath);
    var fail = null;
    if (after.rate !== target) fail = 'rate not corrected (got ' + after.rate + ')';
    else if (after.codec !== before.codec) fail = 'codec changed: ' + before.codec + ' -> ' + after.codec;
    else if (after.pixFmt !== before.pixFmt) fail = 'pix_fmt changed: ' + before.pixFmt + ' -> ' + after.pixFmt;
    else if (Math.abs(after.duration - before.duration) > 1.0) fail = 'duration mismatch: ' + after.duration + 's vs ' + before.duration + 's';
    else if (!/^\d+$/.test(String(after.packets)) || after.packets !== before.packets) fail = 'video packet count mismatch: src=' + before.packets + ' out=' + after.packets;
    if (fail) {
      response.infoLog += 'Verification FAILED: ' + fail + '. Original left untouched.\r\n';
      cleanup();
      return response;
    }

    response.infoLog += 'Verified: ' + rate + ' -> ' + after.rate + ', ' + after.codec + '/' + after.pixFmt
      + ', ' + after.packets + ' video packets (matches source). Lossless.\r\n';
    // Hand the repaired file to the next flow plugin (the runner picks up the new _id).
    response.file = Object.assign({}, file, { _id: outPath, file: outPath });
    return response;
  } catch (err) {
    console.log(err);
    response.infoLog += 'Error: ' + err.message + '. Original left untouched.\r\n';
    cleanup();
    return response;
  }
};

module.exports.details = details;
module.exports.plugin = plugin;
// Pure helpers, exported for tests/repair_framerate.test.js. Tdarr only uses details and plugin.
module.exports._test = {
  parseTimes: parseTimes,
  findGaps: findGaps,
  clock: clock,
  describeGaps: describeGaps,
};
