// tdarrSkipTest
const details = () => ({
    id: 'Tdarr_Plugin_the1nk_processed_tag_filter',
    Stage: 'Pre-processing',
    Name: 'Skips files that have the TDARR_PROCESSED tag',
    Type: 'Video',
    Operation: 'Filter',
    Description: 'Simply cancels out of the cycle if the file has the TDARR_PROCESSED ffprobe tag set \n\n',
    Version: '1.00',
    Tags: 'tag,filter,ffprobe',
    Inputs: []
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

    const tags = file.ffProbeData?.format?.tags || {};
    const processed = tags.TDARR_PROCESSED;

    response.infoLog += `Checking ffprobe tags for TDARR_PROCESSED on '${file.fileNameWithoutExtension}'...\r\n`;
    if (processed) {
        response.infoLog += `TDARR_PROCESSED tag found ('${processed}'). Skipping.`;
        response.processFile = false;
    } else {
        response.infoLog += 'TDARR_PROCESSED tag not found. Continuing.';
        response.processFile = true;
    }

    return response;
};

module.exports.details = details;
module.exports.plugin = plugin;
