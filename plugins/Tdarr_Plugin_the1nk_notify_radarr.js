/* eslint-disable */

// tdarrSkipTest
const details = () => {
  return {
    id: "Tdarr_Plugin_the1nk_notify_radarr",
    Stage: "Post-processing",
    Name: "Notify Radarr to rescan",
    Type: "Video",
    Operation: "Transcode",
    Description: `Notifies Radarr to rescan a movie after processing. Extracts the IMDB ID from the filename (e.g. {imdb-tt1234567}) to locate the movie in Radarr.\n`,
    Version: "1.00",
    Tags: "post-processing",
    Inputs: [
      {
        name: 'host',
        type: 'string',
        defaultValue: 'localhost',
        inputUI: { type: 'text' },
        tooltip: `Radarr host
            \\nExample:\\n
            localhost`,
      },
      {
        name: 'port',
        type: 'string',
        defaultValue: '7878',
        inputUI: { type: 'text' },
        tooltip: `Radarr port
            \\nExample:\\n
            7878`,
      },
      {
        name: 'apiKey',
        type: 'string',
        defaultValue: '',
        inputUI: { type: 'text' },
        tooltip: `Radarr API key. Found under Settings > General > Security.`,
      },
      {
        name: 'useHttps',
        type: 'boolean',
        defaultValue: false,
        inputUI: { type: 'toggle' },
        tooltip: `Use HTTPS instead of HTTP when connecting to Radarr.`,
      },
      {
        name: 'baseUrl',
        type: 'string',
        defaultValue: '',
        inputUI: { type: 'text' },
        tooltip: `Optional base URL path if Radarr is behind a reverse proxy sub-path.
            \\nExample:\\n
            /radarr
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
    var filePath = file._id;
    response.infoLog += `File path: ${filePath}\r\n`;

    // Extract IMDB ID from filename: look for {imdb-ttXXXXXX}
    var imdbMatch = filePath.match(/\{imdb-(tt\d+)\}/i);
    if (!imdbMatch) {
      response.infoLog += `No IMDB ID found in filename, skipping Radarr notify.\r\n`;
      return response;
    }
    var imdbId = imdbMatch[1];
    response.infoLog += `Found IMDB ID: ${imdbId}\r\n`;

    var scheme = (inputs.useHttps === true || inputs.useHttps === 'true') ? 'https' : 'http';
    var baseUrl = (inputs.baseUrl || '').replace(/\/$/, '');
    var apiBase = `${scheme}://${inputs.host}:${inputs.port}${baseUrl}/api/v3`;

    // GET all library movies and find by imdbId
    response.infoLog += `Fetching movie list from Radarr\r\n`;
    var getResult = spawnSync('curl', [
      '-s', '-f',
      '-H', `X-Api-Key: ${inputs.apiKey}`,
      `${apiBase}/movie`,
    ], { stdio: 'pipe', encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });

    if (getResult.error) {
      response.infoLog += `curl error: ${getResult.error}\r\n`;
      return response;
    }
    if (getResult.status !== 0) {
      response.infoLog += `curl failed (status ${getResult.status}): ${getResult.stderr}\r\n`;
      return response;
    }

    var movies = JSON.parse(getResult.stdout);
    var movie = movies.find(function(m) { return m.imdbId === imdbId; });
    if (!movie) {
      response.infoLog += `Movie with IMDB ID ${imdbId} not found in Radarr library.\r\n`;
      return response;
    }
    response.infoLog += `Found movie in Radarr: "${movie.title}" (id: ${movie.id})\r\n`;

    // POST RescanMovie command
    var body = JSON.stringify({ name: 'RescanMovie', movieId: movie.id });
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

    response.infoLog += `Radarr rescan triggered successfully.\r\n`;
    return response;

  } catch (err) {
    console.log(err);
    response.infoLog += `Error: ${err.message}\r\n`;
    return response;
  }
};

module.exports.details = details;
module.exports.plugin = plugin;
