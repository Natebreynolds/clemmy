/**
 * Run: node scripts/run-tests-isolated.mjs src/spaces/space-action-v3-authority.integration.red.test.ts
 *
 * An approved Workspace Composio action is one exact workflow_v3_call
 * occurrence. The Workspace approval is the human decision; the shared kernel
 * remains the only logical/physical dispatch and settlement owner.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-space-action-v3-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';

const approvals = await import('../runtime/harness/approval-registry.js');
const catalogs = await import('../runtime/harness/host-capability-catalog-factory.js');
const eventlog = await import('../runtime/harness/eventlog.js');
const manifests = await import('../runtime/harness/capability-manifest.js');
const observations = await import('../runtime/harness/independent-capability-observation.js');
const ports = await import('../runtime/harness/production-capability-ports.js');
const dataStore = await import('./data-store.js');
const gate = await import('./space-action-gate.js');
const actionV3 = await import('./space-action-v3-authority.js');
const store = await import('./store.js');

const OPERATION = 'PROOF_SOCIAL_PUBLISH_EXACT';
const digest = (label: string): string => createHash('sha256').update(label, 'utf8').digest('hex');

function installActionCapability(options: {
  accountId?: string;
  schemaLabel?: string;
  capabilityLabel?: string;
} = {}): {
  bodies: () => number;
  providerArgs: Array<Record<string, unknown>>;
} {
  const accountId = options.accountId ?? 'account.space-action.primary';
  const schemaLabel = options.schemaLabel ?? 'schema:space-action-publish';
  const capabilityLabel = options.capabilityLabel ?? 'primary';
  const manifest = manifests.attachSemanticContract({
    version: 1,
    manifestId: `manifest.space.action.publish.${capabilityLabel}`,
    providerKind: 'local_registry',
    operationId: OPERATION,
    providerIdentity: 'runtime.space-action-test',
    providerVersion: 'runtime.1',
    operationVersion: '1',
    definitionFingerprint: digest(schemaLabel),
    effect: 'external_write',
    accountId,
    idempotency: { required: false, policy: 'none' },
    reconciliation: { supported: false, policy: 'none' },
    outputContract: { kind: 'records' },
    purpose: 'bounded_write',
    acceptedInputKinds: ['scope'],
    producedOutputKinds: ['records'],
    applicableDeliverableKinds: ['records'],
    evidenceContract: { kinds: ['records'], readbackRequired: false },
    provenance: { issuer: 'space.action.test', issuedAt: '2026-08-27T00:00:00.000Z', trusted: true },
    lifecycle: { state: 'current' },
    advisoryRoles: ['write'],
  });
  let bodies = 0;
  const providerArgs: Array<Record<string, unknown>> = [];
  assert.equal(ports.registerFixtureCapabilityPort(
    ports.productionPortIdentityFromManifest(manifest),
    {
      invoke: async (input) => {
        bodies += 1;
        providerArgs.push(structuredClone(input.binding.args));
        return { data: { published: true, id: 'post.1' } };
      },
    },
  ).ok, true);
  const entry: catalogs.RegisteredHostCapability = {
    capabilityId: `capability.space.action.publish.${capabilityLabel}`,
    toolName: manifest.operationId,
    schemaVersion: manifest.operationVersion,
    schemaDigest: manifest.definitionFingerprint,
    effect: manifest.effect,
    account: manifest.accountId,
    advisoryRoles: manifest.advisoryRoles,
    manifestDigest: manifests.capabilityManifestDigest(manifest),
    providerKind: manifest.providerKind,
    liveFingerprint: manifest.definitionFingerprint,
    manifest,
    invoke: async () => { throw new Error('catalog callback cannot own Space action I/O'); },
  };
  catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory([entry]));
  assert.equal(observations.registerIndependentCapabilityObservation({
    operationId: manifest.operationId,
    accountId: manifest.accountId,
    definitionFingerprint: manifest.definitionFingerprint,
    providerVersion: manifest.providerVersion,
    operationVersion: manifest.operationVersion,
    observedAt: Date.now(),
    origin: 'independent',
    observe: () => ({
      operationId: manifest.operationId,
      accountId: manifest.accountId,
      definitionFingerprint: manifest.definitionFingerprint,
      providerVersion: manifest.providerVersion,
      operationVersion: manifest.operationVersion,
      observedAt: Date.now(),
    }),
  }).ok, true);
  return { bodies: () => bodies, providerArgs };
}

function clearCapability(): void {
  catalogs.installHostCapabilityCatalogFactory(null);
  observations.clearIndependentCapabilityObservations();
  ports.clearProductionCapabilityPorts();
}

function exactAction() {
  return {
    id: 'publish',
    label: 'Publish exact post',
    composioSlug: OPERATION,
    argsTemplate: { destination: 'timeline' },
    confirm: true,
  };
}

test.after(() => {
  catalogs.installHostCapabilityCatalogFactory(null);
  observations.clearIndependentCapabilityObservations();
  ports.clearProductionCapabilityPorts();
  eventlog.closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

test.afterEach(() => {
  clearCapability();
});

test('approved exact Space action dispatches once through workflow_v3_call and settled replay is zero-body', async () => {
  const capability = installActionCapability();
  const slug = 'approved-v3-action';
  const action = exactAction();
  const callerArgs = { message: 'exact approved payload' };
  const record = store.spaceStore.save({
    id: slug,
    title: 'Approved v3 action',
    actions: [action],
  });
  const pending = gate.enqueueSpaceActionApproval(record, record.actions[0]!, callerArgs);
  const resolved = approvals.resolve(pending.approvalId, 'approved', 'space-action-v3-test');
  assert.equal(resolved.ok, true);
  assert.ok(resolved.row);

  eventlog.closeEventLog();
  await gate.executeApprovedSpaceAction(resolved.row!);
  assert.equal(capability.bodies(), 1, 'the approved exact action enters one provider body');
  assert.deepEqual(capability.providerArgs, [{ destination: 'timeline', message: 'exact approved payload' }]);

  eventlog.closeEventLog();
  await gate.executeApprovedSpaceAction(resolved.row!);
  assert.equal(capability.bodies(), 1, 'the settled call replays without provider I/O');
  assert.equal(
    dataStore.listNotes(slug).filter((note) => (
      note.meta?.approvalId === pending.approvalId && note.meta?.status === 'executed'
    )).length,
    1,
  );

  const db = eventlog.openEventLog();
  assert.equal((db.prepare(`
    SELECT COUNT(*) AS n FROM accepted_turn_call_authorities
     WHERE authority_kind = 'workflow_v3_call'
  `).get() as { n: number }).n, 1);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM physical_dispatches').get() as { n: number }).n, 1);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM logical_call_settlements').get() as { n: number }).n, 1);
});

test('wrong caller args or Workspace slug cannot redeem the exact approval', () => {
  const capability = installActionCapability();
  const slug = 'approval-identity-refusal';
  const action = exactAction();
  const callerArgs = { message: 'approved bytes' };
  const record = store.spaceStore.save({ id: slug, title: 'Identity refusal', actions: [action] });
  const pending = gate.enqueueSpaceActionApproval(record, record.actions[0]!, callerArgs);
  assert.equal(approvals.resolve(pending.approvalId, 'approved', 'space-action-v3-test').ok, true);

  const wrongArgs = actionV3.acquireApprovedSpaceActionV3Authority({
    approvalId: pending.approvalId,
    slug,
    action: record.actions[0]!,
    callerArgs: { message: 'changed bytes' },
  });
  assert.equal(wrongArgs.ok, false);
  assert.match(wrongArgs.ok ? '' : wrongArgs.error, /approval.*caller arguments/i);

  const wrongSlug = actionV3.acquireApprovedSpaceActionV3Authority({
    approvalId: pending.approvalId,
    slug: 'foreign-workspace',
    action: record.actions[0]!,
    callerArgs,
  });
  assert.equal(wrongSlug.ok, false);
  assert.match(wrongSlug.ok ? '' : wrongSlug.error, /approval.*tool\/session|approval.*Workspace action/i);
  assert.equal(capability.bodies(), 0);
  assert.equal(approvals.get(pending.approvalId)?.consumedAt, null, 'refusals do not spend the grant');
});

test('action-manifest drift after approval remains zero-body', async () => {
  const capability = installActionCapability();
  const slug = 'action-manifest-drift';
  const action = exactAction();
  const record = store.spaceStore.save({ id: slug, title: 'Action drift', actions: [action] });
  const pending = gate.enqueueSpaceActionApproval(record, record.actions[0]!, { message: 'approved' });
  const resolved = approvals.resolve(pending.approvalId, 'approved', 'space-action-v3-test');
  assert.ok(resolved.row);
  store.spaceStore.update(slug, {
    actions: [{ ...action, argsTemplate: { destination: 'changed-after-approval' } }],
  });

  await gate.executeApprovedSpaceAction(resolved.row!);
  assert.equal(capability.bodies(), 0);
  assert.equal(approvals.get(pending.approvalId)?.consumedAt, null);
  assert.ok(dataStore.listNotes(slug).some((note) => (
    note.meta?.approvalId === pending.approvalId
    && note.meta?.status === 'failed'
    && /action changed after approval/i.test(note.text)
  )));
});

test('live account or schema drift after approval refuses before activation and provider I/O', async () => {
  for (const drift of [
    {
      slug: 'account-drift',
      replacement: { accountId: 'account.space-action.foreign' },
    },
    {
      slug: 'schema-drift',
      replacement: { schemaLabel: 'schema:space-action-publish:v2' },
    },
  ]) {
    const original = installActionCapability();
    const action = exactAction();
    const record = store.spaceStore.save({ id: drift.slug, title: drift.slug, actions: [action] });
    const pending = gate.enqueueSpaceActionApproval(record, record.actions[0]!, { message: 'approved' });
    const resolved = approvals.resolve(pending.approvalId, 'approved', 'space-action-v3-test');
    assert.ok(resolved.row);

    clearCapability();
    const replacement = installActionCapability(drift.replacement);
    await gate.executeApprovedSpaceAction(resolved.row!);
    assert.equal(original.bodies(), 0, `${drift.slug}: old capability never ran`);
    assert.equal(replacement.bodies(), 0, `${drift.slug}: changed capability never ran`);
    assert.equal(approvals.get(pending.approvalId)?.consumedAt, null, `${drift.slug}: grant remains unspent`);
    assert.ok(dataStore.listNotes(drift.slug).some((note) => (
      note.meta?.approvalId === pending.approvalId
      && note.meta?.status === 'failed'
      && /provider operation, account, schema, arguments, or action binding changed/i.test(note.text)
    )));
    clearCapability();
  }
});
