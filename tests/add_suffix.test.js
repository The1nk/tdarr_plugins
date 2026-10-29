const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const path = require('path');

// The plugin does require('../methods/lib') (Tdarr's runtime) and require('fs'). Stub both.
let stubs = null;
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '../methods/lib') {
    return () => ({ loadDefaultValues: (inputs) => inputs || {} });
  }
  if (stubs && Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
  return origLoad.call(this, request, parent, isMain);
};

const suffix = require(path.join(__dirname, '..', 'Tdarr_Plugin_the1nk_add_suffix_to_filename.js'));

const run = (file) => {
  const renames = [];
  stubs = { fs: { renameSync: (from, to) => renames.push([from, to]) } };
  try {
    const res = suffix.plugin(file, {}, { suffix: ' (Tdarr)' }, {});
    return { res, renames };
  } finally {
    stubs = null;
  }
};

test('add suffix: a .ts that ExifTool calls m2t keeps .ts', () => {
  const old = '/temp/w/Space King - S01E02 - House of a Thousand Furries.ts';
  const file = { _id: old, fileNameWithoutExtension: 'Space King - S01E02 - House of a Thousand Furries',
    meta: { Directory: '/temp/w', FileTypeExtension: 'm2t' } };
  const { res, renames } = run(file);
  const expected = '/temp/w/Space King - S01E02 - House of a Thousand Furries (Tdarr).ts';
  assert.strictEqual(res.file._id, expected);
  assert.deepStrictEqual(renames, [[old, expected]]);
  assert.strictEqual(res.updateDB, true);
  assert.ok(res.infoLog.includes('extension is .ts'), res.infoLog);
});

test('add suffix: an .mkv keeps .mkv', () => {
  const file = { _id: '/m/Movie.mkv', fileNameWithoutExtension: 'Movie',
    meta: { Directory: '/m', FileTypeExtension: 'mkv' } };
  const { res } = run(file);
  assert.ok(res.file._id.endsWith(' (Tdarr).mkv'), res.file._id);
});

test('add suffix: a trailing empty () is cleaned', () => {
  const file = { _id: '/m/Good Boy (2025) {imdb-tt35521922} ().mkv',
    fileNameWithoutExtension: 'Good Boy (2025) {imdb-tt35521922} ()',
    meta: { Directory: '/m', FileTypeExtension: 'mkv' } };
  const { res } = run(file);
  assert.strictEqual(res.file._id, '/m/Good Boy (2025) {imdb-tt35521922} (Tdarr).mkv');
});

test('add suffix: an already-suffixed name is not renamed', () => {
  const file = { _id: '/m/Movie (Tdarr).mkv', fileNameWithoutExtension: 'Movie (Tdarr)',
    meta: { Directory: '/m', FileTypeExtension: 'mkv' } };
  const { res, renames } = run(file);
  assert.deepStrictEqual(renames, []);
  assert.strictEqual(res.updateDB, false);
});

test('add suffix: a dotted name keeps its dots and extension', () => {
  const file = { _id: '/m/Mr. Robot - S01E01.mkv', fileNameWithoutExtension: 'Mr. Robot - S01E01',
    meta: { Directory: '/m', FileTypeExtension: 'mkv' } };
  assert.strictEqual(run(file).res.file._id, '/m/Mr. Robot - S01E01 (Tdarr).mkv');
});

test('add suffix: an upper-case extension is kept as it is', () => {
  const file = { _id: '/m/UPPER.MKV', fileNameWithoutExtension: 'UPPER', meta: { Directory: '/m', FileTypeExtension: 'mkv' } };
  assert.strictEqual(run(file).res.file._id, '/m/UPPER (Tdarr).MKV');
});

test('add suffix: a file record without meta is still renamed', () => {
  const file = { _id: '/m/Movie.mkv', fileNameWithoutExtension: 'Movie' };
  const { res, renames } = run(file);
  assert.deepStrictEqual(renames, [['/m/Movie.mkv', '/m/Movie (Tdarr).mkv']]);
  assert.strictEqual(res.updateDB, true);
  assert.strictEqual(res.error, undefined);
});
