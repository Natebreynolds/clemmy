/**
 * Run: node scripts/run-tests-isolated.mjs src/execution/workflow-live-call-compiler.acquire.test.ts
 *
 * Live 2026-09-01 (Friday dashboard): a structured `call:` step naming a
 * reviewed-CLI read (`salesforce_sf_soql_query`) was reported `not-connected`
 * by the live call compiler although readiness counted it ready and the
 * carrier could dispatch it — the live catalog only learned carrier
 * operations through foreground tool_search. The connection pinned here:
 * the call-step path acquires the exact saved READ through the same attested
 * acquisition registry, so an empty live catalog becomes one exact candidate.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-live-call-acquire-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TEST_HOME, 'state'), { recursive: true });

const binDir = path.join(TEST_HOME, 'bin');
mkdirSync(binDir, { recursive: true });
const fakeSf = path.join(binDir, 'sf');
writeFileSync(fakeSf, [
  `#!${process.execPath}`,
  'if (process.argv[2] === "data" && process.argv[3] === "query") {',
  '  process.stdout.write(JSON.stringify({ status: 0, result: { records: [{ Name: "Fixture Deal" }] } }) + "\\n");',
  '  process.exit(0);',
  '}',
  'process.stdout.write("sf mock\\n");',
].join('\n'), 'utf8');
chmodSync(fakeSf, 0o700);
const spawnEnv = await import('../runtime/spawn-env.js');
// Daemon-side resolution walks augmentPath(PATH), which PREPENDS the well-known
// tool dirs (/usr/local/bin, /opt/homebrew/bin, ...) ahead of anything not
// already on PATH. On a host whose shell PATH lacks one of those dirs, a real
// `sf` installed there outranks this fixture and the reviewed read hashes the
// real binary. Augment first (idempotent), then put the fixture in front.
process.env.PATH = `${binDir}${path.delimiter}${spawnEnv.augmentPath(process.env.PATH)}`;

const catalog = await import('../integrations/cli-catalog/catalog.js');
const reconcile = await import('../runtime/harness/catalog-reviewed-cli-reconcile.js');
const catalogs = await import('../runtime/harness/host-capability-catalog-factory.js');
const ports = await import('../runtime/harness/production-capability-ports.js');
const observations = await import('../runtime/harness/independent-capability-observation.js');
const eventlog = await import('../runtime/harness/eventlog.js');
const compiler = await import('./workflow-live-call-compiler.js');

test.after(() => {
  catalogs.installHostCapabilityCatalogFactory(null);
  ports.clearProductionCapabilityPorts();
  observations.clearIndependentCapabilityObservations();
  eventlog.closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

test('a saved reviewed-CLI READ with no durable manifest is acquired for the call step and compiles to one exact candidate', async () => {
  const salesforce = catalog.CLI_CATALOG.find((entry) => entry.id === 'salesforce')!;
  catalog.recordConnectedCli(salesforce);
  const provisioned = await reconcile.reconcileCatalogReviewedCliReads({ rehash: true });
  assert.equal(provisioned.provisioned.includes('salesforce'), true, JSON.stringify(provisioned));

  // The live catalog starts EMPTY, exactly like a daemon that never ran a
  // foreground search for this operation.
  catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory());
  ports.clearProductionCapabilityPorts();

  const before = compiler.compileLiveCatalogWorkflowCallPlan({
    ownerId: 'crm-dashboard-refresh',
    nodeId: 'open_pipeline',
    operationId: 'salesforce_sf_soql_query',
    args: { query: 'SELECT Id FROM Opportunity' },
    expectedEffect: 'read',
  });
  assert.equal(before.ok, false, 'without acquisition the empty catalog has no candidate (the live Friday failure)');

  const acquisition = await compiler.ensureLiveReadCapabilityForOperation({
    ownerId: 'crm-dashboard-refresh',
    nodeId: 'open_pipeline',
    operationId: 'salesforce_sf_soql_query',
    expectedEffect: 'read',
    deadlineAt: Date.now() + 30_000,
  });
  assert.equal(acquisition.status, 'acquired', JSON.stringify(acquisition));

  const after = compiler.compileLiveCatalogWorkflowCallPlan({
    ownerId: 'crm-dashboard-refresh',
    nodeId: 'open_pipeline',
    operationId: 'salesforce_sf_soql_query',
    args: { query: 'SELECT Id FROM Opportunity' },
    expectedEffect: 'read',
  });
  assert.equal(after.ok, true, JSON.stringify(after));

  // Idempotent: a second call finds the operation present and acquires nothing.
  const again = await compiler.ensureLiveReadCapabilityForOperation({
    ownerId: 'crm-dashboard-refresh',
    nodeId: 'open_pipeline',
    operationId: 'salesforce_sf_soql_query',
    expectedEffect: 'read',
  });
  assert.equal(again.status, 'present');
});

test('after a restart, the generic placeholder port does not block the first scheduled read', async () => {
  // Live 2026-09-14/15: every daemon restart reconstructs a generic
  // invoke-only port for each current durable manifest, reviewed CLI
  // included. The first scheduled Salesforce read after a restart then found
  // that placeholder ("observe_missing; existing: (none)"), the acquisition
  // refused, the identity was retired, and the retry 65 s later passed on a
  // freshly minted manifest — five failed nodes and a "Needs You" card every
  // morning. The exact reviewed port now replaces the placeholder.
  const production = await import('../runtime/harness/production-capability-catalog.js');
  const manifests = await import('../runtime/harness/capability-manifest-store.js');
  const before = manifests.resolveCapabilityManifestStore().list()
    .filter((entry) => entry.manifest.operationId === 'salesforce_sf_soql_query' && entry.manifest.lifecycle.state === 'current').length;
  assert.ok(before >= 1, 'the first test left a current reviewed-CLI manifest behind');

  // Restart: ports are process memory; reconstruction claims placeholders.
  ports.clearProductionCapabilityPorts();
  production.reconstructShippedPortsForDurableSuccessors();
  const placeholder = ports.listProductionCapabilityPorts().find((entry) => entry.identity.operationId === 'salesforce_sf_soql_query');
  assert.ok(placeholder, 'reconstruction registered a port for the reviewed manifest');
  assert.equal(Array.isArray(placeholder!.port.argv), false, 'the reconstructed port is the generic placeholder (no argv)');
  catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory());

  const acquisition = await compiler.ensureLiveReadCapabilityForOperation({
    ownerId: 'crm-dashboard-refresh', nodeId: 'closed_this_week', operationId: 'salesforce_sf_soql_query',
    expectedEffect: 'read', deadlineAt: Date.now() + 30_000,
  });
  assert.notEqual(acquisition.status, 'unavailable', JSON.stringify(acquisition));
  const compiled = compiler.compileLiveCatalogWorkflowCallPlan({
    ownerId: 'crm-dashboard-refresh', nodeId: 'closed_this_week', operationId: 'salesforce_sf_soql_query',
    args: { query: 'SELECT Id FROM Opportunity' }, expectedEffect: 'read',
  });
  assert.equal(compiled.ok, true, JSON.stringify(compiled));
  const exact = ports.listProductionCapabilityPorts().find((entry) => entry.identity.operationId === 'salesforce_sf_soql_query' && Array.isArray(entry.port.argv));
  assert.ok(exact, 'the exact reviewed port (with argv and observer) replaced the placeholder');
  assert.equal(typeof exact!.port.observe, 'function');
  const after = manifests.resolveCapabilityManifestStore().list()
    .filter((entry) => entry.manifest.operationId === 'salesforce_sf_soql_query' && entry.manifest.lifecycle.state === 'current').length;
  assert.equal(after, before, 'no identity was retired and re-minted to get there');
});

test('writes are never acquired through the read path', async () => {
  const outcome = await compiler.ensureLiveReadCapabilityForOperation({
    ownerId: 'crm-dashboard-refresh',
    nodeId: 'update_dashboard',
    operationId: 'space_set_data',
    expectedEffect: 'write',
  });
  assert.equal(outcome.status, 'present');
});
