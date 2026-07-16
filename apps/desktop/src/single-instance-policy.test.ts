import { test } from 'node:test';
import assert from 'node:assert/strict';

import { acquireSingleInstanceLock, resolveIsolatedDevUserDataPath } from './single-instance-policy.js';

test('packaged builds cannot bypass Electron single-instance locking through the dev flag', () => {
  let lockRequests = 0;
  const acquired = acquireSingleInstanceLock(true, '/tmp/isolated/electron-user-data', () => {
    lockRequests += 1;
    return false;
  });

  assert.equal(acquired, false);
  assert.equal(lockRequests, 1);
});

test('only a genuinely isolated unpackaged profile bypasses locking', () => {
  let lockRequests = 0;
  const defaultHome = '/Users/example/.clementine-next';
  const isolated = resolveIsolatedDevUserDataPath(
    false,
    '1',
    '/tmp/clementine-rc',
    defaultHome,
  );
  assert.equal(isolated, '/tmp/clementine-rc/electron-user-data');
  assert.equal(acquireSingleInstanceLock(false, isolated, () => {
    lockRequests += 1;
    return false;
  }), true);
  assert.equal(lockRequests, 0);

  for (const candidate of [
    resolveIsolatedDevUserDataPath(false, undefined, '/tmp/clementine-rc', defaultHome),
    resolveIsolatedDevUserDataPath(false, '', '/tmp/clementine-rc', defaultHome),
    resolveIsolatedDevUserDataPath(false, 'true', '/tmp/clementine-rc', defaultHome),
    resolveIsolatedDevUserDataPath(false, '1', undefined, defaultHome),
    resolveIsolatedDevUserDataPath(false, '1', defaultHome, defaultHome),
  ]) {
    assert.equal(candidate, null);
    assert.equal(acquireSingleInstanceLock(false, candidate, () => {
      lockRequests += 1;
      return false;
    }), false);
  }
  assert.equal(lockRequests, 5);
});
