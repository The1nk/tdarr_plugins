const details = () => ({
    id: 'Tdarr_Plugin_the1nk_downmix_to_stereo_and_apply_DRC',
    Stage: 'Pre-processing',
    Name: 'Downmix & Dynamic Range Compression',
    Type: 'Audio',
    Operation: 'Transcode',
    Description: 'Downmixes surround to AAC stereo AND applies dynamic range compression. For surround tracks, inserts a downmixed stereo track before the original. For existing stereo/mono tracks, applies DRC and volume normalization in place. Skips files with no audio. \n\n',
    Version: '1.20',
    Tags: 'ffmpeg',
    Inputs: [
        {
            name: 'drc_threshold',
            type: 'string',
            defaultValue: '-20dB',
            inputUI: { type: 'text' },
            tooltip: 'Compressor threshold. Signals above this level will be compressed. (e.g. -20dB)',
        },
        {
            name: 'drc_ratio',
            type: 'number',
            defaultValue: 4,
            inputUI: { type: 'text' },
            tooltip: 'Compression ratio (e.g. 4 means 4:1). Higher values = more compression.',
        },
        {
            name: 'drc_attack',
            type: 'number',
            defaultValue: 200,
            inputUI: { type: 'text' },
            tooltip: 'Attack time in milliseconds. How quickly compression kicks in after threshold is crossed.',
        },
        {
            name: 'drc_release',
            type: 'number',
            defaultValue: 1000,
            inputUI: { type: 'text' },
            tooltip: 'Release time in milliseconds. How quickly compression lets go after signal drops below threshold.',
        },
        {
            name: 'drc_makeup',
            type: 'number',
            defaultValue: 4,
            inputUI: { type: 'text' },
            tooltip: 'Makeup gain in dB applied after compression to restore loudness.',
        },
    ],
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

    const drcFilter =
        `acompressor=threshold=${inputs.drc_threshold}:ratio=${inputs.drc_ratio}:attack=${inputs.drc_attack}:release=${inputs.drc_release}:makeup=${inputs.drc_makeup}`;

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

                response.infoLog += ' Found surround stream #' + index + ' (audio #' + audiostreamcounter + '), will downmix to #' + outCounter + ', ';

                // map twice: downmixed AAC first, then copy of original
                suffixOfCrazyThings +=
                    '-map 0:a:' + audiostreamcounter + ' ' +
                    '-map 0:a:' + audiostreamcounter + ' ' +
                    '-c:a:' + outCounter + ' aac ' +  // first one as AAC downmix
                    '-filter:a:' + outCounter + ' "pan=stereo|FL=0.707*FC+0.707*FL+0.707*BL+0.707*SL+0.5*LFE|FR=0.707*FC+0.707*FR+0.707*BR+0.707*SR+0.5*LFE,' + drcFilter + ',dynaudnorm" ';

                outCounter += 1;
                response.infoLog += 'and copy to #' + outCounter + '!\r\n';
                suffixOfCrazyThings +=
                    '-c:a:' + outCounter + ' copy ';  // second one is the original

                outCounter += 1;
            } else {
                stereoFound = true;

                response.infoLog += ' Found stereo/mono stream #' + index + ' (audio #' + audiostreamcounter + '), applying DRC and normalization to #' + outCounter + '.\r\n';

                suffixOfCrazyThings +=
                    '-map 0:a:' + audiostreamcounter + ' ' +
                    '-c:a:' + outCounter + ' aac ' +
                    '-filter:a:' + outCounter + ' "' + drcFilter + ',dynaudnorm" ';

                outCounter += 1;
            }
        }
    }

    if (!surroundTrackFound && !stereoFound) {
        response.infoLog = 'File has no audio tracks, skipping';
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
