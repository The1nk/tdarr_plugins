/* eslint-disable */

// tdarrSkipTest
const details = () => {
  return {
    id: "Tdarr_Plugin_the1nk_add_suffix_to_filename",
    Stage: "Post-processing",
    Name: "Add suffix to filename",
    Type: "Video",
    Operation: "Transcode",
    Description: `Adds a suffix to the filename`,
    Version: "1.00",
    Tags: "post-processing",
    Inputs: [{
      name: 'suffix',
      type: 'string',
      defaultValue: ' (Tdarr)',
      inputUI: {
        type: 'text'
      },
      tooltip: `Specify text to be appended to filename
            \\nExample:\\n
             (Tdarr)

            \\nExample:\\n
             finalfinalFINALv3`,
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
    var fileNameOld = file._id;

    var response = {
      file,
      removeFromDB: false,
      updateDB: false,
      infoLog: ""
    };

    response.infoLog += 'suffix is ' + inputs.suffix + '\r\n';
    response.infoLog += 'fnwoExt is ' + file.fileNameWithoutExtension + '\r\n';
    response.infoLog += 'file._id is ' + file._id + '\r\n';
    response.infoLog += 'file.meta.Directory is ' + file.meta.Directory + '\r\n';
    response.infoLog += 'file.meta.FileTypeExtension is ' + file.meta.FileTypeExtension + '\r\n';

    if (inputs.suffix !== '' && !file.fileNameWithoutExtension.endsWith(inputs.suffix)) {
      var cleanName = file.fileNameWithoutExtension.replace(/\s*\(\)\s*$/, '');
      file._id = file.meta.Directory + '/' + cleanName + (' ' + inputs.suffix).replace('  ', ' ') + '.' + file.meta.FileTypeExtension;
    }

    if (fileNameOld != file._id) {
      fs.renameSync(fileNameOld, file._id);

      response.file = file;
      response.updateDB = true;
    }

    return response;
} catch (err) {
    console.log(err);
    response.infoLog += 'Error: ' + err.message + '\r\n';
    return response;
  }
};

module.exports.details = details;
module.exports.plugin = plugin;