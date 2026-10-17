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

const { catalogPreparationRefusalToCapabilityBlock, workflowCapabilityNotificationPresentation } = await import('./workflow-runner.js');
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

test('a check that could not complete parks as retryable, never as not-connected or a definition mismatch', () => {
  // Live 2026-10-16: a network blip during the connection re-check parked one
  // scheduled workflow as "not connected" and another as an unretryable
  // definition mismatch that held every later run.
  const block = catalogPreparationRefusalToCapabilityBlock(
    { id: 'main' },
    { reason: 'selected_definition_revalidation_refused', operationId: 'GOOGLESHEETS_BATCH_GET',
      detail: 'selected_connection_refresh_unavailable' },
  );
  assert.equal(block.reason, 'connection-check-unavailable');
  assert.match(block.message, /could not complete/);
  assert.match(block.message, /refresh_unavailable/, 'the refusal code rides along for the honest notice');
  assert.doesNotMatch(block.message, /not connected|operation name is wrong/);
});

test('a check that could not complete offers a retry, never "open Connections"', () => {
  const block = catalogPreparationRefusalToCapabilityBlock(
    { id: 'main' },
    { reason: 'selected_definition_revalidation_refused', operationId: 'GOOGLESHEETS_BATCH_GET',
      detail: 'selected_connection_refresh_unavailable' },
  );
  const presentation = workflowCapabilityNotificationPresentation('Fixture review', {
    stepId: block.stepId, tool: block.tool, toolkit: block.toolkit, reason: block.reason, message: block.message,
    blockedAt: new Date().toISOString(), retryAt: new Date(Date.now() + 60_000).toISOString(), retryCount: 1,
    provenNoDispatch: true, state: 'blocked',
  } as never);
  assert.equal(presentation.resolution.kind, 'retry_check');
  assert.match(presentation.detail, /could not reach/i);
});

test('a definition the provider would not describe is not called an unreachable service', () => {
  // It may be a missing or changed operation; a retry would never fix it.
  const block = catalogPreparationRefusalToCapabilityBlock(
    { id: 'main' },
    { reason: 'selected_definition_revalidation_refused', operationId: 'GOOGLESHEETS_BATCH_GET',
      detail: 'selected_definition_exact_refresh_unavailable' },
  );
  assert.notEqual(block.reason, 'connection-check-unavailable');
});

test('once the automatic tries are spent the notice stops promising another try', () => {
  const block = catalogPreparationRefusalToCapabilityBlock(
    { id: 'main' },
    { reason: 'selected_definition_revalidation_refused', operationId: 'GOOGLESHEETS_BATCH_GET',
      detail: 'selected_connection_refresh_unavailable' },
  );
  const presentation = workflowCapabilityNotificationPresentation('Fixture review', {
    stepId: block.stepId, tool: block.tool, toolkit: block.toolkit, reason: block.reason, message: block.message,
    blockedAt: new Date().toISOString(), retryAt: new Date(Date.now() + 60_000).toISOString(), retryCount: 5,
    provenNoDispatch: true, state: 'blocked',
  } as never);
  assert.match(presentation.detail, /tried 5 times/);
  assert.doesNotMatch(presentation.detail, /I'll try again/);
});
