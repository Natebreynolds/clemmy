/**
 * Run: node scripts/run-tests-isolated.mjs \
 *   src/runtime/harness/occupancy-same-read.red.test.ts
 *
 * Live workflow:1788024507349-17d535: GOOGLESHEETS_BATCH_GET and
 * SLACK_FETCH_CONVERSATION_HISTORY classified external_write, then
 * catalog_entry_or_manifest_missing:proven=none. Two current read
 * transports of one operation are not a write, and a worker session
 * without capability_resolution must still bind the live read.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'os';
import path from 'node:path';
import test from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-occupancy-same-read-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';

const catalogs = await import('./host-capability-catalog-factory.js');
const { attachSemanticContract, capabilityManifestDigest } = await import('./capability-manifest.js');
const { classifyRuntimeToolEffect } = await import('./tool-effect.js');
const { isMutatingExternalWrite } = await import('./execution-gate.js');
const { currentManifestOperationContract } = await import('./current-manifest-operation-semantics.js');

test.after(() => {
  catalogs.installHostCapabilityCatalogFactory(null);
  rmSync(TEST_HOME, { recursive: true, force: true });
});

function digest(label: string): string {
  return createHash('sha256').update(label, 'utf8').digest('hex');
}

function readEntry(input: {
  capabilityId: string;
  operationId: string;
  accountId?: string;
}): catalogs.RegisteredHostCapability {
  const manifest = attachSemanticContract({
    version: 1,
    manifestId: input.capabilityId,
    providerKind: 'composio',
    operationId: input.operationId,
    providerIdentity: 'composio.test',
    providerVersion: 'runtime.1',
    operationVersion: '1',
    definitionFingerprint: digest(`schema.${input.capabilityId}`),
    effect: 'read',
    accountId: input.accountId ?? 'account.sheets',
    idempotency: { required: false, policy: 'none' },
    reconciliation: { supported: false, policy: 'none' },
    outputContract: { kind: 'records' },
    purpose: 'bounded_read',
    acceptedInputKinds: ['scope'],
    producedOutputKinds: ['records'],
    applicableDeliverableKinds: ['records'],
    evidenceContract: { kinds: ['records'], readbackRequired: false },
    provenance: { issuer: 'host.test', issuedAt: '2026-08-29T00:00:00.000Z', trusted: true },
    lifecycle: { state: 'current' },
    advisoryRoles: ['lookup'],
  });
  return {
    capabilityId: input.capabilityId,
    toolName: manifest.operationId,
    schemaVersion: manifest.operationVersion,
    schemaDigest: manifest.definitionFingerprint,
    effect: 'read',
    account: manifest.accountId,
    advisoryRoles: manifest.advisoryRoles,
    manifestDigest: capabilityManifestDigest(manifest),
    providerKind: manifest.providerKind,
    liveFingerprint: manifest.definitionFingerprint,
    manifest,
    invoke: async () => ({ records: [] }),
  };
}

test('NEGATIVE: two current BATCH_GET reads are a read, not a write', () => {
  const factory = catalogs.createHostCapabilityCatalogFactory([
    readEntry({
      capabilityId: 'cap:resolved:googlesheets_batch_get:definition:aaaa',
      operationId: 'GOOGLESHEETS_BATCH_GET',
    }),
    readEntry({
      capabilityId: 'cap:resolved:googlesheets_batch_get:definition:bbbb',
      operationId: 'google_sheets__batch_get',
    }),
  ]);
  catalogs.installHostCapabilityCatalogFactory(factory);
  const args = { tool_slug: 'GOOGLESHEETS_BATCH_GET', arguments: { spreadsheet_id: 's' } };
  assert.equal(
    classifyRuntimeToolEffect('composio_execute_tool', args).effect,
    'read',
    'occupancy of two current reads must not invent a write',
  );
  assert.equal(isMutatingExternalWrite('composio_execute_tool', args), false);
  assert.equal(currentManifestOperationContract('GOOGLESHEETS_BATCH_GET')?.effect, 'read');
  const bound = catalogs.resolveProvenLiveCatalogEntry({
    capabilityId: 'cap:resolved:googlesheets_batch_get',
    effectiveName: 'GOOGLESHEETS_BATCH_GET',
  });
  assert.ok(bound, 'a worker with proven=none must still bind the unique-account live read');
  assert.equal(bound?.effect, 'read');
});
