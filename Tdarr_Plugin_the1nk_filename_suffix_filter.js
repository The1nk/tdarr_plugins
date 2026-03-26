const details = () => ({
    id: 'Tdarr_Plugin_the1nk_filename_suffix_filter',
    Stage: 'Pre-processing',
    Name: 'Skips files that have a specific suffix',
    Type: 'Video',
    Operation: 'Filter',
    Description: 'Simply cancels out of the cycle if the filename has the entered suffix \n\n',
    Version: '1.00',
    Tags: 'filename,filter',
        Inputs: [{
      name: 'suffix',
      type: 'string',
      defaultValue: ' (Tdarr)',
      inputUI: {
        type: 'text'
      },
      tooltip: `Specify suffix to look for
            \\nExample:\\n
             (Tdarr)

            \\nExample:\\n
             finalfinalFINALv3`,
      }]
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const plugin = (file, librarySettings, inputs, otherArguments) => {
    const lib = require('../methods/lib')();
    // eslint-disable-next-line @typescript-eslint/no-unused-vars,no-param-reassign
    inputs = lib.loadDefaultValues(inputs, details);
    const response = {
        processFile: false,
        infoLog: ""
    };

    response.infoLog += "Checking input filename of '" + file.fileNameWithoutExtension + "' for suffix of '" + inputs.suffix + "'...\r\n";
    if (file.fileNameWithoutExtension.endsWith(inputs.suffix)) {
        response.infoLog += "File ends with suffix. Skipping.";
        response.processFile = false;
    } else {
        response.infoLog += "Suffix missing. Continuing.";
        response.processFile = true;
    }

    return response;
};

module.exports.details = details;
module.exports.plugin = plugin;