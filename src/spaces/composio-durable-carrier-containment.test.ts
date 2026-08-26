/**
 * P0 containment for Space Composio execution.
 *
 * Run:
 *   npx tsx --test src/spaces/composio-durable-carrier-containment.test.ts
 *
 * Space declarations are not yet compiled into the shared durable workflow
 * call authority graph. These production entrypoints must therefore stop
 * before the retired raw gateway body, including after a legacy Space action
 * approval has resolved. Local runner/CLI execution remains covered by the
 * established runner and action suites.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-space-carrier-containment-'));

const runner = await import('./runner.js');
const scheduler = await import('./scheduler.js');
const store = await import('./store.js');
const actionGate = await import('./space-action-gate.js');
const approvalRegistry = await import('../runtime/harness/approval-registry.js');

let retiredProviderBodies = 0;

function installRetiredProviderBodyCanary(): void {
  runner._setSpaceComposioDispatchForTests(async () => {
    retiredProviderBodies += 1;
    return {
      ok: true,
      result: { forbidden: true },
      connectionId: 'ca-must-not-run',
      identity: 'must-not-run@example.test',
    };
  });
}

test('manual Composio refresh without shared durable authority is a zero-body refusal', async () => {
  const slug = 'manual-composio-contained';
  store.spaceStore.save({
    id: slug,
    title: 'Manual containment',
    dataSources: [{ id: 'contacts', composioSlug: 'SALESFORCE_GET_CONTACTS' }],
  });
  installRetiredProviderBodyCanary();
  try {
    const result = await runner.refreshSpaceData(slug, 'contacts', { cause: 'manual' });
    assert.equal(result.length, 1);
    assert.equal(result[0]?.ok, false);
    assert.match(result[0]?.error ?? '', /no shared durable call authority/i);
    assert.equal(retiredProviderBodies, 0, 'manual console refresh entered zero provider bodies');
  } finally {
    runner._setSpaceComposioDispatchForTests(null);
    store.spaceStore.archive(slug);
  }
});

test('scheduled Composio refresh without shared durable authority is a zero-body refusal', async () => {
  const slug = 'scheduled-composio-contained';
  store.spaceStore.save({
    id: slug,
    title: 'Scheduled containment',
    dataSources: [{
      id: 'contacts',
      composioSlug: 'SALESFORCE_GET_CONTACTS',
      schedule: '* * * * *',
    }],
  });
  installRetiredProviderBodyCanary();
  try {
    const result = await scheduler.processSpaceSchedules(new Date('2026-08-25T18:42:00.000Z'));
    assert.equal(result.fired, 0);
    assert.equal(result.errors, 1);
    assert.equal(retiredProviderBodies, 0, 'scheduled refresh entered zero provider bodies');
  } finally {
    runner._setSpaceComposioDispatchForTests(null);
    store.spaceStore.archive(slug);
  }
});

test('an approved Composio Space action still needs shared durable call authority and enters zero bodies', async () => {
  const slug = 'approved-action-composio-contained';
  const callerArgs = { draftMarker: 'exact-approved-payload' };
  const record = store.spaceStore.save({
    id: slug,
    title: 'Approved action containment',
    actions: [{
      id: 'publish',
      label: 'Publish exact post',
      composioSlug: 'PROOF_SOCIAL_PUBLISH',
      argsTemplate: { destination: 'proof-only' },
      confirm: true,
    }],
  });
  const action = record.actions[0]!;
  const pending = actionGate.enqueueSpaceActionApproval(record, action, callerArgs);
  assert.equal(
    approvalRegistry.resolve(pending.approvalId, 'approved', 'containment-test').ok,
    true,
  );

  installRetiredProviderBodyCanary();
  try {
    const result = await runner.runSpaceAction(slug, action, callerArgs, {
      approvalId: pending.approvalId,
    });
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.error, /no shared durable call authority/i);
    assert.equal(retiredProviderBodies, 0, 'resolved legacy approval never became physical authority');
    assert.deepEqual(
      runner.replaySpaceActionMutation(slug, action, pending.approvalId),
      { replayed: false },
      'the retired workflow-mutation wrapper did not manufacture a Composio receipt',
    );
  } finally {
    runner._setSpaceComposioDispatchForTests(null);
    store.spaceStore.archive(slug);
  }
});

test('Space runner contains no raw Composio dispatcher or mutation wrapper on its Composio branch', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(path.join(here, 'runner.ts'), 'utf8');
  assert.doesNotMatch(source, /dispatchComposioTool/);
  const composioBody = source.slice(
    source.indexOf('async function runSpaceComposio'),
    source.indexOf('/** Run a single declared data source'),
  );
  const composioActionBranch = source.slice(
    source.indexOf('if (action.composioSlug && action.composioSlug.trim())'),
    source.indexOf('if (action.runner && action.runner.trim())'),
  );
  assert.doesNotMatch(composioBody, /executeWorkflowCallMutation|replayWorkflowCallMutationSlot/);
  assert.doesNotMatch(composioActionBranch, /executeWorkflowCallMutation|replaySpaceActionMutation/);
  const replayBody = source.slice(
    source.indexOf('export function replaySpaceActionMutation'),
    source.indexOf('/**\n * Compatibility entrypoint retained'),
  );
  assert.match(replayBody, /return \{ replayed: false \}/);
  assert.doesNotMatch(replayBody, /replayWorkflowCallMutationSlot/);
  assert.match(composioBody, /executeWorkflowReadOnlyCall/);
  assert.match(composioBody, /executeWorkflowV3Call/);
});
