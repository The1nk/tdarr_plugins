const details = () => ({
    id: 'Tdarr_Plugin_the1nk_downmix_to_stereo_and_apply_DRC',
    Stage: 'Pre-processing',
    Name: 'Downmix & Dynamic Range Compression',
    Type: 'Audio',
    Operation: 'Transcode',
    Description: 'Downmixes surround to AAC stereo AND applies dynamic range compression. Will skip files that already have 1/2 channels, or don\'t have surround streams \n\n',
    Version: '1.00',
    Tags: 'ffmpeg',
    Inputs: [],
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const plugin = (file, librarySettings, inputs, otherArguments) => {
    const lib = require('../methods/lib')();
    // eslint-disable-next-line @typescript-eslint/no-unused-vars,no-param-reassign
    inputs = lib.loadDefaultValues(inputs, details);
    const response = {
        processFile: false,
        preset: '',
        handBrakeMode: false,
        FFmpegMode: true,
        reQueueAfter: true,
        infoLog: '',
        container: `.${file.container}`,
    };

    let surroundTrackFound = false;
    let stereoFound = false;
    let audiostreamcounter = -1;
    let suffixOfCrazyThings = "";
    let outCounter = 0;

    for (let index = 0; index < file.ffProbeData.streams.length; index += 1) {
        const stream = file.ffProbeData.streams[index];
        if (stream.codec_type === 'audio' && stream.channels) {
            audiostreamcounter += 1;

            if (stream.channels >= 3) {
                surroundTrackFound = true;

                response.infoLog += ' Found relevant stream #' + index + ' (audio #' + audiostreamcounter + '), will downmix to #' + outCounter + ', ';

                // "copy" the stream (can't copy, have to transcode it anyway)
                suffixOfCrazyThings +=
                    '-map 0:a:' + audiostreamcounter + ' ' + // map audio stream twice
                    '-map 0:a:' + audiostreamcounter + ' ' +
                    '-c:a:' + outCounter + ' aac ' +  // first one as AAC downmix
                    '-filter:a:' + outCounter + ' "pan=stereo|FL=0.707*FC+0.707*FL+0.707*BL+0.707*SL+0.5*LFE|FR=0.707*FC+0.707*FR+0.707*BR+0.707*SR+0.5*LFE" ';

                outCounter += 1;
                response.infoLog += 'and copy to #' + outCounter + '!\r\n';
                suffixOfCrazyThings +=
                    '-c:a:' + outCounter + ' copy ';  // second one is the original

                outCounter += 1;
            } else
                stereoFound = true;
        }
    }

    if (stereoFound) {
        response.infoLog = 'File has mono/stereo audio already, skipping';
        return response;
    }

    if (!surroundTrackFound) {
        response.infoLog = 'File has no surround tracks, skipping';
        return response;
    }

    response.preset = '<io> ' +
        '-map 0:v -c:v copy ' +  // copy all vid
        '-map 0:s? -c:s copy ' +  // copy all subs
        suffixOfCrazyThings

    response.processFile = true;
    response.infoLog = 'File matches requirements. Downmixing, compressing, etc!\r\n' + response.infoLog;
    return response;
};

module.exports.details = details;
module.exports.plugin = plugin;