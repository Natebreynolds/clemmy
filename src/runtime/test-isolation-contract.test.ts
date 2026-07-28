import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const runnerPath = new URL('../../scripts/run-tests-isolated.mjs', import.meta.url);
const fusionReadinessPath = new URL('../../scripts/smoke-fusion-readiness.ts', import.meta.url);

test('repository tests run with real local embedding warmup disabled', () => {
  assert.equal(process.env.CLEMMY_TEST_ISOLATED_HOME, '1');
  assert.equal(process.env.CLEMMY_LOCAL_EMBEDDINGS, 'off');

  const runnerSource = readFileSync(runnerPath, 'utf8');
  assert.match(runnerSource, /CLEMMY_LOCAL_EMBEDDINGS:\s*'off'/);
});

test('offline Fusion readiness never loads the real local embedding model', () => {
  const smokeSource = readFileSync(fusionReadinessPath, 'utf8');
  assert.match(smokeSource, /process\.env\.CLEMMY_LOCAL_EMBEDDINGS\s*=\s*'off'/);
  assert.match(smokeSource, /REAL_LOCAL_EMBEDDINGS/);
});
