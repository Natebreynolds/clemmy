import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const buildScript = readFileSync(new URL('./build-candidate.mjs', import.meta.url), 'utf8');
const stampScript = readFileSync(new URL('./write-build-stamp.mjs', import.meta.url), 'utf8');

test('candidate builds fail closed if source bytes move while TypeScript compiles', () => {
  assert.match(pkg.scripts.build, /build-candidate\.mjs/);
  assert.match(buildScript, /fingerprintBefore/);
  assert.match(buildScript, /fingerprintAfter/);
  assert.match(buildScript, /source changed during candidate build/);
  assert.match(stampScript, /CLEMENTINE_BUILD_SOURCE_FINGERPRINT/);
});
