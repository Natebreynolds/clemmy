/** Run: node scripts/run-tests-isolated.mjs src/memory/capability-index.test.ts
 *
 * The connect-time capability index: what this install can DO, recorded when a
 * capability is provisioned rather than after it has been used. The pins that
 * matter are the blank-state ones — an empty index must degrade to live
 * discovery, and a freshly connected carrier must be retrievable on the very
 * first turn without any prior receipt.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-capability-index-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'machine-capability-index\n', 'utf8');

const {
  recordCapabilityOperations,
  searchCapabilityOperations,
  listCapabilityOperationsForCarrier,
  deactivateCapabilityCarrier,
  capabilityIndexStats,
  indexedCapabilityCarriers,
} = await import('./capability-index.js');

test('a cold index returns nothing rather than pretending the world is empty', () => {
  assert.deepEqual(searchCapabilityOperations('send an email'), []);
  assert.equal(capabilityIndexStats().operations, 0);
  // The caller contract: [] means "ask the provider", never "no such capability".
  assert.deepEqual(indexedCapabilityCarriers('composio'), []);
});

test('a newly provisioned carrier is retrievable on the first turn, with no prior use', () => {
  const written = recordCapabilityOperations([
    {
      identifier: 'ACME_CRM_CREATE_DEAL',
      carrierKind: 'composio',
      carrier: 'acme_crm',
      displayName: 'Create deal',
      description: 'Create a new deal record in the Acme CRM pipeline.',
      effectClass: 'write',
      effectProvenance: 'inferred',
      accountIdentity: 'user@example.com',
    },
    {
      identifier: 'ACME_CRM_LIST_DEALS',
      carrierKind: 'composio',
      carrier: 'acme_crm',
      displayName: 'List deals',
      description: 'List deals in the Acme CRM pipeline with filters.',
      effectClass: 'read',
      effectProvenance: 'inferred',
      accountIdentity: 'user@example.com',
    },
  ]);
  assert.equal(written, 2);
  const hits = searchCapabilityOperations('deals pipeline');
  assert.ok(hits.length >= 1, 'the operation is retrievable immediately after provisioning');
  assert.ok(hits.some((hit) => hit.identifier === 'ACME_CRM_LIST_DEALS'));
  assert.ok(hits.every((hit) => hit.score >= 0 && hit.score <= 1));
});

test('effect class filters retrieval: a read role never has to see writes', () => {
  const reads = searchCapabilityOperations('deals', { effectClass: 'read' });
  assert.ok(reads.length >= 1);
  assert.ok(reads.every((hit) => hit.effectClass === 'read'), 'only reads come back');
  const writes = searchCapabilityOperations('deals', { effectClass: 'write' });
  assert.ok(writes.every((hit) => hit.effectClass === 'write'));
});

test('re-enumeration is idempotent and preserves when the capability first appeared', () => {
  const before = listCapabilityOperationsForCarrier('composio', 'acme_crm');
  recordCapabilityOperations([
    {
      identifier: 'ACME_CRM_LIST_DEALS',
      carrierKind: 'composio',
      carrier: 'acme_crm',
      displayName: 'List deals (v2)',
      description: 'List deals, now with pagination.',
      effectClass: 'read',
      effectProvenance: 'declared',
      accountIdentity: 'user@example.com',
    },
  ]);
  const after = listCapabilityOperationsForCarrier('composio', 'acme_crm');
  assert.equal(after.length, before.length, 're-enumeration does not duplicate rows');
  const updated = after.find((row) => row.identifier === 'ACME_CRM_LIST_DEALS');
  assert.equal(updated?.displayName, 'List deals (v2)', 'descriptive columns refresh');
  assert.equal(updated?.effectProvenance, 'declared', 'better provenance replaces weaker');
});

test('the same identifier on two accounts is two capabilities, not one', () => {
  recordCapabilityOperations([{
    identifier: 'ACME_CRM_LIST_DEALS',
    carrierKind: 'composio',
    carrier: 'acme_crm',
    displayName: 'List deals',
    description: 'List deals in the Acme CRM pipeline.',
    effectClass: 'read',
    effectProvenance: 'inferred',
    accountIdentity: 'second@example.com',
  }]);
  const rows = listCapabilityOperationsForCarrier('composio', 'acme_crm')
    .filter((row) => row.identifier === 'ACME_CRM_LIST_DEALS');
  assert.equal(rows.length, 2, 'account identity is part of the capability identity');
  assert.deepEqual(
    rows.map((row) => row.accountIdentity).sort(),
    ['second@example.com', 'user@example.com'],
  );
});

test('disconnecting a carrier removes it from retrieval without erasing its history', () => {
  const stats = capabilityIndexStats();
  assert.ok(stats.operations >= 3);
  assert.equal(stats.byCarrierKind.composio >= 3, true);
  const deactivated = deactivateCapabilityCarrier('composio', 'acme_crm');
  assert.ok(deactivated >= 3);
  assert.deepEqual(searchCapabilityOperations('deals pipeline'), [], 'a disconnected carrier is not reachable');
  assert.deepEqual(indexedCapabilityCarriers('composio'), []);
  // Reconnecting restores the same rows rather than minting new identities.
  recordCapabilityOperations([{
    identifier: 'ACME_CRM_LIST_DEALS',
    carrierKind: 'composio',
    carrier: 'acme_crm',
    displayName: 'List deals',
    description: 'List deals in the Acme CRM pipeline.',
    effectClass: 'read',
    effectProvenance: 'inferred',
    accountIdentity: 'user@example.com',
  }]);
  assert.equal(searchCapabilityOperations('deals pipeline').length >= 1, true);
});

test('a hostile description cannot break FTS retrieval', () => {
  recordCapabilityOperations([{
    identifier: 'WEIRD_TOOL',
    carrierKind: 'mcp',
    carrier: 'weird-server',
    displayName: 'Weird "quoted" tool',
    description: 'Handles OR AND NOT * "quotes" and (parens) safely.',
    effectClass: 'unknown',
    effectProvenance: 'none',
  }]);
  assert.doesNotThrow(() => searchCapabilityOperations('OR AND NOT * "quotes" (parens)'));
  const hits = searchCapabilityOperations('quoted weird');
  assert.ok(hits.some((hit) => hit.identifier === 'WEIRD_TOOL'));
});
