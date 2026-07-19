import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';

import {
  parseNotchClickHelperEvent,
  resolveNotchClickHelperPath,
  toDisplayLocalNotchFrame,
} from './notch-click-helper.js';

test('accepts only the bounded, versioned native helper protocol', () => {
  assert.deepEqual(parseNotchClickHelperEvent('{"type":"ready","protocol":1}'), {
    type: 'ready',
    protocol: 1,
  });
  assert.deepEqual(
    parseNotchClickHelperEvent('{"type":"activate","protocol":1,"seq":7,"source":"global"}'),
    { type: 'activate', protocol: 1, seq: 7, source: 'global' },
  );
  assert.deepEqual(parseNotchClickHelperEvent('{"type":"hover","protocol":1,"active":true}'), {
    type: 'hover',
    protocol: 1,
    active: true,
  });
  assert.deepEqual(
    parseNotchClickHelperEvent('{"type":"anchor","protocol":1,"displayId":1,"x":586,"y":0,"topInset":32}'),
    { type: 'anchor', protocol: 1, displayId: 1, x: 586, y: 0, topInset: 32 },
  );
  assert.equal(parseNotchClickHelperEvent('{"type":"activate","protocol":2,"seq":7,"source":"global"}'), null);
  assert.equal(parseNotchClickHelperEvent('{"type":"activate","protocol":1,"seq":7,"source":"global","extra":true}'), null);
  assert.equal(parseNotchClickHelperEvent('not-json'), null);
  assert.equal(parseNotchClickHelperEvent('x'.repeat(4_097)), null);
});

test('resolves the helper inside packaged Resources without using PATH', () => {
  assert.equal(
    resolveNotchClickHelperPath({ isPackaged: true, resourcesPath: '/Applications/Clementine.app/Contents/Resources' }),
    path.join('/Applications/Clementine.app/Contents/Resources', 'notch-helper', 'ClementineNotchHelper'),
  );
  assert.match(
    resolveNotchClickHelperPath({ isPackaged: false }),
    /native[/\\]notch-click-helper[/\\]\.build[/\\]ClementineNotchHelper$/,
  );
});

test('converts global Electron frames to display-local points on any display origin', () => {
  assert.deepEqual(
    toDisplayLocalNotchFrame(
      { x: -1334, y: -900, width: 62, height: 48 },
      { x: -1920, y: -1080 },
    ),
    { x: 586, y: 180, width: 62, height: 48 },
  );
});
