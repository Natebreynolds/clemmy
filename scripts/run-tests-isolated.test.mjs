import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_TEST_TARGETS,
  isolatedTestArgs,
} from './run-tests-isolated-args.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runnerPath = path.join(repoRoot, 'scripts', 'run-tests-isolated.mjs');

test('isolated test runner retains source-only defaults when only reporter options are forwarded', () => {
  assert.deepEqual(
    isolatedTestArgs(['--test-reporter=dot']),
    ['--test', '--test-reporter=dot', ...DEFAULT_TEST_TARGETS],
  );
  assert.deepEqual(
    isolatedTestArgs(['--test-reporter', 'dot']),
    ['--test', '--test-reporter', 'dot', ...DEFAULT_TEST_TARGETS],
  );
});

test('isolated test runner preserves an explicit targeted test without adding the full suite', () => {
  assert.deepEqual(
    isolatedTestArgs(['--test-reporter=spec', 'apps/desktop/src/workspace-navigation-policy.test.ts']),
    ['--test', '--test-reporter=spec', 'apps/desktop/src/workspace-navigation-policy.test.ts'],
  );
});

test('isolated test runner contains home, provider, and nested temp state', () => {
  const fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'clemmy-runner-contract-'));
  const fixturePath = path.join(fixtureDir, 'environment.test.mjs');
  writeFileSync(fixturePath, `
    import { test } from 'node:test';
    import assert from 'node:assert/strict';
    import os from 'node:os';
    import path from 'node:path';

    test('receives the safe isolated environment', () => {
      assert.equal(process.env.CLEMMY_LOCAL_EMBEDDINGS, 'off');
      assert.equal(process.env.CLEMMY_TEST_DISABLE_LIVE_MODELS, '1');
      assert.equal(process.env.CLEMMY_TEST_ISOLATED_HOME, '1');
      assert.match(process.env.CLEMENTINE_HOME ?? '', /clementine-test-home-/);
      assert.equal(os.tmpdir(), path.join(process.env.CLEMENTINE_HOME, 'tmp'));
      assert.equal(process.env.TMPDIR, os.tmpdir());
      assert.equal(process.env.TMP, os.tmpdir());
      assert.equal(process.env.TEMP, os.tmpdir());
    });
  `);

  try {
    const result = spawnSync(process.execPath, [runnerPath, fixturePath], {
      cwd: repoRoot,
      env: {
        ...process.env,
        CLEMMY_LOCAL_EMBEDDINGS: 'on',
      },
      encoding: 'utf8',
    });
    assert.equal(
      result.status,
      0,
      `isolated runner failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});
