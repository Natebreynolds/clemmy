import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appPlaceHref, appGuidanceHref } from '../../../../packages/chat-engine/src/app-places';
import { connectAreaForHash } from './connect-navigation';

test('existing saved connection destinations reveal their actual setup area', () => {
  for (const hash of ['#phone', '#computer', '#channels']) {
    assert.equal(connectAreaForHash(hash), 'devices', hash);
  }
  for (const hash of ['#accounts', '#plugins', '#tools', '#folders']) {
    assert.equal(connectAreaForHash(hash), 'advanced', hash);
  }
  assert.equal(connectAreaForHash('#apps'), 'apps');
});

test('Clem’s canonical phone links open Devices rather than a hidden pairing panel', () => {
  for (const href of [appPlaceHref('phone', 'desktop'), appGuidanceHref('phone', 'desktop')]) {
    assert.ok(href);
    const target = new URL(href, 'https://clem.example.test');
    assert.equal(target.pathname, '/connect');
    assert.equal(connectAreaForHash(target.hash), 'devices');
  }
  assert.equal(appPlaceHref('model-accounts', 'desktop'), '/settings#accounts');
});

test('ordinary navigation and unknown fragments safely open the app inventory', () => {
  assert.equal(connectAreaForHash('#devices'), 'devices');
  assert.equal(connectAreaForHash('#advanced'), 'advanced');
  for (const hash of ['', '#', '#missing', '#%ZZ', '#__proto__']) {
    assert.equal(connectAreaForHash(hash), 'apps', hash);
  }
});
