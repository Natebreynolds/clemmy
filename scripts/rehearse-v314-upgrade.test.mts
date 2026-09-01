import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { test } from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  SCHEMA_V69_MODEL_RESULT_PROJECTION_RECEIPT_COLUMNS,
  V314_RELEASE,
  installedPackageGraphCoversTag,
  normalizedInstalledPackageGraph,
  runV314UpgradeRehearsal,
} from './rehearse-v314-upgrade.mts';

function discoveredMcpServerNames(home: string): string[] {
  const moduleUrl = pathToFileURL(
    path.join(process.cwd(), 'src', 'runtime', 'mcp-config.ts'),
  ).href;
  const child = spawnSync(process.execPath, [
    '--import',
    'tsx',
    '--input-type=module',
    '--eval',
    [
      `const { discoverMcpServers } = await import(${JSON.stringify(moduleUrl)});`,
      'process.stdout.write(JSON.stringify(discoverMcpServers().map((server) => server.name)));',
    ].join('\n'),
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      CLEMENTINE_HOME: home,
      CLEMMY_TEST_ISOLATED_HOME: '1',
      MCP_AUTO_IMPORT_ENABLED: 'false',
    },
    encoding: 'utf8',
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  return JSON.parse(child.stdout) as string[];
}

test('dependency proof ignores only root request metadata, never installed package drift', () => {
  const tag = {
    name: 'clemmy',
    version: '3.14.0',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { version: '3.14.0', dependencies: { parent: '^1.0.0' } },
      'node_modules/parent': { version: '1.0.0', dependencies: { shared: '2.0.0' } },
      'node_modules/shared': { version: '2.0.0', integrity: 'sha512-exact' },
    },
  };
  const promoted = structuredClone(tag);
  promoted.version = '3.16.0';
  promoted.packages[''].version = '3.16.0';
  promoted.packages[''].dependencies.shared = '^2.0.0';
  assert.deepEqual(
    normalizedInstalledPackageGraph(promoted),
    normalizedInstalledPackageGraph(tag),
    'promoting an already-identical installed package does not change the execution dependency set',
  );

  const drifted = structuredClone(promoted);
  drifted.packages['node_modules/shared'].version = '2.0.1';
  assert.notDeepEqual(
    normalizedInstalledPackageGraph(drifted),
    normalizedInstalledPackageGraph(tag),
    'any non-root installed package drift still fails the exact-tag proof',
  );
});

test('dependency proof covers the tag graph: extras are allowed, changed or missing tag packages are not', () => {
  const tag = {
    name: 'clemmy', version: '3.14.0',
    packages: {
      '': { name: 'clemmy', version: '3.14.0' },
      'node_modules/a': { version: '1.0.0', resolved: 'https://r/a-1.0.0.tgz', integrity: 'sha512-a' },
      'node_modules/b': { version: '2.0.0', resolved: 'https://r/b-2.0.0.tgz', integrity: 'sha512-b', dependencies: { a: '^1.0.0' } },
    },
  };
  const superset = structuredClone(tag) as typeof tag & { packages: Record<string, unknown> };
  superset.version = '3.16.0';
  superset.packages['node_modules/c'] = { version: '9.9.9', resolved: 'https://r/c-9.9.9.tgz', integrity: 'sha512-c' };
  const covered = installedPackageGraphCoversTag(tag, superset);
  assert.deepEqual(covered, { covered: true, missingPackages: [], changedPackages: [], extraPackages: ['node_modules/c'] });

  const changed = structuredClone(tag) as typeof tag & { packages: Record<string, { version: string }> };
  changed.packages['node_modules/a'].version = '1.0.1';
  const drift = installedPackageGraphCoversTag(tag, changed);
  assert.equal(drift.covered, false);
  assert.deepEqual(drift.changedPackages, ['node_modules/a']);

  const missing = structuredClone(tag) as typeof tag & { packages: Record<string, unknown> };
  delete missing.packages['node_modules/b'];
  const gone = installedPackageGraphCoversTag(tag, missing);
  assert.equal(gone.covered, false);
  assert.deepEqual(gone.missingPackages, ['node_modules/b']);
});

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

