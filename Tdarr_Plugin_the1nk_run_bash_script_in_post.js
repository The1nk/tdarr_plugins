/* eslint-disable */

// tdarrSkipTest
const details = () => {
  return {
    id: "Tdarr_Plugin_the1nk_run_bash_script_in_post",
    Stage: "Post-processing",
    Name: "Run bash script in post",
    Type: "Video",
    Operation: "Transcode",
    Description: `Runs a bash script in post-processing. Working directory is sent as first parameter.\\n`,
    Version: "1.00",
    Tags: "post-processing",
    Inputs: [{
      name: 'script',
      type: 'string',
      defaultValue: '',
      inputUI: {
        type: 'text'
      },
      tooltip: `Specify the bash script to run in post-processing
            \\nExample:\\n
            /home/user/script.sh`,
    }]
  };
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const plugin = (file, librarySettings, inputs, otherArguments) => {

  const lib = require('../methods/lib')();
  var spawnSync = require('child_process').spawnSync;

  // eslint-disable-next-line @typescript-eslint/no-unused-vars,no-param-reassign
  inputs = lib.loadDefaultValues(inputs, details);
  try {
    var response = {
      file,
      infoLog: ""
    };

    var script = inputs.script;
    var workingDirectory = file.meta.Directory;

    var result = spawnSync('bash', [script, workingDirectory], {
      stdio: 'pipe',
      encoding: 'utf8',
    });

    if (result.error) {
      response.infoLog += `Failed to start script: ${result.error}\r\n`;
    }
    if (result.stdout) {
      response.infoLog += `Script output: ${result.stdout}\r\n`;
    }
    if (result.stderr) {
      response.infoLog += `Script error: ${result.stderr}\r\n`;
    }
    response.infoLog += `Script exited with code ${result.status}\r\n`;

    return response;
  } catch (err) {
    console.log(err);
    response.infoLog += 'Error: ' + err.message + '\r\n';
    return response;
  }
};

module.exports.details = details;
module.exports.plugin = plugin;