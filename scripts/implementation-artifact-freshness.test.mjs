import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  assertImplementationArtifactsCurrent,
  emitImplementationArtifacts,
} from './emit-implementation-artifacts.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const emitScript = fileURLToPath(new URL('./emit-implementation-artifacts.mjs', import.meta.url));
const devUp = readFileSync(new URL('./dev-up.sh', import.meta.url), 'utf8');

test('dev-up emits artifacts before candidate capture and verifies them before launch', () => {
  const emitAt = devUp.indexOf(
    'node scripts/emit-implementation-artifacts.mjs "$IMPLEMENTATION_ARTIFACT_ROOT"',
  );
  const dirtyAt = devUp.indexOf('EXPECTED_GIT_DIRTY=false');
  const fingerprintAt = devUp.indexOf('EXPECTED_RUNTIME_JSON=');
  const verifyAt = devUp.indexOf(
    'node scripts/emit-implementation-artifacts.mjs --verify-current "$IMPLEMENTATION_ARTIFACT_ROOT"',
  );
  const validationAt = devUp.indexOf('case "$DEV_TURN_ENGINE"');
  const stopAt = devUp.indexOf(
    '\nstop_owned_daemon_and_wait\n',
    devUp.indexOf('echo "→ quitting installed app'),
  );
  const pinAt = devUp.indexOf(
    'export CLEMMY_IMPLEMENTATION_ARTIFACT_ROOT="$IMPLEMENTATION_ARTIFACT_ROOT"',
  );
  const launchAt = devUp.indexOf('node --import tsx src/index.ts daemon start');

  assert.ok(emitAt >= 0, 'dev-up does not emit implementation artifacts');
  assert.ok(validationAt >= 0 && validationAt < stopAt, 'model environment is not validated before stopping the daemon');
  assert.ok(stopAt >= 0 && emitAt > stopAt, 'artifact pruning can run while the old daemon is live');
  assert.ok(dirtyAt > emitAt, 'git dirty state is captured before artifact emission');
  assert.ok(fingerprintAt > emitAt, 'source is fingerprinted before artifact emission');
  assert.ok(verifyAt > fingerprintAt, 'artifact currentness is not checked against the captured candidate');
  assert.ok(pinAt > verifyAt, 'the verified implementation root is not pinned into the daemon launch');
  assert.ok(launchAt > verifyAt, 'the daemon can start before artifact currentness is established');
  assert.ok(launchAt > pinAt, 'the daemon can inherit an unverified implementation root');
});

test('a disposable emission is source-current and carries checkpoint schema inputs', async () => {
  const outDir = mkdtempSync(path.join(os.tmpdir(), 'clem-artifact-freshness-test-'));
  try {
    const manifest = await emitImplementationArtifacts(outDir);
    const verification = spawnSync(process.execPath, [emitScript, '--verify-current', outDir], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    assert.equal(verification.status, 0, verification.stderr || verification.stdout);
    assert.equal(JSON.parse(verification.stdout).verifiedCurrent, true);

    for (const relativePath of [
      'src/runtime/harness/schema-version.ts',
      'src/runtime/harness/logical-model-result-projection-receipt.ts',
    ]) {
      const expectedBytes = statSync(path.join(repoRoot, relativePath)).size;
      const carryingKinds = Object.entries(manifest.artifacts)
        .filter(([, artifact]) => artifact.inputs?.[relativePath]?.bytes === expectedBytes)
        .map(([kind]) => kind)
        .sort();
      // Checkpoint schema belongs to the invoke/reconcile authority boundary.
      // Observer and physical transport artifacts are intentionally
      // storage-free; transport-leaf-closure.test.ts separately pins that they
      // cannot import the event-log/native-DB graph.
      assert.deepEqual(
        carryingKinds,
        ['invoke', 'reconcile'],
        `${relativePath} is absent or stale in the executable manifest input inventory`,
      );
    }
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('currentness verification rejects a stale source-input inventory', async () => {
  const outDir = mkdtempSync(path.join(os.tmpdir(), 'clem-artifact-stale-test-'));
  try {
    const manifest = await emitImplementationArtifacts(outDir);
    const schemaPath = 'src/runtime/harness/schema-version.ts';
    manifest.artifacts.invoke.inputs[schemaPath].bytes -= 1;
    writeFileSync(
      path.join(outDir, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    await assert.rejects(
      assertImplementationArtifactsCurrent(outDir),
      /not current for this source tree/,
    );
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
