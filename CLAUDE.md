# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Deployment

`path.env` holds the path to the local Tdarr plugins directory (network share). This file is gitignored.

- **Pull from Tdarr** (copy all `.js` files from the Tdarr plugins dir into this repo): `./pull.ps1`
- **Push to Tdarr** (copy all `.js` files from this repo into the Tdarr plugins dir): `./push.ps1`

There is no build step, linter config, or test runner configured in this repo.

## Plugin Architecture

Each plugin is a standalone `.js` file named `Tdarr_Plugin_<author>_<description>.js`. Every plugin exports two things:

```js
module.exports.details = details;  // metadata function
module.exports.plugin = plugin;    // main logic function
```

### `details()` — metadata

Returns an object with:
- `id` — must match filename (without `.js`)
- `Stage` — `'Pre-processing'` or `'Post-processing'`
- `Type` — `'Video'` or `'Audio'`
- `Operation` — `'Transcode'` or `'Filter'`
- `Inputs` — array of configurable user inputs (name, type, defaultValue, inputUI, tooltip)

### `plugin(file, librarySettings, inputs, otherArguments)` — main logic

Always begins with:
```js
const lib = require('../methods/lib')();
inputs = lib.loadDefaultValues(inputs, details);
```

**Pre-processing plugins** return a `response` object with:
- `processFile` (bool) — whether Tdarr should process the file
- `preset` (string) — FFmpeg arguments; format is `<io> [flags]` or `, [flags]`
- `FFmpegMode` (bool)
- `handBrakeMode` (bool)
- `reQueueAfter` (bool) — re-queue file after processing
- `container` (string) — output container e.g. `.mkv`
- `infoLog` (string) — logged output shown in Tdarr UI

**Post-processing plugins** return a `response` object with:
- `file` — the file object (modify `file._id` to rename)
- `removeFromDB` (bool)
- `updateDB` (bool) — set true if `file._id` was changed
- `infoLog` (string)

### Filter vs Transcode plugins

**Filter plugins** (`Operation: 'Filter'`) only set `processFile` true/false to control whether the plugin stack continues. They don't transcode.

**Transcode plugins** build an FFmpeg `preset` string. Pre-processing presets use `<io>` as a placeholder for input/output file args. Post-processing plugins use `spawnSync` or filesystem operations directly.

### Preventing reprocessing loops

Use a custom FFmpeg metadata tag (e.g., `TDARR_DRC_PROCESSED=1`) written during transcoding, then check `file.ffProbeData.format.tags` at the start of the plugin to skip already-processed files. Tag names must be uppercase.

### `tdarrSkipTest` comment

Adding `// tdarrSkipTest` near the top of a plugin file tells Tdarr's test runner to skip automated testing of that plugin. Use this for post-processing plugins that perform filesystem operations or run external processes.
