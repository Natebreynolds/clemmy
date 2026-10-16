/** Run: node scripts/run-tests-isolated.mjs src/runtime/harness/catalog-reviewed-cli-reconcile.test.ts */
import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-catalog-reviewed-cli-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.CLEMMY_AUTHORITY_SEAL_KEY = 'c7'.repeat(32);
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TEST_HOME, 'state'), { recursive: true });

const binDir = path.join(TEST_HOME, 'bin');
mkdirSync(binDir, { recursive: true });
const fakeSf = path.join(binDir, 'sf');
writeFileSync(fakeSf, [
  `#!${process.execPath}`,
  'const fs = require("node:fs");',
  'if (process.argv[2] === "data" && process.argv[3] === "query") {',
  '  process.stdout.write(JSON.stringify({ status: 0, result: { records: [{ Name: "Tim Deal" }] } }) + "\\n");',
  '  process.exit(0);',
  '}',
  'process.stdout.write("sf mock\\n");',
].join('\n'), 'utf8');
chmodSync(fakeSf, 0o700);
const spawnEnv = await import('../spawn-env.js');
// Daemon-side resolution walks augmentPath(PATH), which PREPENDS the well-known
// tool dirs (/usr/local/bin, /opt/homebrew/bin, ...) ahead of anything not
// already on PATH. On a host whose shell PATH lacks one of those dirs, a real
// `sf` installed there outranks this fixture and the reviewed read hashes the
// real binary. Augment first (idempotent), then put the fixture in front.
process.env.PATH = `${binDir}${path.delimiter}${spawnEnv.augmentPath(process.env.PATH)}`;

const catalog = await import('../../integrations/cli-catalog/catalog.js');
const reconcile = await import('./catalog-reviewed-cli-reconcile.js');
const config = await import('./reviewed-cli-read-config.js');
const acquisition = await import('./production-live-read-acquisition-registry.js');
const local = await import('./local-planning-capability.js');
const eventlog = await import('./eventlog.js');
const catalogs = await import('./host-capability-catalog-factory.js');
const ports = await import('./production-capability-ports.js');
const observations = await import('./independent-capability-observation.js');
const instructions = await import('../../assistant/instructions.js');
const capabilityIndex = await import('../../memory/capability-index.js');
const runtimeConfig = await import('../../config.js');
const { withFileLock } = await import('../atomic-json.js');

