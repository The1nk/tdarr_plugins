// tdarrSkipTest
const details = () => ({
  id: 'Tdarr_Plugin_the1nk_break_stack_if_NOT_processed',
  Stage: 'Pre-processing',
  Name: 'Filter - Break Out Of Plugin Stack If NOT Processed',
  Type: 'Video',
  Operation: 'Filter',
  Description: `This plugin will break out of the plugin stack if the file has NOT BEEN processed`,
  Version: '1.00',
  Tags: 'filter',
  Inputs: [],
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const plugin = (file, librarySettings, inputs, otherArguments) => {
  const lib = require('../methods/lib')();
  // eslint-disable-next-line @typescript-eslint/no-unused-vars,no-param-reassign
  inputs = lib.loadDefaultValues(inputs, details);
  const response = {
    processFile: true,
    infoLog: '',
  };

  if (file.file === otherArguments.originalLibraryFile.file) {
    response.processFile = false;
    response.infoLog = 'File has NOT BEEN processed, breaking out of plugin stack.';
  } else {
    response.infoLog = 'File has been processed. Continuing to next plugin.';
  }

  return response;
};

module.exports.details = details;
module.exports.plugin = plugin;