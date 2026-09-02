/**
 * Run: node scripts/run-tests-isolated.mjs src/execution/workflow-live-call-compiler.concurrent-acquire.test.ts
 *
 * Live 2026-09-01 (Friday dashboard): six parallel `call:` steps acquired
 * salesforce_sf_soql_query at once. The first installed it; the other five
 * saw the fresh install as an identity mismatch against their own
 * nomination, superseded and revoked it, and the run parked on "no current
 * capability" for a capability the host had just registered. One
 * acquisition per operation at a time; siblings await it and find it present.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-live-call-concurrent-acquire-'));
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
process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ''}`;

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

test('six parallel steps acquiring one reviewed-CLI read all end present or acquired, never unavailable', async () => {
  const salesforce = catalog.CLI_CATALOG.find((entry) => entry.id === 'salesforce')!;
  catalog.recordConnectedCli(salesforce);
  const provisioned = await reconcile.reconcileCatalogReviewedCliReads({ rehash: true });
  assert.equal(provisioned.provisioned.includes('salesforce'), true, JSON.stringify(provisioned));
  catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory());
  ports.clearProductionCapabilityPorts();

  const steps = ['open_pipeline', 'closed_this_week', 'activity_this_week', 'won_this_month', 'created_this_week', 'opportunity_engagement'];
  const results = await Promise.all(steps.map((nodeId) => compiler.ensureLiveReadCapabilityForOperation({
    ownerId: 'friday-dashboard-daily-refresh',
    nodeId,
    operationId: 'salesforce_sf_soql_query',
    expectedEffect: 'read',
    deadlineAt: Date.now() + 30_000,
  })));
  const statuses = results.map((result) => result.status);
  assert.deepEqual(statuses.filter((status) => status === 'unavailable'), [], JSON.stringify(results));
  assert.equal(statuses.filter((status) => status === 'acquired').length, 1, `exactly one acquisition: ${JSON.stringify(statuses)}`);
  assert.equal(statuses.filter((status) => status === 'present').length, steps.length - 1);

  for (const nodeId of steps) {
    const plan = compiler.compileLiveCatalogWorkflowCallPlan({
      ownerId: 'friday-dashboard-daily-refresh',
      nodeId,
      operationId: 'salesforce_sf_soql_query',
      args: { query: 'SELECT Id FROM Opportunity' },
      expectedEffect: 'read',
    });
    assert.equal(plan.ok, true, `${nodeId}: ${JSON.stringify(plan)}`);
  }
});
