/* eslint-disable */

// tdarrSkipTest
const details = () => {
  return {
    id: "Tdarr_Plugin_the1nk_run_mkvpropedit",
    Stage: "Pre-processing",
    Name: "Run mkvpropedit",
    Type: "Video",
    Operation: "Transcode",
    Description: `Runs mkvpropedit on file, if needed, to add track statistics tags. Also sets a new global tag to indicate that it was run so it won't re-run on each cycle.`,
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
    var spawnSync = require('child_process').spawnSync;
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

    var flagname = "TDARR_MKVPROPEDIT";

    // Skip non-MKV files
    if (file.container !== 'mkv') {
      response.infoLog += 'File is not MKV, skipping.\r\n';
      return response;
    }

    // Check if already processed
    var tags = (file.ffProbeData.format && file.ffProbeData.format.tags) || {};
    if (tags[flagname]) {
      response.infoLog += 'File has already been processed by this plugin, skipping.\r\n';
      return response;
    }

    var xmlFile = file._id + '.xml';
    var newTag = '  <Tag>\n    <Targets/>\n    <Simple>\n      <Name>' + flagname + '</Name>\n      <String>1</String>\n    </Simple>\n  </Tag>\n';

    // Extract existing tags to XML
    var extractResult = spawnSync('mkvextract', ['tags', file._id, xmlFile], {
      stdio: 'pipe',
      encoding: 'utf8',
    });
    if (extractResult.stdout) response.infoLog += 'mkvextract: ' + extractResult.stdout + '\r\n';
    if (extractResult.stderr) response.infoLog += 'mkvextract: ' + extractResult.stderr + '\r\n';
    if (extractResult.error) {
      response.infoLog += 'mkvextract failed to start: ' + extractResult.error + '\r\n';
      response.processFile = false;
      return response;
    }

    // Build XML: inject tag into existing content, or create minimal XML from scratch
    var xmlContent;
    if (fs.existsSync(xmlFile) && fs.statSync(xmlFile).size > 0) {
      xmlContent = fs.readFileSync(xmlFile, 'utf8');
      xmlContent = xmlContent.replace('</Tags>', newTag + '</Tags>');
      response.infoLog += 'Injected ' + flagname + ' tag into existing tags XML.\r\n';
    } else {
      xmlContent = '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE Tags SYSTEM "matroskatags.dtd">\n<Tags>\n' + newTag + '</Tags>';
      response.infoLog += 'No existing tags found, created new tags XML.\r\n';
    }
    fs.writeFileSync(xmlFile, xmlContent, 'utf8');

    // Run mkvpropedit to write tags and add track statistics
    var propeditResult = spawnSync('mkvpropedit', [file._id, '--tags', 'global:' + xmlFile, '--add-track-statistics-tags'], {
      stdio: 'pipe',
      encoding: 'utf8',
    });
    if (propeditResult.stdout) response.infoLog += 'mkvpropedit: ' + propeditResult.stdout + '\r\n';
    if (propeditResult.stderr) response.infoLog += 'mkvpropedit: ' + propeditResult.stderr + '\r\n';

    // Clean up XML file
    try { fs.unlinkSync(xmlFile); } catch (cleanupErr) {
      response.infoLog += 'Warning: failed to delete XML file: ' + cleanupErr.message + '\r\n';
    }

    if (propeditResult.error) {
      response.infoLog += 'mkvpropedit failed to start: ' + propeditResult.error + '\r\n';
      response.processFile = false;
      return response;
    }

    response.infoLog += 'mkvpropedit completed with exit code ' + propeditResult.status + '.\r\n';
    return response;
  } catch (err) {
    console.log(err);
    response.infoLog += 'Error: ' + err.message + '\r\n';
    return response;
  }
};

module.exports.details = details;
module.exports.plugin = plugin;