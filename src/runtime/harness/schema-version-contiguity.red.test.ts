import test from 'node:test';
import assert from 'node:assert/strict';

import { harnessSchemaRowsAreContiguous } from '../build-info.js';

test('schema readiness requires every migration row, not only MAX(version)', () => {
  assert.equal(harnessSchemaRowsAreContiguous({ minVersion: 1, maxVersion: 37, versionCount: 37 }, 37), true);
  assert.equal(harnessSchemaRowsAreContiguous({ minVersion: 1, maxVersion: 37, versionCount: 36 }, 37), false);
  assert.equal(harnessSchemaRowsAreContiguous({ minVersion: 2, maxVersion: 37, versionCount: 36 }, 37), false);
  assert.equal(harnessSchemaRowsAreContiguous({ minVersion: 1, maxVersion: 36, versionCount: 36 }, 37), false);
});