test.after(() => {
  catalogs.installHostCapabilityCatalogFactory(null);
  ports.clearProductionCapabilityPorts();
  observations.clearIndependentCapabilityObservations();
  eventlog.closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

const salesforce = catalog.CLI_CATALOG.find((entry) => entry.id === 'salesforce')!;
const liveSearch = 'query Salesforce opportunities closing today via sf CLI';

function salesforceCapabilityRow(): Record<string, unknown> | undefined {
  return capabilityIndex.capabilityIndexDatabase().prepare(`
    SELECT *
    FROM capability_operations
    WHERE identifier = 'salesforce_sf_soql_query'
      AND account_identity = 'reviewed_cli:host'
  `).get() as Record<string, unknown> | undefined;
}

function capabilityTotalChanges(): number {
  return (capabilityIndex.capabilityIndexDatabase().prepare(
    'SELECT total_changes() AS changes',
  ).get() as { changes: number }).changes;
}

test('unbounded run_shell_command still cannot enter local planning as a read', () => {
  // The shell is declared as ordinary local WORK (a mutation whose per-call
  // effect decides at dispatch), never as a native planning read: a reviewed
  // CLI read keeps its own descriptor, binary and argv proof.
  assert.equal(local.isRegistryDeclaredNativePlanningRead('run_shell_command'), false);
  assert.equal(local.isRegistryDeclaredLocalPlanningMutation('run_shell_command'), true);
});

test('a Salesforce CLI search nominates the reviewed SOQL identity; a GitHub search does not', () => {
  const row = {
    identifier: 'salesforce_sf_soql_query',
    carrierKind: 'cli' as const,
    carrier: 'reviewed-cli-config',
    displayName: 'Salesforce CLI SOQL query',
    description: 'Read-only SOQL via the local Salesforce sf CLI.',
    effectClass: 'read' as const,
    effectProvenance: 'curated' as const,
    accountIdentity: 'reviewed_cli:host',
    parentIdentifier: 'salesforce.data.query',
  };
  assert.equal(
    acquisition.rowIsAdvisoryObjectiveNomination(row, liveSearch, 'cli'),
    true,
    'the live Salesforce CLI search must cite the reviewed read',
  );
  assert.equal(
    acquisition.rowIsAdvisoryObjectiveNomination(row, liveSearch, 'mcp'),
    false,
    'MCP rows keep the all-terms haystack and must not widen',
  );
  assert.equal(
    acquisition.rowIsAdvisoryObjectiveNomination(row, 'github pull request', 'cli'),
    false,
  );
});

test('connected catalog Salesforce CLI provisions a reviewed SOQL read that live acquisition can install', async () => {
  catalog.recordConnectedCli(salesforce);
  const first = await reconcile.reconcileCatalogReviewedCliReads({ rehash: true });
  assert.equal(first.provisioned.includes('salesforce'), true, JSON.stringify(first));
  const descriptors = config.listReviewedCliReadDescriptors();
  const soql = descriptors.find((row) => row.descriptorId === 'salesforce.data.query');
  assert.ok(soql);
  assert.equal(soql?.operationId, 'salesforce_sf_soql_query');
  assert.deepEqual(soql?.argvPrefix, ['data', 'query', '--json']);
  assert.equal(soql?.arguments.some((argument) => argument.token === '--query' && argument.required), true);

  const registryPath = config.reviewedCliReadConfigPath();
  const registryBeforeSecondBoot = readFileSync(registryPath);
  const capabilityBeforeSecondBoot = salesforceCapabilityRow();
  assert.ok(capabilityBeforeSecondBoot);
  const capabilityChangesBeforeSecondBoot = capabilityTotalChanges();

  const secondBoot = await reconcile.reconcileCatalogReviewedCliReads({ rehash: true });
  assert.equal(
    secondBoot.provisioned.includes('salesforce'),
    false,
    'daemon rehash must not reprovision a current contract and executable',
  );
  assert.equal(secondBoot.skipped.includes('salesforce'), true, JSON.stringify(secondBoot));
  assert.equal(
    readFileSync(registryPath).equals(registryBeforeSecondBoot),
    true,
    'an unchanged daemon rehash must preserve the exact sealed registry bytes',
  );
  assert.deepEqual(
    salesforceCapabilityRow(),
    capabilityBeforeSecondBoot,
    'an unchanged daemon rehash must preserve the indexed capability row',
  );
  assert.equal(
    capabilityTotalChanges(),
    capabilityChangesBeforeSecondBoot,
    'an unchanged daemon rehash must not refresh capability or FTS rows',
  );

  const installed = await acquisition.createProductionLiveReadAcquisitionRegistry().acquire({
    requirementId: 'requirement-salesforce-soql',
    objective: liveSearch,
    effect: 'read',
  });
  assert.equal(installed.status, 'installed', JSON.stringify(installed));
  if (installed.status === 'installed') {
    assert.equal(installed.manifest.providerKind, 'reviewed_cli');
    assert.equal(installed.manifest.operationId, 'salesforce_sf_soql_query');
    assert.equal(installed.manifest.effect, 'read');
  }

  const unrelated = await acquisition.createProductionLiveReadAcquisitionRegistry().acquire({
    requirementId: 'requirement-github-pr',
    objective: 'github pull request',
    effect: 'read',
  });
  assert.equal(unrelated.status, 'blocked');

  const second = await reconcile.reconcileCatalogReviewedCliReads();
  assert.equal(second.provisioned.includes('salesforce'), false, 'same closed contract is not rehashed on a dashboard poll');
});

test('daemon rehash reprovisions the reviewed read when executable bytes drift', async () => {
  catalog.recordConnectedCli(salesforce);
  await reconcile.reconcileCatalogReviewedCliReads({ rehash: true });
  const before = config.listReviewedCliReadDescriptors()
    .find((row) => row.descriptorId === 'salesforce.data.query');
  assert.ok(before);
  const registryPath = config.reviewedCliReadConfigPath();
  const registryBeforeDrift = readFileSync(registryPath);
  const executableBeforeDrift = readFileSync(fakeSf);
  const capabilityChangesBeforeDrift = capabilityTotalChanges();

  try {
    writeFileSync(fakeSf, Buffer.concat([
      executableBeforeDrift,
      Buffer.from('\n// reviewed executable byte drift\n', 'utf8'),
    ]));
    chmodSync(fakeSf, 0o700);

    const drift = await reconcile.reconcileCatalogReviewedCliReads({ rehash: true });
    assert.equal(drift.provisioned.includes('salesforce'), true, JSON.stringify(drift));
    assert.equal(drift.skipped.includes('salesforce'), false, JSON.stringify(drift));
    const after = config.listReviewedCliReadDescriptors()
      .find((row) => row.descriptorId === 'salesforce.data.query');
    assert.ok(after);
    assert.notEqual(after.binarySha256, before.binarySha256);
    assert.ok(
      capabilityTotalChanges() > capabilityChangesBeforeDrift,
      'byte drift must refresh the indexed capability',
    );
    assert.equal(
      readFileSync(registryPath).equals(registryBeforeDrift),
      false,
      'byte drift must replace the sealed descriptor',
    );
  } finally {
    writeFileSync(fakeSf, executableBeforeDrift);
    chmodSync(fakeSf, 0o700);
    await reconcile.reconcileCatalogReviewedCliReads({ rehash: true });
  }
});

test('CLI-only live-read acquire still installs when a sibling MCP carrier is unavailable', async () => {
  catalog.recordConnectedCli(salesforce);
  await reconcile.reconcileCatalogReviewedCliReads({ rehash: true });
  const combined = acquisition.createProductionLiveReadAcquisitionRegistry({
    configuredAdapters: () => [
      {
        version: 1 as const,
        adapterId: 'mcp:poison',
        carrier: { kind: 'mcp' as const, name: 'poison' },
        async nominate() {
          return { status: 'unavailable' as const, detail: 'generated carrier unavailable' };
        },
        async materialize() {
          return {
            status: 'blocked' as const,
            reason: 'live_unavailable' as const,
            detail: 'poison',
            retired: [],
          };
        },
      },
      acquisition.createProductionReviewedCliLiveReadAcquisitionAdapter(),
    ],
  });
  const poisoned = await combined.acquire({
    requirementId: 'requirement-poisoned-mcp',
    objective: liveSearch,
    effect: 'read',
  });
  assert.equal(poisoned.status, 'blocked');
  if (poisoned.status === 'blocked') assert.equal(poisoned.reason, 'carrier_unavailable');

  const cliOnly = acquisition.createProductionLiveReadAcquisitionRegistry({
    configuredAdapters: () => [acquisition.createProductionReviewedCliLiveReadAcquisitionAdapter()],
  });
  const installed = await cliOnly.acquire({
    requirementId: 'requirement-cli-only-fallback',
    objective: liveSearch,
    effect: 'read',
  });
  assert.equal(installed.status, 'installed', JSON.stringify(installed));
  if (installed.status === 'installed') {
    assert.equal(installed.manifest.operationId, 'salesforce_sf_soql_query');
    assert.equal(installed.manifest.providerKind, 'reviewed_cli');
  }
});

test('connected reviewed Salesforce CLI demotes Composio Salesforce reads, never writes', async () => {
  catalog.recordConnectedCli(salesforce);
  await reconcile.reconcileCatalogReviewedCliReads({ rehash: true });
  const sources = await import('../../tools/tool-search-provider-sources.js');
  assert.equal(
    sources.composioDiscoveryDispositionAgainstReviewedCli({
      toolkit: 'salesforce',
      slug: 'SALESFORCE_SOQL_QUERY',
    }),
    'demote',
  );
  assert.equal(
    sources.composioDiscoveryDispositionAgainstReviewedCli({
      toolkit: 'salesforce',
      slug: 'SALESFORCE_CREATE_OPPORTUNITY',
    }),
    'keep',
    'a read-only CLI replacement must not hide Composio writes',
  );
  assert.equal(
    sources.composioDiscoveryDispositionAgainstReviewedCli({
      toolkit: 'outlook',
      slug: 'OUTLOOK_GET_CALENDAR_VIEW',
    }),
    'keep',
  );
  assert.equal(sources.composioToolkitSuppressedByReviewedCliRead('salesforce'), false);
});

test('connected CLI instructions refuse the unavailable lie and name the reviewed Salesforce read', () => {
  catalog.recordConnectedCli(salesforce);
  const ctx = {
    soul: 'Clementine is sharp and proactive.',
    identity: 'I am Clementine.',
    memory: '',
    workingMemory: '',
  };
  const out = instructions.buildAssistantInstructions(ctx, 'dashboard', 'action', liveSearch);
  assert.equal(out.includes(instructions.CONNECTED_CLI_AVAILABILITY_DIRECTIVE), true);
  assert.equal(out.includes(instructions.CONNECTED_CLI_REVIEWED_READ_DIRECTIVE), true);
  assert.equal(out.includes('salesforce_sf_soql_query'), true);
  assert.equal(out.includes('Call them via `run_shell_command`'), false);
});

test("a CLI's own diagnosis read is provisioned beside its query, and the query still wins that CLI's objective", async () => {
  // A tool that cannot report its own accounts forces the model to tell the
  // user "I cannot run commands to check this" — the failure this read exists
  // to remove. Both reads carry the tool's name, so the objective is answered
  // by the operation that covers more of it, not by refusing as ambiguous.
  catalog.recordConnectedCli(salesforce);
  await reconcile.reconcileCatalogReviewedCliReads({ rehash: true });
  const descriptors = config.listReviewedCliReadDescriptors();
  const diagnosis = descriptors.find((row) => row.descriptorId === 'salesforce.org.list');
  assert.ok(diagnosis, JSON.stringify(descriptors.map((row) => row.descriptorId)));
  assert.equal(diagnosis?.operationId, 'salesforce_sf_org_list');
  assert.deepEqual(diagnosis?.argvPrefix, ['org', 'list', '--json']);
  assert.deepEqual(diagnosis?.arguments, []);
  assert.equal(diagnosis?.effect, 'read');

  const installed = await acquisition.createProductionLiveReadAcquisitionRegistry().acquire({
    requirementId: 'requirement-salesforce-soql-with-diagnosis',
    objective: liveSearch,
    role: 'source',
    effect: 'read',
  });
  assert.equal(installed.status, 'installed', JSON.stringify(installed));
  if (installed.status === 'installed') {
    assert.equal(installed.manifest.operationId, 'salesforce_sf_soql_query');
  }
});

const healthFile = path.join(TEST_HOME, 'state', 'cli-auth-health.json');
const connectedFile = path.join(TEST_HOME, 'state', 'connected-clis.json');
function selectedSf(name: string): string {
  const directory = path.join(TEST_HOME, name);
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, process.platform === 'win32' ? 'sf.exe' : 'sf');
  writeFileSync(file, `#!${process.execPath}\n// ${name} - metadata-only fixture; never execute\n`);
  chmodSync(file, 0o700);
  return file;
}
function selectSf(binaryPath: string, patch: Record<string, unknown> = {}): void {
  writeFileSync(healthFile, JSON.stringify({ version: 'v1', entries: {
    salesforce: { id: 'salesforce', command: 'sf', installed: true, authStatus: 'unknown',
      binaryPath, checkedAt: new Date().toISOString(), ...patch },
  } }));
}
async function restoreBootstrapSf(): Promise<void> {
  rmSync(healthFile, { force: true });
  catalog.recordConnectedCli(salesforce);
  await reconcile.reconcileCatalogReviewedCliReads({ rehash: true });
}

test('connected executable A wins over independent PATH B and an old A descriptor immediately rejects selected B',
  { skip: process.platform === 'win32' }, async () => {
  const first = selectedSf('selected-A');
  const second = selectedSf('selected-B');
  catalog.recordConnectedCli(salesforce);
  try {
    selectSf(first, { username: 'not-an-intended-account-proof' });
    await reconcile.reconcileCatalogReviewedCliReads({ rehash: true });
    const before = config.listReviewedCliReadDescriptors().find(row => row.descriptorId === 'salesforce.data.query')!;
    assert.equal(before.executableRealpath, realpathSync(first));
    assert.notEqual(before.executableRealpath, realpathSync(fakeSf), 'PATH B must not substitute for the selected file');
    assert.equal(before.effect, 'read');
    assert.equal(before.accountId, 'reviewed_cli:host');
    assert.ok(config.currentReviewedCliDescriptor(before));
    selectSf(second);
    assert.equal(config.currentReviewedCliDescriptor(before), null, 'physical admission rejects old A before another reconcile');
    await reconcile.reconcileCatalogReviewedCliReads();
    const after = config.listReviewedCliReadDescriptors().find(row => row.descriptorId === 'salesforce.data.query')!;
    assert.equal(after.executableRealpath, realpathSync(second));
    assert.ok(config.currentReviewedCliDescriptor(after));
  } finally { await restoreBootstrapSf(); }
});

test('missing selected A retires only its catalog descriptors/index rows without PATH fallback or repeated writes',
  { skip: process.platform === 'win32' }, async () => {
  const first = selectedSf('selected-missing');
  catalog.recordConnectedCli(salesforce);
  try {
    selectSf(first);
    await reconcile.reconcileCatalogReviewedCliReads({ rehash: true });
    const before = config.listReviewedCliReadDescriptors().find(row => row.descriptorId === 'salesforce.data.query')!;
    const manual = await config.provisionReviewedCliReadDescriptor({
      version: 1, descriptorId: 'fixture.manual', operationId: 'fixture_manual_read', displayName: 'Manual read',
      description: 'Controlled manual descriptor.', effect: 'read', accountId: 'reviewed_cli:host',
      executablePath: fakeSf, argvPrefix: [], arguments: [], limits: { ...before.limits },
    });
    capabilityIndex.recordCapabilityOperations([{ identifier: manual.operationId, carrierKind: 'cli', carrier: 'reviewed-cli-config',
      displayName: manual.displayName, description: manual.description, effectClass: 'read', effectProvenance: 'curated',
      accountIdentity: manual.accountId, parentIdentifier: manual.descriptorId }]);
    rmSync(first);
    assert.equal(config.currentReviewedCliDescriptor(before), null);
    const result = await reconcile.reconcileCatalogReviewedCliReads();
    assert.ok(result.removed.includes('salesforce.data.query'));
    assert.ok(!config.listReviewedCliReadDescriptors().some(row => row.descriptorId === before.descriptorId));
    assert.ok(!capabilityIndex.listCapabilityOperationsForCarrier('cli', 'reviewed-cli-config')
      .some(row => row.identifier === before.operationId && row.accountIdentity === before.accountId));
    assert.ok(config.currentReviewedCliDescriptor(manual), 'manual noncatalog descriptor is unaffected by connected selection');
    assert.ok(capabilityIndex.listCapabilityOperationsForCarrier('cli', 'reviewed-cli-config')
      .some(row => row.identifier === manual.operationId));
    const registry = readFileSync(config.reviewedCliReadConfigPath());
    const changes = capabilityTotalChanges();
    assert.equal((await reconcile.reconcileCatalogReviewedCliReads()).removed.length, 0);
    assert.ok(readFileSync(config.reviewedCliReadConfigPath()).equals(registry));
    assert.equal(capabilityTotalChanges(), changes, 'repeat unavailable reconciliation is a storage no-op');
  } finally { await restoreBootstrapSf(); }
});

test('present invalid selected observations remove catalog descriptors instead of rediscovering PATH B',
  { skip: process.platform === 'win32' }, async () => {
  const first = selectedSf('selected-invalid');
  catalog.recordConnectedCli(salesforce);
  try {
    for (const patch of [{ command: ' sf ' }, { id: 'other' }, { installed: false }, { binaryPath: 'sf' }, { binaryPath: undefined }]) {
      selectSf(first);
      await reconcile.reconcileCatalogReviewedCliReads({ rehash: true });
      const before = config.listReviewedCliReadDescriptors().find(row => row.descriptorId === 'salesforce.data.query')!;
      assert.ok(before);
      selectSf(first, patch);
      assert.equal(config.currentReviewedCliDescriptor(before), null);
      await reconcile.reconcileCatalogReviewedCliReads();
      assert.ok(!config.listReviewedCliReadDescriptors().some(row => row.descriptorId === before.descriptorId));
    }
  } finally { await restoreBootstrapSf(); }
});

test('saved-only catalog CLI keeps bootstrap PATH behavior when no connected executable binding exists',
  { skip: process.platform === 'win32' }, async () => {
  const rosterBytes = readFileSync(connectedFile);
  const saved = process.env.CLEMMY_SAVED_CLIS;
  try {
    writeFileSync(connectedFile, JSON.stringify({ version: 'v1', entries: {} }));
    rmSync(healthFile, { force: true });
    process.env.CLEMMY_SAVED_CLIS = 'sf';
    runtimeConfig.invalidateRuntimeConfigSnapshot();
    await reconcile.reconcileCatalogReviewedCliReads({ rehash: true });
    const current = config.listReviewedCliReadDescriptors().find(row => row.descriptorId === 'salesforce.data.query')!;
    assert.equal(current.executableRealpath, realpathSync(fakeSf));
    assert.ok(config.currentReviewedCliDescriptor(current));
  } finally {
    if (saved === undefined) delete process.env.CLEMMY_SAVED_CLIS; else process.env.CLEMMY_SAVED_CLIS = saved;
    runtimeConfig.invalidateRuntimeConfigSnapshot();
    writeFileSync(connectedFile, rosterBytes);
    await restoreBootstrapSf();
  }
});

test('selection changes across an awaited provision cannot publish A, and queued reconciliation retains B',
  { skip: process.platform === 'win32' }, async () => {
  const first = selectedSf('selected-await-A');
  const second = selectedSf('selected-await-B');
  catalog.recordConnectedCli(salesforce);
  try {
    for (const descriptor of config.listReviewedCliReadDescriptors().filter(row => row.descriptorId.startsWith('salesforce.'))) {
      await config.removeReviewedCliReadDescriptor(descriptor.descriptorId);
    }
    selectSf(first);
    let entered!: () => void;
    let release!: () => void;
    const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
    const releasePromise = new Promise<void>(resolve => { release = resolve; });
    const held = withFileLock(config.reviewedCliReadConfigPath(), async () => { entered(); await releasePromise; });
    await enteredPromise;
    const pendingA = reconcile.reconcileCatalogReviewedCliReads({ rehash: true });
    const pendingB = reconcile.reconcileCatalogReviewedCliReads({ rehash: true });
    await new Promise<void>(resolve => setImmediate(resolve));
    selectSf(second);
    release();
    await held;
    const [resultA] = await Promise.all([pendingA, pendingB]);
    assert.ok(resultA.removed.includes('salesforce.data.query'), 'A is removed after its async save observes changed selection');
    const current = config.listReviewedCliReadDescriptors().filter(row => row.descriptorId.startsWith('salesforce.'));
    assert.ok(current.length > 0);
    assert.ok(current.every(row => row.executableRealpath === realpathSync(second)));
    assert.ok(current.every(row => config.currentReviewedCliDescriptor(row) !== null));
  } finally { await restoreBootstrapSf(); }
});

test('digest-conditional removal cannot delete another writer\'s newer descriptor',
  { skip: process.platform === 'win32' }, async () => {
  const first = selectedSf('selected-CAS-A');
  const second = selectedSf('selected-CAS-B');
  catalog.recordConnectedCli(salesforce);
  try {
    selectSf(first);
    await reconcile.reconcileCatalogReviewedCliReads({ rehash: true });
    const before = config.listReviewedCliReadDescriptors().find(row => row.descriptorId === 'salesforce.data.query')!;
    selectSf(second);
    await reconcile.reconcileCatalogReviewedCliReads({ rehash: true });
    const retained = config.listReviewedCliReadDescriptors().find(row => row.descriptorId === before.descriptorId)!;
    const registry = readFileSync(config.reviewedCliReadConfigPath());
    assert.equal(await config.removeReviewedCliReadDescriptor(before.descriptorId,
      { expectedDescriptorDigest: config.reviewedCliDescriptorDigest(before) }), false);
    assert.ok(readFileSync(config.reviewedCliReadConfigPath()).equals(registry), 'a lost CAS does not rewrite the newer registry');
    assert.ok(config.currentReviewedCliDescriptor(retained));
  } finally { await restoreBootstrapSf(); }
});

test('an unchanged catalog descriptor repairs its exact index row despite another account or parent match',
  { skip: process.platform === 'win32' }, async () => {
  catalog.recordConnectedCli(salesforce);
  await reconcile.reconcileCatalogReviewedCliReads({ rehash: true });
  const descriptor = config.listReviewedCliReadDescriptors().find(row => row.descriptorId === 'salesforce.data.query')!;
  const other = {
    identifier: descriptor.operationId, carrierKind: 'cli' as const, carrier: 'reviewed-cli-config',
    displayName: 'Other account fixture', description: 'Independent indexed operation.',
    effectClass: 'read' as const, effectProvenance: 'curated' as const,
    accountIdentity: 'reviewed_cli:other', parentIdentifier: 'fixture.other-parent',
  };
  capabilityIndex.recordCapabilityOperations([other]);
  const database = capabilityIndex.capabilityIndexDatabase();
  const otherRow = () => database.prepare(`SELECT * FROM capability_operations
    WHERE identifier = ? AND account_identity = ?`).get(other.identifier, other.accountIdentity);
  const retainedOther = otherRow();
  assert.equal(capabilityIndex.deactivateCapabilityOperation({ identifier: descriptor.operationId,
    accountIdentity: descriptor.accountId, carrierKind: 'cli', carrier: 'reviewed-cli-config',
    parentIdentifier: descriptor.descriptorId }), 1);
  await reconcile.reconcileCatalogReviewedCliReads();
  assert.equal(salesforceCapabilityRow()?.active, 1, 'another account cannot stand in for the missing exact catalog row');
  assert.equal(salesforceCapabilityRow()?.parent_identifier, descriptor.descriptorId);
  assert.deepEqual(otherRow(), retainedOther, 'repair must not refresh or change the other account row');

  capabilityIndex.recordCapabilityOperations([{ ...other, accountIdentity: descriptor.accountId }]);
  assert.equal(salesforceCapabilityRow()?.parent_identifier, other.parentIdentifier);
  await reconcile.reconcileCatalogReviewedCliReads();
  assert.equal(salesforceCapabilityRow()?.parent_identifier, descriptor.descriptorId,
    'the same account with a different parent is not the exact catalog publication');
  assert.deepEqual(otherRow(), retainedOther);
  const changes = capabilityTotalChanges();
  await reconcile.reconcileCatalogReviewedCliReads();
  assert.equal(capabilityTotalChanges(), changes, 'a fully repaired catalog/index pair remains a no-op');
});

test('native Windows selected .exe is admitted without treating a .cmd path as the same launch contract',
  { skip: process.platform !== 'win32' }, async () => {
  catalog.recordConnectedCli(salesforce);
  try {
    selectSf(process.execPath);
    await reconcile.reconcileCatalogReviewedCliReads({ rehash: true });
    const before = config.listReviewedCliReadDescriptors().find(row => row.descriptorId === 'salesforce.data.query')!;
    assert.ok(before);
    assert.equal(before.executableRealpath, realpathSync(process.execPath));
    assert.ok(config.currentReviewedCliDescriptor(before));
    selectSf(path.join(TEST_HOME, 'selected', 'sf.cmd'));
    assert.equal(config.currentReviewedCliDescriptor(before), null);
    await reconcile.reconcileCatalogReviewedCliReads();
    assert.ok(!config.listReviewedCliReadDescriptors().some(row => row.descriptorId === before.descriptorId));
  } finally { rmSync(healthFile, { force: true }); }
});
