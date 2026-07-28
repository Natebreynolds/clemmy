import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runnerPath = path.join(repoRoot, 'scripts', 'run-tests-isolated.mjs');

test('isolated test runner disables real local embeddings even when the parent enables them', () => {
  const fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'clemmy-runner-contract-'));
  const fixturePath = path.join(fixtureDir, 'environment.test.mjs');
  writeFileSync(fixturePath, `
    import { test } from 'node:test';
    import assert from 'node:assert/strict';

    test('receives the safe isolated environment', () => {
      assert.equal(process.env.CLEMMY_LOCAL_EMBEDDINGS, 'off');
      assert.equal(process.env.CLEMMY_TEST_DISABLE_LIVE_MODELS, '1');
      assert.equal(process.env.CLEMMY_TEST_ISOLATED_HOME, '1');
      assert.match(process.env.CLEMENTINE_HOME ?? '', /clementine-test-home-/);
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
