/* eslint-disable */

// tdarrSkipTest
const details = () => {
  return {
    id: "Tdarr_Plugin_the1nk_run_mkvpropedit",
    Stage: "Pre-processing",
    Name: "Run mkvpropedit",
    Type: "Video",
    Operation: "Transcode",
    Description: `Runs mkvpropedit on file, if needed, to add track statistics tags. Also sets a new global tag via ffmpeg to indicate that it was run so it won't re-run on each cycle. With refresh_only, it instead just rewrites the statistics in place on the flow's working file (no tag check, no ffmpeg pass), to fix tags left stale by later ffmpeg steps.`,
    Version: "1.20",
    Tags: "post-processing",
    Inputs: [{
      name: 'refresh_only',
      type: 'boolean',
      defaultValue: false,
      inputUI: {
        type: 'dropdown',
        options: [
          'false',
          'true',
        ],
      },
      tooltip: `Only refresh the track statistics tags in place, ignoring the TDARR_MKVPROPEDIT tag and skipping the ffmpeg pass.
            \\nUse this in a flow after the last step that re-encodes or remuxes with ffmpeg (ffmpeg copies the old, now-wrong statistics onto new streams).
            \\nSkips the file if it is still the original library file, so library files are never edited in place by this mode.
            \\nExample:\\n
            true`,
    }]
  };
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const plugin = (file, librarySettings, inputs, otherArguments) => {

  const lib = require('../methods/lib')();
  // eslint-disable-next-line @typescript-eslint/no-unused-vars,no-param-reassign
  inputs = lib.loadDefaultValues(inputs, details);
  try {
    var fs = require("fs");
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
      FFmpegMode: true,
      reQueueAfter: true,
    };

    var flagname = "TDARR_MKVPROPEDIT";

    // Skip non-MKV files
    if (file.container !== 'mkv') {
      response.infoLog += 'File is not MKV, skipping.\r\n';
      return response;
    }

    // Refresh-only mode: rewrite the statistics tags in place on the working file and stop.
    if (inputs.refresh_only === true) {
      var original = otherArguments && otherArguments.originalLibraryFile && otherArguments.originalLibraryFile._id;
      if (original && original === file._id) {
        response.infoLog += 'Working file is still the original library file (nothing in this flow changed it), skipping statistics refresh.\r\n';
        return response;
      }
      var refreshResult = spawnSync('mkvpropedit', [file._id, '--add-track-statistics-tags'], {
        stdio: 'pipe',
        encoding: 'utf8',
      });
      if (refreshResult.stdout) response.infoLog += 'mkvpropedit (refresh): ' + refreshResult.stdout + '\r\n';
      if (refreshResult.stderr) response.infoLog += 'mkvpropedit (refresh): ' + refreshResult.stderr + '\r\n';
      if (refreshResult.error) {
        response.infoLog += 'mkvpropedit (refresh) failed to start: ' + refreshResult.error + '\r\n';
        return response;
      }
      // mkvpropedit: 0 = ok, 1 = ok with warnings, 2 = error.
      response.infoLog += 'mkvpropedit (refresh) ' + (refreshResult.status > 1 ? 'FAILED' : 'completed')
        + ' with exit code ' + refreshResult.status + '.\r\n';
      return response;
    }

    // Check if already processed (via ffprobe tags)
    var tags = (file.ffProbeData.format && file.ffProbeData.format.tags) || {};
    var tagKeys = Object.keys(tags);
    if (tagKeys.length > 0) {
      response.infoLog += 'Existing tags: ' + tagKeys.map(function(k) { return k + '=' + tags[k]; }).join(', ') + '\r\n';
    } else {
      response.infoLog += 'No existing tags found in file.\r\n';
    }
    if (tags[flagname]) {
      response.infoLog += 'File has already been processed by this plugin, skipping.\r\n';
      return response;
    }

    // Step 1: add track statistics tags via mkvpropedit
    var propeditStatsResult = spawnSync('mkvpropedit', [file._id, '--add-track-statistics-tags'], {
      stdio: 'pipe',
      encoding: 'utf8',
    });
    if (propeditStatsResult.stdout) response.infoLog += 'mkvpropedit (stats): ' + propeditStatsResult.stdout + '\r\n';
    if (propeditStatsResult.stderr) response.infoLog += 'mkvpropedit (stats): ' + propeditStatsResult.stderr + '\r\n';
    if (propeditStatsResult.error) {
      response.infoLog += 'mkvpropedit (stats) failed to start: ' + propeditStatsResult.error + '\r\n';
      return response;
    }
    response.infoLog += 'mkvpropedit (stats) completed with exit code ' + propeditStatsResult.status + '.\r\n';

    // Step 2: use ffmpeg to stamp the TDARR_MKVPROPEDIT tag (same approach as DRC plugin)
    response.preset = '<io> -map_metadata 0 -map 0 -c copy -metadata ' + flagname + '=1';
    response.processFile = true;
    response.infoLog += 'Queuing ffmpeg to stamp ' + flagname + ' tag.\r\n';
    return response;
  } catch (err) {
    console.log(err);
    response.infoLog += 'Error: ' + err.message + '\r\n';
    return response;
  }
};

module.exports.details = details;
module.exports.plugin = plugin;
