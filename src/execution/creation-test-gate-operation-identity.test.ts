/**
 * A CITED OPERATION IS EXTERNAL WORK, WHATEVER ITS CARRIER SPELLS IT.
 *
 * `workflowNeedsCreationTest` decides whether a workflow must prove its read
 * steps for real before it may enable. It asked `stepReachesExternalTools`,
 * which matched `allowedTools` entries by SHAPE: `*`, an UPPER_SNAKE provider
 * operation, or a known carrier prefix.
 *
 * A reviewed CLI read is lower_snake (`salesforce_sf_soql_query`). It matched
 * none of those, so the step read as "reaches nothing external" → not a
 * testable read → no creation test → enable directly.
 *
 * Live 2026-09-18: `friday-sales-leadership-email`, whose first step is that
 * exact Salesforce read and whose last step SENDS mail, reached enabled:true
 * having never once proven its data step. This is the same defect the
 * UPPER_SNAKE branch was added for on 2026-09-11 (a scheduled inbox triage that
 * enabled unverified and then failed every run for six hours) — fixed for one
 * carrier, left open for the next.
 *
 * The repair asks the registries that OWN operation identity rather than
 * guessing from spelling, so a carrier added later is covered without a new
 * pattern. Shape stays as a fallback for names no registry knows yet.
 *
 * Run: node scripts/run-tests-isolated.mjs src/execution/creation-test-gate-operation-identity.test.ts
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-creation-gate-identity-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-creation-gate-identity\n', 'utf8');

import assert from 'node:assert/strict';
import { test } from 'node:test';

const capabilityCatalogs = await import('../runtime/harness/host-capability-catalog-factory.js');
const capabilityManifests = await import('../runtime/harness/capability-manifest.js');
const manifestStores = await import('../runtime/harness/capability-manifest-store.js');
const { workflowNeedsCreationTest, stepIsTestableRead } = await import('./workflow-enforce.js');

/** The exact operation the owner's Friday workflow cites. */
const CLI_READ = 'salesforce_sf_soql_query';

const readStep = (allowedTools: string[]) => ({
  id: 'collect_and_validate_salesforce_metrics',
  prompt: 'Use Salesforce exclusively through the authenticated local sf CLI.',
  allowedTools,
  sideEffect: 'read' as const,
});

const sendStep = {
  id: 'send_friday_leadership_email',
  prompt: 'Send exactly one email from the Scorpion Outlook mailbox.',
  allowedTools: ['OUTLOOK_OUTLOOK_SEND_EMAIL'],
  sideEffect: 'send' as const,
};

test.before(() => {
  const store = manifestStores.createCapabilityManifestStore([], { durable: true });
  manifestStores.installCapabilityManifestStore(store);
  const factory = capabilityCatalogs.createHostCapabilityCatalogFactory();
  const manifest = capabilityManifests.attachSemanticContract({
    version: 1,
    manifestId: `cap:fixture:reviewed-cli:${CLI_READ}`,
    providerKind: 'reviewed_cli',
    operationId: CLI_READ,
    providerIdentity: '/usr/bin/fixture-sf',
    providerVersion: 'fixture-v1',
    operationVersion: '1',
    definitionFingerprint: 'e'.repeat(64),
    effect: 'read',
    accountId: 'reviewed_cli:host',
    idempotency: { required: false, policy: 'none' },
    reconciliation: { supported: false, policy: 'none' },
    outputContract: { kind: 'records' },
    evidenceContract: { kinds: ['payload'], readbackRequired: false },
    purpose: 'collect_records',
    provenance: { issuer: 'execution:creation-gate-identity', issuedAt: '2026-09-18T00:00:00.000Z', trusted: true },
    lifecycle: { state: 'current' },
  });
  assert.equal(store.install(manifest).ok, true);
  factory.register({
    capabilityId: manifest.manifestId,
    toolName: manifest.operationId,
    schemaVersion: manifest.operationVersion,
    schemaDigest: manifest.definitionFingerprint,
    effect: manifest.effect,
    account: manifest.accountId,
    manifestDigest: capabilityManifests.capabilityManifestDigest(manifest),
    providerKind: manifest.providerKind,
    liveFingerprint: manifest.definitionFingerprint,
    manifest,
    invoke: async () => { throw new Error('the gate never dispatches'); },
  });
  capabilityCatalogs.installHostCapabilityCatalogFactory(factory);
});

test.after(() => {
  capabilityCatalogs.installHostCapabilityCatalogFactory(null);
  manifestStores.installCapabilityManifestStore(null);
  rmSync(TMP_HOME, { recursive: true, force: true });
});

test('a lower_snake reviewed-CLI read is a testable read', () => {
  assert.equal(
    stepIsTestableRead(readStep([CLI_READ])),
    true,
    'THE REGRESSION: this returned false, so the step reached "nothing external"',
  );
});

test('the Friday workflow shape now demands a creation test before it can enable', () => {
  const friday = { steps: [readStep([CLI_READ]), sendStep] } as Parameters<typeof workflowNeedsCreationTest>[0];
  assert.equal(
    workflowNeedsCreationTest(friday),
    true,
    'a workflow whose data step is a cited CLI read and whose last step SENDS must prove the read first',
  );
});

test('identity is what decides it, not the name shape', () => {
  // An unknown lower_snake name no registry carries still fails the shape tests
  // — so the test above passes because the operation is REAL, not because the
  // predicate got looser.
  assert.equal(
    stepIsTestableRead(readStep(['totally_unknown_local_thing'])),
    false,
    'a name no registry knows identifies no external work',
  );
});

test('the shapes that already worked still work', () => {
  assert.equal(stepIsTestableRead(readStep(['*'])), true, 'a wildcard still reaches everything');
  assert.equal(stepIsTestableRead(readStep(['GOOGLESHEETS_VALUES_GET'])), true, 'UPPER_SNAKE provider operations still count');
  assert.equal(stepIsTestableRead(readStep(['composio_execute_tool'])), true, 'carrier prefixes still count');
});

test('a mutating step is still never the thing a creation test validates', () => {
  assert.equal(stepIsTestableRead(sendStep), false, 'a send step is previewed, never executed, by the creation test');
  assert.equal(
    workflowNeedsCreationTest({ steps: [sendStep] } as Parameters<typeof workflowNeedsCreationTest>[0]),
    false,
    'nothing read-only to prove',
  );
});
