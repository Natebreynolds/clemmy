import test from 'node:test';
import assert from 'node:assert/strict';

import {
  harnessSchemaRowsAreContiguous,
  requireHarnessSchemaReady,
} from '../build-info.js';
import { HARNESS_SCHEMA_VERSION } from './schema-version.js';

// Readiness is checked against the canonical schema constant, so these cases
// track it rather than restating a literal that goes stale every migration.
const CURRENT = HARNESS_SCHEMA_VERSION;
const PRIOR = CURRENT - 1;

test('schema readiness requires every migration row, not only MAX(version)', () => {
  assert.equal(harnessSchemaRowsAreContiguous({ minVersion: 1, maxVersion: CURRENT, versionCount: CURRENT }, CURRENT), true);
  assert.equal(harnessSchemaRowsAreContiguous({ minVersion: 1, maxVersion: CURRENT, versionCount: PRIOR }, CURRENT), false);
  assert.equal(harnessSchemaRowsAreContiguous({ minVersion: 2, maxVersion: CURRENT, versionCount: PRIOR }, CURRENT), false);
  assert.equal(harnessSchemaRowsAreContiguous({ minVersion: 1, maxVersion: PRIOR, versionCount: PRIOR }, CURRENT), false);
});

test('daemon readiness refuses a non-contiguous or stale harness schema', () => {
  const base = {
    version: 'test',
    entry: 'test',
    packaged: false,
    expectedSchemaVersion: CURRENT,
  } as const;
  assert.throws(
    () => requireHarnessSchemaReady({ ...base, schemaVersion: 0 }),
    /Harness schema is not ready/,
  );
  assert.throws(
    () => requireHarnessSchemaReady({ ...base, schemaVersion: PRIOR }),
    new RegExp(`observed ${PRIOR}, expected ${CURRENT}`),
  );
  assert.doesNotThrow(() => requireHarnessSchemaReady({ ...base, schemaVersion: CURRENT }));
  // A build that expects a schema the runtime no longer ships is never ready.
  assert.throws(
    () => requireHarnessSchemaReady({
      ...base, expectedSchemaVersion: PRIOR, schemaVersion: PRIOR,
    }),
    /Harness schema is not ready/,
  );
});
