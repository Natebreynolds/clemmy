import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { test } from 'node:test';
import os from 'node:os';
import path from 'node:path';
import {
  V314_RELEASE,
  runV314UpgradeRehearsal,
} from './rehearse-v314-upgrade.mts';

test('v3.14.0 release provenance is pinned to the published peeled commit and tree', () => {
  assert.deepEqual(V314_RELEASE, {
    tag: 'v3.14.0',
    commit: '18c5bcc72c921da2855fedea88509c2f5e6b7237',
    tree: '0673704264723e2acb43c4c3820a1d15787b4c7d',
    packageVersion: '3.14.0',
    schemas: {
      harness: 20,
      memory: 32,
      workspace: 3,
      workflowTrigger: 4,
    },
  });
});

test('rehearsal hard-refuses the real Clementine home before touching it', async () => {
  const liveHome = path.join(os.homedir(), '.clementine-next');
  await assert.rejects(
    runV314UpgradeRehearsal({ rehearsalRoot: liveHome }),
    /must resolve below the OS temp directory|must never address the live Clementine home/,
  );
});

test('exact v3.14 APIs seed a disposable home and current store boots migrate it exactly once', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'clem-v314-upgrade-test-'));
  try {
    const report = await runV314UpgradeRehearsal({ rehearsalRoot: root, keep: true });
    assert.equal(report.ok, true, JSON.stringify(report.checks.filter((check) => !check.ok), null, 2));
    assert.equal(report.checks.length, 16);
    assert.equal(report.checks.every((check) => check.ok), true);
    assert.equal(report.dependencyProof.normalizedLockGraphEqual, true);
    assert.equal(existsSync(report.paths.immutableSnapshot), true, 'rollback snapshot remains recoverable');
    assert.equal(existsSync(report.paths.migratedHome), true);
    assert.equal(existsSync(report.paths.report), true);

    const harness = report.firstBoot.sqlite['state/harness.db'];
    const memory = report.firstBoot.sqlite['state/memory.db'];
    const workspace = report.firstBoot.sqlite['state/workspaces.db'];
    assert.ok((harness.schemaVersions?.at(-1) ?? 0) >= 52, 'reaches the current harness schema');
    assert.equal(memory.schemaVersions?.at(-1), 34);
    assert.equal(workspace.userVersion, 5);
    assert.deepEqual(report.before.carriers, report.firstBoot.carriers);
    assert.deepEqual(report.firstBoot, report.secondBoot);
  } finally {
    const resolved = path.resolve(root);
    const temp = path.resolve(os.tmpdir());
    assert.ok(resolved.startsWith(`${temp}${path.sep}`));
    rmSync(resolved, { recursive: true, force: true });
  }
});
