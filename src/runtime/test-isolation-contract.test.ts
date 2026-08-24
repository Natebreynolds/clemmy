import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const runnerPath = new URL('../../scripts/run-tests-isolated.mjs', import.meta.url);
const preloadPath = new URL('../../scripts/test-isolation-preload.mjs', import.meta.url);
const argsPath = new URL('../../scripts/run-tests-isolated-args.mjs', import.meta.url);
const configPath = new URL('../config.ts', import.meta.url);
const fusionReadinessPath = new URL('../../scripts/smoke-fusion-readiness.ts', import.meta.url);
const semanticsCanaryPath = new URL('./semantic-boundary/semantics-only-canary.mts', import.meta.url);

test('repository tests run with real local embedding warmup disabled', () => {
  assert.equal(process.env.CLEMMY_TEST_ISOLATED_HOME, '1');
  assert.equal(process.env.CLEMMY_LOCAL_EMBEDDINGS, 'off');

  const runnerSource = readFileSync(runnerPath, 'utf8');
  assert.match(runnerSource, /CLEMMY_LOCAL_EMBEDDINGS:\s*'off'/);
});

test('isolated runner preloads test isolation before any BASE_DIR capture', () => {
  const argsSource = readFileSync(argsPath, 'utf8');
  assert.match(argsSource, /test-isolation-preload\.mjs/);
  assert.match(argsSource, /--import/);
  const preloadSource = readFileSync(preloadPath, 'utf8');
  assert.match(preloadSource, /CLEMENTINE_HOME/);
  assert.match(preloadSource, /CLEMMY_ALLOW_LIVE_HOME_TESTS/);
  const configSource = readFileSync(configPath, 'utf8');
  assert.match(configSource, /CLEMMY_ALLOW_LIVE_HOME_TESTS/);
  assert.match(configSource, /REAL_DEFAULT_CLEMENTINE_HOME/);
});

test('this process is not bound to the live Clementine home', async () => {
  const { BASE_DIR, REAL_DEFAULT_CLEMENTINE_HOME } = await import('../config.js');
  assert.notEqual(path.resolve(BASE_DIR), path.resolve(REAL_DEFAULT_CLEMENTINE_HOME));
});

test('offline Fusion readiness never loads the real local embedding model', () => {
  const smokeSource = readFileSync(fusionReadinessPath, 'utf8');
  assert.match(smokeSource, /process\.env\.CLEMMY_LOCAL_EMBEDDINGS\s*=\s*'off'/);
  assert.match(smokeSource, /REAL_LOCAL_EMBEDDINGS/);
});

test('semantics canary never discovers credentials from the live user home', () => {
  const source = readFileSync(semanticsCanaryPath, 'utf8');
  assert.doesNotMatch(source, /os\.homedir\(\)/);
  assert.doesNotMatch(source, /\.clementine-next['"`],\s*['"`]\.env/);
  assert.match(source, /CLEM_CANARY_ENV_FILE/);
  assert.match(source, /process\.env\.CLEMENTINE_HOME\s*=\s*isolated/);
});
