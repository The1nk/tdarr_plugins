/* eslint-disable */

// tdarrSkipTest
const details = () => {
  return {
    id: "Tdarr_Plugin_the1nk_break_hardlink",
    Stage: "Pre-processing",
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
      infoLog: "",
      processFile: false,
      preset: '',
      container: '.' + file.container,
      handBrakeMode: false,
      FFmpegMode: false
    };

    // Break hardlink by copying to a temp file and renaming back.
    // Note: nlink-based hardlink detection is unreliable inside Docker, so we always perform this operation.
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
    response.processFile = false;
    return response;
  }
};

module.exports.details = details;
module.exports.plugin = plugin;