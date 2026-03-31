/* eslint-disable */

// tdarrSkipTest
const details = () => {
  return {
    id: "Tdarr_Plugin_the1nk_notify_sonarr",
    Stage: "Post-processing",
    Name: "Notify Sonarr to rescan",
    Type: "Video",
    Operation: "Transcode",
    Description: `Notifies Sonarr to rescan a series after processing. Extracts the IMDB ID from the show folder name (e.g. Show Name {imdb-tt1234567}) to locate the series in Sonarr.\n`,
    Version: "1.00",
    Tags: "post-processing",
    Inputs: [
      {
        name: 'host',
        type: 'string',
        defaultValue: 'localhost',
        inputUI: { type: 'text' },
        tooltip: `Sonarr host
            \\nExample:\\n
            localhost`,
      },
      {
        name: 'port',
        type: 'string',
        defaultValue: '8989',
        inputUI: { type: 'text' },
        tooltip: `Sonarr port
            \\nExample:\\n
            8989`,
      },
      {
        name: 'apiKey',
        type: 'string',
        defaultValue: '',
        inputUI: { type: 'text' },
        tooltip: `Sonarr API key. Found under Settings > General > Security.`,
      },
      {
        name: 'useHttps',
        type: 'boolean',
        defaultValue: false,
        inputUI: { type: 'toggle' },
        tooltip: `Use HTTPS instead of HTTP when connecting to Sonarr.`,
      },
      {
        name: 'baseUrl',
        type: 'string',
        defaultValue: '',
        inputUI: { type: 'text' },
        tooltip: `Optional base URL path if Sonarr is behind a reverse proxy sub-path.
            \\nExample:\\n
            /sonarr
            \\nLeave empty if not applicable.`,
      },
    ]
  };
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const plugin = (file, librarySettings, inputs, otherArguments) => {

  const lib = require('../methods/lib')();
  var spawnSync = require('child_process').spawnSync;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars,no-param-reassign
  inputs = lib.loadDefaultValues(inputs, details);

  var response = {
    file,
    removeFromDB: false,
    updateDB: false,
    infoLog: "",
  };

  try {
    var dir = file.meta.Directory;
    response.infoLog += `File directory: ${dir}\r\n`;

    // Split directory into segments and find the one containing {imdb-ttXXXXXX}
    // e.g. /media/Library/Shows/The Madison {imdb-tt33204276}/Season 1
    var segments = dir.split(/[\/\\]/);
    var imdbId = null;
    for (var i = 0; i < segments.length; i++) {
      var m = segments[i].match(/\{imdb-(tt\d+)\}/i);
      if (m) {
        imdbId = m[1];
        break;
      }
    }

    if (!imdbId) {
      response.infoLog += `No IMDB ID found in directory path, skipping Sonarr notify.\r\n`;
      return response;
    }
    response.infoLog += `Found IMDB ID: ${imdbId}\r\n`;

    var scheme = (inputs.useHttps === true || inputs.useHttps === 'true') ? 'https' : 'http';
    var baseUrl = (inputs.baseUrl || '').replace(/\/$/, '');
    var apiBase = `${scheme}://${inputs.host}:${inputs.port}${baseUrl}/api/v3`;

    // GET all series and find by imdbId
    response.infoLog += `Fetching series list from Sonarr\r\n`;
    var getResult = spawnSync('curl', [
      '-s', '-f',
      '-H', `X-Api-Key: ${inputs.apiKey}`,
      `${apiBase}/series`,
    ], { stdio: 'pipe', encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });

    if (getResult.error) {
      response.infoLog += `curl error: ${getResult.error}\r\n`;
      return response;
    }
    if (getResult.status !== 0) {
      response.infoLog += `curl failed (status ${getResult.status}): ${getResult.stderr}\r\n`;
      return response;
    }

    var seriesList = JSON.parse(getResult.stdout);
    var series = seriesList.find(function(s) { return s.imdbId === imdbId; });
    if (!series) {
      response.infoLog += `No series found in Sonarr with IMDB ID ${imdbId}.\r\n`;
      return response;
    }
    response.infoLog += `Found series in Sonarr: "${series.title}" (id: ${series.id})\r\n`;

    // POST RescanSeries command
    var body = JSON.stringify({ name: 'RescanSeries', seriesId: series.id });
    var postResult = spawnSync('curl', [
      '-s', '-f',
      '-X', 'POST',
      '-H', `X-Api-Key: ${inputs.apiKey}`,
      '-H', 'Content-Type: application/json',
      '-d', body,
      `${apiBase}/command`,
    ], { stdio: 'pipe', encoding: 'utf8' });

    if (postResult.error) {
      response.infoLog += `curl error: ${postResult.error}\r\n`;
      return response;
    }
    if (postResult.status !== 0) {
      response.infoLog += `curl failed (status ${postResult.status}): ${postResult.stderr}\r\n`;
      return response;
    }

    response.infoLog += `Sonarr rescan triggered successfully.\r\n`;
    return response;

  } catch (err) {
    console.log(err);
    response.infoLog += `Error: ${err.message}\r\n`;
    return response;
  }
};

module.exports.details = details;
module.exports.plugin = plugin;
