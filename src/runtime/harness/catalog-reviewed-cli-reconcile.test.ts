/** Run: node scripts/run-tests-isolated.mjs src/runtime/harness/catalog-reviewed-cli-reconcile.test.ts */
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ''}`;

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

test.after(() => {
  catalogs.installHostCapabilityCatalogFactory(null);
  ports.clearProductionCapabilityPorts();
  observations.clearIndependentCapabilityObservations();
  eventlog.closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

const salesforce = catalog.CLI_CATALOG.find((entry) => entry.id === 'salesforce')!;
const liveSearch = 'query Salesforce opportunities closing today via sf CLI';

test('unbounded run_shell_command still cannot enter local planning as a read', () => {
  assert.equal(local.isRegistryDeclaredLocalPlanningCapability('run_shell_command'), false);
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
