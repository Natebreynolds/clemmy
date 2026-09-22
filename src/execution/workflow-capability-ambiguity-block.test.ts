/**
 * Run: node scripts/run-tests-isolated.mjs src/execution/workflow-capability-ambiguity-block.test.ts
 *
 * Several current accounts for one operation park a step as an ACCOUNT
 * CHOICE with the exact choice set, never as "connect <toolkit>". Live
 * 2026-09-22: three Outlook connections, and Home said "Workflow needs you —
 * connect outlook" while Outlook was connected the whole time.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'clem-ambiguity-block-'));
process.env.CLEMENTINE_HOME = TMP;
mkdirSync(path.join(TMP, 'state'), { recursive: true });

const { catalogPreparationRefusalToCapabilityBlock } = await import('./workflow-runner.js');
const { attachSemanticContract } = await import('../runtime/harness/capability-manifest.js');
const { createCapabilityManifestStore, installCapabilityManifestStore } = await import('../runtime/harness/capability-manifest-store.js');
import type { CapabilityManifestV1 } from '../runtime/harness/capability-manifest.js';

const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

function manifest(operationId: string, accountId: string, suffix: string): CapabilityManifestV1 {
  return attachSemanticContract({
    version: 1,
    manifestId: `cap:resolved:${operationId.toLowerCase()}:definition:${suffix}`,
    providerKind: 'composio',
    operationId,
    providerIdentity: 'composio.test',
    providerVersion: 'composio-runtime-v1',
    operationVersion: 'v20260826_00',
    definitionFingerprint: digest(`definition:${operationId}:${accountId}`),
    externalDefinition: {
      version: 1,
      providerInputSchemaDigest: digest(`input:${operationId}`),
      providerOutputSchemaObserved: true,
      providerOutputSchemaDigest: digest(`output:${operationId}`),
      semanticName: operationId,
      behaviorHints: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
    },
    effect: 'read',
    accountId,
    idempotency: { required: false, policy: 'none' },
    reconciliation: { supported: false, policy: 'none' },
    outputContract: { kind: 'records' },
    evidenceContract: { kinds: ['records'], readbackRequired: false },
    provenance: { issuer: 'host:test', issuedAt: '2026-08-31T00:00:00.000Z', trusted: true },
    lifecycle: { state: 'current' },
    advisoryRoles: ['source'],
  });
}

test('two current accounts park as an account choice with the exact choice set', () => {
  installCapabilityManifestStore(createCapabilityManifestStore([
    manifest('OUTLOOK_GET_CALENDAR_VIEW', 'ca_one', 'aaaaaaaaaaaaaaaaaaaaaaaa'),
    manifest('OUTLOOK_GET_CALENDAR_VIEW', 'ca_two', 'bbbbbbbbbbbbbbbbbbbbbbbb'),
  ]));
  try {
    const block = catalogPreparationRefusalToCapabilityBlock(
      { id: 'read_calendar' },
      { reason: 'ambiguous_current_manifest', operationId: 'OUTLOOK_GET_CALENDAR_VIEW' },
    );
    assert.equal(block.reason, 'ambiguous-account');
    assert.equal(block.toolkit, 'outlook');
    assert.deepEqual(block.accountChoiceSet?.candidates.map((c) => c.accountId).sort(), ['ca_one', 'ca_two']);
    assert.match(block.message, /2 connected accounts can run it/);
    assert.doesNotMatch(block.message, /not connected/);
  } finally {
    installCapabilityManifestStore(null);
  }
});

test('one current account or an unknown operation still parks as not-connected', () => {
  installCapabilityManifestStore(createCapabilityManifestStore([
    manifest('OUTLOOK_GET_CALENDAR_VIEW', 'ca_one', 'aaaaaaaaaaaaaaaaaaaaaaaa'),
  ]));
  try {
    const single = catalogPreparationRefusalToCapabilityBlock(
      { id: 'read_calendar' },
      { reason: 'ambiguous_current_manifest', operationId: 'OUTLOOK_GET_CALENDAR_VIEW' },
    );
    assert.equal(single.reason, 'not-connected');
    const missing = catalogPreparationRefusalToCapabilityBlock(
      { id: 'read_calendar' },
      { reason: 'missing_operation', operationId: 'OUTLOOK_NOPE' },
    );
    assert.equal(missing.reason, 'not-connected');
  } finally {
    installCapabilityManifestStore(null);
  }
});
