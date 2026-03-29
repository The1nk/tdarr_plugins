/* eslint-disable */

// tdarrSkipTest
const details = () => {
  return {
    id: "Tdarr_Plugin_the1nk_break_hardlink",
    Stage: "Post-processing",
    Name: "Break hardlink",
    Type: "Video",
    Operation: "Transcode",
    Description: `Breaks hardlink to file, if present. Note: relies on Linux rename(2) semantics to atomically overwrite the original with the temp file — will fail on Windows.`,
    Version: "1.00",
    Tags: "post-processing",
    Inputs: []
  };
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const plugin = (file, librarySettings, inputs, otherArguments) => {

  const lib = require('../methods/lib')();
  // eslint-disable-next-line @typescript-eslint/no-unused-vars,no-param-reassign
  inputs = lib.loadDefaultValues(inputs, details);
  try {
    var fs = require("fs");
    var response = {
      file,
      removeFromDB: false,
      updateDB: false,
      infoLog: ""
    };

    // Check if file is a hardlink by checking if the link count is greater than 1
    var stats = fs.statSync(file._id);
    if (stats.nlink <= 1) {
      // If it's not a hardlink, exit out
      response.infoLog += 'File is not a hardlink, exiting\r\n';
      return response;
    }

    // If it is a hardlink, we need to break it by copying the file to a new location and then renaming it back to the original name
    var tempFileName = file._id + '.temp';
    response.infoLog += 'Breaking hardlink for file. Using temp name of ' + (file.fileNameWithoutExtension + '.' + file.meta.FileTypeExtension + '.temp') + '\r\n';
    fs.copyFileSync(file._id, tempFileName);

    // Rename the temp file back to the original file name, which will break the hardlink
    response.infoLog += 'Renaming to original name of ' + (file.fileNameWithoutExtension + '.' + file.meta.FileTypeExtension) + '\r\n';
    fs.renameSync(tempFileName, file._id);
    
    return response;
} catch (err) {
    console.log(err);
    response.infoLog += 'Error: ' + err.message + '\r\n';
    return response;
  }
};

module.exports.details = details;
module.exports.plugin = plugin;