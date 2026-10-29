/* eslint-disable */

// tdarrSkipTest
const details = () => {
  return {
    id: "Tdarr_Plugin_the1nk_add_suffix_to_filename",
    Stage: "Post-processing",
    Name: "Add suffix to filename",
    Type: "Video",
    Operation: "Transcode",
    Description: `Adds a suffix to the filename, keeping the file's own extension`,
    Version: "1.01",
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
    var path = require("path");
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
    response.infoLog += 'extension is ' + path.extname(fileNameOld) + '\r\n';

    if (inputs.suffix !== '' && !file.fileNameWithoutExtension.endsWith(inputs.suffix)) {
      var cleanName = file.fileNameWithoutExtension.replace(/\s*\(\)\s*$/, '');
      // Folder and extension from the file's own path: ExifTool's FileTypeExtension calls MPEG-TS "m2t".
      file._id = path.join(path.dirname(fileNameOld),
        cleanName + (' ' + inputs.suffix).replace('  ', ' ') + path.extname(fileNameOld));
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