test('the v3.16 rehearsal pins schema 69 projection receipts to metadata columns only', () => {
  assert.deepEqual(SCHEMA_V69_MODEL_RESULT_PROJECTION_RECEIPT_COLUMNS, [
    'accepted_task_id',
    'batch_id',
    'batch_ordinal',
    'call_id',
    'call_namespace',
    'protocol_version',
    'receipt_id',
    'recorded_at',
    'result_class',
    'result_item_bytes',
    'result_item_sha256',
    'session_id',
    'settlement_event_id',
    'settlement_identity_kind',
    'settlement_logical_tool_call_id',
    'settlement_observer_call_id',
    'settlement_semantic_digest',
    'source_event_id',
    'source_user_seq',
    'tool_name',
  ]);
  assert.equal(
    SCHEMA_V69_MODEL_RESULT_PROJECTION_RECEIPT_COLUMNS.some((column) =>
      /(?:payload|content|output|result_json|data_json)/i.test(column)),
    false,
    'schema 69 must never grow a second copy of provider/model result bytes',
  );
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
    assert.equal(report.checks.length, 18);
    assert.equal(report.checks.every((check) => check.ok), true);
    assert.equal(report.dependencyProof.tagGraphCovered, true, 'every v3.14.0 package must be present at its exact entry');
    assert.equal(typeof report.dependencyProof.normalizedLockGraphEqual, 'boolean');
    assert.ok(Array.isArray(report.dependencyProof.extraPackages));
    assert.equal(existsSync(report.paths.immutableSnapshot), true, 'rollback snapshot remains recoverable');
    assert.equal(existsSync(report.paths.migratedHome), true);
    assert.equal(existsSync(report.paths.report), true);
    const exactMcpConfig = JSON.parse(readFileSync(
      path.join(report.paths.immutableSnapshot, 'mcp', 'servers.json'),
      'utf8',
    )) as unknown;
    assert.deepEqual(exactMcpConfig, {}, 'the exact v3.14 blank registry is a root server-name map');
    assert.deepEqual(
      discoveredMcpServerNames(report.paths.immutableSnapshot),
      [],
      'the fixture must not invent an enabled native_mcp:servers adapter',
    );

    const harness = report.firstBoot.sqlite['state/harness.db'];
    const memory = report.firstBoot.sqlite['state/memory.db'];
    const workspace = report.firstBoot.sqlite['state/workspaces.db'];
    assert.equal(report.currentSchemas.harness, 74, 'the current candidate is released against harness schema 74');
    assert.equal(
      harness.schemaVersions?.at(-1),
      report.currentSchemas.harness,
      'reaches the exact current harness schema',
    );
    assert.equal(memory.schemaVersions?.at(-1), report.currentSchemas.memory);
    assert.equal(workspace.userVersion, report.currentSchemas.workspace);
    assert.deepEqual(
      harness.tableColumns.logical_model_result_projection_receipts,
      SCHEMA_V69_MODEL_RESULT_PROJECTION_RECEIPT_COLUMNS,
    );
    assert.equal(harness.tableCounts.logical_model_result_projection_receipts, 0);
    assert.equal(
      report.secondBoot.sqlite['state/harness.db']
        .tableCounts.logical_model_result_projection_receipts,
      0,
      'the v3.14 fixture has no accepted current-model result, so migration cannot invent a receipt',
    );
    assert.deepEqual(report.before.carriers, report.firstBoot.carriers);
    assert.deepEqual(report.firstBoot, report.secondBoot);
  } finally {
    const resolved = path.resolve(root);
    const temp = path.resolve(os.tmpdir());
    assert.ok(resolved.startsWith(`${temp}${path.sep}`));
    rmSync(resolved, { recursive: true, force: true });
  }
});
