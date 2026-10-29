# MPEG-TS Input Fix — Design

Date: 2026-10-29

## Problem

Job `igcGl9O` (Space King S01E02, a `.ts` file) shows two faults:

1. **Tdarr labels the file `fileMedium: "audio"`.** Its scanner does so when a file has an audio extension
   or when no video stream has a usable average frame rate (`0/0`). Some MPEG-TS captures, such as the Space
   King `.ts` files, probe that way; the container itself is not the cause, and normal `.ts` files are
   labelled video. Yet ffprobe (`video/h264`),
   ExifTool (`video/mpeg`) and MediaInfo (`Video/AVC`) all see the video. Every community plugin that
   checks `file.fileMedium !== 'video'` skips the file: Migz Remux ("☒File is not a video"), Remove Data
   Streams, Migz Image Removal, Reorder Streams and H265 CPU Transcode. The file is never remuxed to
   MKV, so the MKV-only steps (both mkvpropedit refreshes, Repair Frame Rate) skip it as well. Only DRC
   ran.
2. **Add Suffix renames `.ts` to `.m2t`.** It builds the new name from `file.meta.FileTypeExtension`,
   which is ExifTool's idea of the extension; ExifTool calls MPEG-TS `m2t`.

All seven `.ts` inputs ever processed (the seven Space King episodes; every other flow job had an `.mkv`,
`.mp4` or `.avi` input) ended up as `(Tdarr).m2t` MPEG-TS files with DRC'd audio. MPEG-TS can't carry
the `TDARR_DRC_PROCESSED` tag, so running them through the flow again would compress their audio twice.

## Design

- **Migz Remux (local copy, `Tdarr_Plugin_MC93_Migz1Remux.js`, 1.2 → 1.2.1):** treat the file as video if
  `file.fileMedium === 'video'` **or** ffprobe lists a video stream that isn't cover art
  (`codec_type === 'video'` and not `disposition.attached_pic`). A file labelled audio that has such a stream
  is remuxed even when its container already matches (an `.mkv` that probes `0/0`), with `-fflags +genpts`
  and the log line "Tdarr labels this file audio (its video frame rate reads <avg_frame_rate of the first such
  stream, or 'unknown'>). Remuxing so later steps see a video."; the remux re-derives the frame rate. Everything else is unchanged; it already
  adds `-fflags +genpts` for `ts` input. Once the working file is an MKV, Tdarr rescans it before each
  later plugin, and the rest of the flow sees a normal MKV video. The README's "Local copies of community
  plugins" section notes that this copy is now modified.
- **Add Suffix (`Tdarr_Plugin_the1nk_add_suffix_to_filename.js`, 1.00 → 1.01):** take the folder and the
  extension from the file's own path (`path.posix.dirname`, `path.posix.extname` of `file._id`; Tdarr paths
  are POSIX) instead of `file.meta.Directory` / `file.meta.FileTypeExtension`, so a record without `meta`
  is still renamed. The log shows the directory and extension it used.
- **The seven existing files:** converted once, in the Tdarr node with the flow's own tools, after the
  fixes are deployed: `tdarr-ffmpeg -fflags +genpts -i X.m2t -map 0 -c copy -max_muxing_queue_size 9999
  -map -0:d -metadata TDARR_DRC_PROCESSED=1 X.mkv` (the Migz Remux preset plus the DRC tag the flow would
  have kept), then `mkvpropedit --add-track-statistics-tags`. Each output is verified (same video packet
  count, same duration ±0.1 s, same stream codecs, the tag present, `tools/check-video.js --all` CLEAN)
  before its `.m2t` is deleted. `TDARR_PROCESSED` is not added: the flow only writes it when H265 CPU
  Transcode re-encodes, and these files are below its bitrate cutoff.

## Testing

- Unit tests `tests/migz_remux.test.js`: a `.ts` labelled audio with an H.264 stream is remuxed (exact
  preset `-fflags +genpts, -map 0 -c copy -max_muxing_queue_size 9999 -map -0:d `, container `.mkv`); an
  audio file whose only video stream is cover art, and an audio-only file, are still "not a video"; an
  MKV video is "already in mkv"; a normal `.mp4` video is remuxed without genpts; an `.mkv` labelled audio
  whose video stream reads `0/0` is remuxed (genpts, the "Tdarr labels this file audio" log line); a
  real-format TS record (audio first, `0/0` H.264 video later) is remuxed; missing `ffProbeData` is "not a
  video".
- Unit tests `tests/add_suffix.test.js` (stubbed `fs.renameSync`, literal POSIX paths): a `.ts` whose
  ExifTool extension is `m2t` keeps `.ts`; `.mkv` keeps `.mkv`; a trailing ` ()` is cleaned; an
  already-suffixed name isn't renamed; a dotted name (`Mr. Robot - S01E01.mkv`) and an upper-case extension
  (`UPPER.MKV`) are kept intact; a record without `meta` is still renamed.
- After deployment, the seven conversions are verified as above.
