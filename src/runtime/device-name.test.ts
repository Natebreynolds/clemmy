import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeDevice } from './device-name.js';

const WKWEBVIEW = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const MAC_CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

test('the native shell on an iPhone is named as the Clem app, Safari as Safari', () => {
  assert.equal(describeDevice(WKWEBVIEW).name, 'iPhone · Clem app');
  assert.equal(describeDevice(SAFARI).name, 'iPhone · Safari');
  assert.equal(describeDevice(MAC_CHROME).name, 'Mac · Chrome');
});

test('an older label cut at 80 characters names the platform only, never the app', () => {
  const cut = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHT';
  assert.equal(cut.length, 80);
  assert.equal(describeDevice(cut).name, 'iPhone');
});

test('a chosen label is kept as written; an empty one is called out', () => {
  assert.deepEqual(describeDevice('CLEMMY LIVE C8 HTTP proof').derived, false);
  assert.equal(describeDevice('CLEMMY LIVE C8 HTTP proof').name, 'CLEMMY LIVE C8 HTTP proof');
  assert.equal(describeDevice('').name, 'Unnamed device');
});
