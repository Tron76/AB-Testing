'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseGoProName, compareGoPro } = require('../lib/gopro');

test('parses modern GoPro names', () => {
  assert.deepStrictEqual(parseGoProName('GX010123.MP4'), { recording: 123, chapter: 1 });
  assert.deepStrictEqual(parseGoProName('gh020045.mp4'), { recording: 45, chapter: 2 });
});

test('parses legacy GoPro names', () => {
  assert.deepStrictEqual(parseGoProName('GOPR0007.MP4'), { recording: 7, chapter: 0 });
  assert.deepStrictEqual(parseGoProName('GP010007.MP4'), { recording: 7, chapter: 1 });
});

test('returns null for other names', () => {
  assert.strictEqual(parseGoProName('holiday.mp4'), null);
});

test('sorts by recording then chapter, others last', () => {
  const names = ['zz.mp4', 'GX020100.MP4', 'GP010050.MP4', 'GX010100.MP4', 'GOPR0050.MP4', 'clip2.mp4', 'clip10.mp4'];
  assert.deepStrictEqual(names.sort(compareGoPro), [
    'GOPR0050.MP4', 'GP010050.MP4', 'GX010100.MP4', 'GX020100.MP4', 'clip2.mp4', 'clip10.mp4', 'zz.mp4',
  ]);
});
