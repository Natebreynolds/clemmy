import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const fixtureHome = mkdtempSync(path.join(os.tmpdir(), 'clem-native-consent-'));
process.env.CLEMENTINE_HOME = fixtureHome;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.EMBEDDINGS_DISABLED = 'true';
const log = await import('./eventlog.js');
const authority = await import('./accepted-turn-call-authority.js');
const bindings = await import('./host-call-capability-binding.js');
const dispatch = await import('./dispatch-ledger.js');
const contracts = await import('./logical-call-contract.js');
const identities = await import('./attempt-identity.js');
const local = await import('./local-planning-capability.js');
const consent = await import('./host-interactive-consent.js');
const nested = await import('./nested-tool-approval-admission.js');
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
after(() => {
  local._setConfiguredLocalPlanningToolObserverForTests(null);
  log.closeEventLog(); rmSync(fixtureHome, { recursive: true, force: true });
});

async function fixture(mode: 'normal' | 'plan' = 'normal', options: {
  persistBinding?: boolean;
  disclose?: boolean;
} = {}) {
  const sessionId = `native-consent-${randomUUID()}`;
  log.createSession({ id: sessionId, kind: 'chat', userId: 'fixture-owner' });
  const source = log.appendEvent({ sessionId, turn: 1, role: 'user', type: 'user_input_received', data: {
    text: 'Create the exact requested local draft.', taskMode: { version: 1, kind: mode },
  } });
  const observed = await local.observeCurrentLocalPlanningDefinition({ name: 'write_file', carrier: 'work_call' });
  assert.ok(observed.ok);
  if (!observed.ok) throw new Error(observed.reason);
  const definition = observed.definition;
  if (options.disclose !== false) log.appendEvent({ sessionId, turn: 1, role: 'system', type: 'capability_discovered', data: {
    sourceUserSeq: source.seq, capabilities: [{ kind: local.AUTHORIZED_LOCAL_REGISTRY_PROVENANCE,
      providerKind: local.AUTHORIZED_LOCAL_REGISTRY_PROVENANCE, identifier: definition.name,
      capabilityRef: definition.capabilityRef, schemaFingerprint: definition.schemaFingerprint,
      manifestDigest: definition.descriptor.manifestDigest, accountIdentity: definition.accountIdentity,
      localAuthority: definition }],
  } });
  const catalogRevisionDigest = sha(`catalog:${sessionId}`);
  const bindingRevisionDigest = sha(`binding:${sessionId}`);
  const root = authority.armHostCallAuthority({ sessionId, sourceUserSeq: source.seq,
    catalogRevisionDigest, bindingRevisionDigest, maxLogicalCalls: 8, maxParallelCalls: 2 });
  assert.equal(root.status, 'armed');
  if (root.status !== 'armed') throw new Error('missing root');
  const acceptedTaskId = root.authority.identity.acceptedTaskId;
  const args = { path: path.join(fixtureHome, 'new-draft.txt'), content: 'Exact original body.', mode: 'create', append: null };
  const logical = contracts.durableLogicalCallContract(acceptedTaskId, 'write_file', args)!;
  const logicalToolCallId = 'native-create';
  const base = { sessionId, sourceUserSeq: source.seq, acceptedTaskId,
    sourceEventId: root.authority.sourceEventId, sourceEventDigest: root.authority.sourceEventDigest,
    logicalToolCallId, toolName: logical.toolName, argumentDigest: logical.argumentDigest,
    effect: 'local_write' as const, bindingKind: 'local_envelope' as const, capabilityId: definition.capabilityRef,
    schemaFingerprint: definition.schemaFingerprint, accountId: '', invokePortId: 'host:local:work_call',
    operationId: definition.name, manifestId: '', manifestDigest: '',
    engineVersion: root.authority.engineVersion, surfaceVersion: root.authority.surfaceVersion,
    authorityDigest: root.authority.authorityDigest, authorityRevision: root.authority.revision,
    surfaceDigest: root.authority.surfaceDigest, catalogRevisionDigest, bindingRevisionDigest };
  const attestation = { ...base, bindingDigest: bindings.hostCallAttestationBindingDigest(base) };
  authority.withHostCallAttestation(attestation, () => {
    const admitted = dispatch.admitLogicalCall({ identity: { sessionId, sourceUserSeq: source.seq,
      acceptedTaskId, logicalToolCallId }, tool: definition.name, args });
    assert.equal(admitted.status, 'inserted', JSON.stringify(admitted));
    if (options.persistBinding !== false) {
      const bound = bindings.persistHostCallCapabilityBinding({ db: log.openEventLog(), attestation,
        sessionId, sourceUserSeq: source.seq, acceptedTaskId, logicalToolCallId,
        toolName: logical.toolName, argumentDigest: logical.argumentDigest, effect: 'local_write' });
      assert.equal(bound.status, 'bound', JSON.stringify(bound));
    }
  });
  const request = { attestation, args, inputSchema: observed.schema };
  const run = <T>(fn: () => T): T => authority.withHostCallAttestation(attestation, () => identities.withLogicalToolCall({
    sessionId, sourceUserSeq: source.seq, logicalToolCallId, tool: definition.name, args,
  }, fn));
  const check = { sessionId, sourceUserSeq: source.seq, logicalToolCallId, toolName: definition.name, args };
  return { sessionId, source, request, definition, run, check };
}

test('exact source-disclosed native create has one immediate admission and no graph, plan contract or approval', async () => {
  const f = await fixture();
  const result = await consent.evaluateUncoveredHostMutationConsent(f.request);
  assert.equal(result.status, 'decided', JSON.stringify(result));
  if (result.status !== 'decided' || !result.nestedAdmission) throw new Error(JSON.stringify(result));
  assert.equal(result.decision.kind === 'proceed' ? result.decision.basis : null, 'exact_reversible_work');
  assert.equal(result.consentSubject, undefined);
  assert.ok(result.coverage);
  assert.equal(nested.inspectCurrentExactLocalCallAdmission(f.check), false, 'public fields alone carry no authority');
  await f.run(() => nested.withNestedCallAdmission(result.nestedAdmission!, async () => {
    assert.equal(nested.inspectCurrentExactLocalCallAdmission({ ...f.check, sourceUserSeq: f.source.seq + 1 }), false);
    assert.equal(nested.inspectCurrentExactLocalCallAdmission({ ...f.check, logicalToolCallId: 'sibling' }), false);
    assert.equal(nested.inspectCurrentExactLocalCallAdmission({ ...f.check, args: { ...f.request.args, path: 'other.txt' } }), false);
    assert.equal(nested.inspectCurrentExactLocalCallAdmission(f.check), true);
    assert.equal(nested.consumeNestedCallAdmission({ sessionId: f.sessionId, toolName: 'write_file', args: f.request.args }), true);
    assert.equal(nested.inspectCurrentExactLocalCallAdmission(f.check), false);
    assert.equal(nested.consumeNestedCallAdmission({ sessionId: f.sessionId, toolName: 'write_file', args: f.request.args }), false);
    assert.equal(nested.issueStagedParentCallAdmission({ sessionId: f.sessionId, toolName: 'write_file', args: f.request.args }), null);
  }));
  await assert.rejects(async () => f.run(() => nested.withNestedCallAdmission(result.nestedAdmission!, async () => true)), /fresh host-issued/);
  assert.equal(log.getTurnGraphEventForSource(f.sessionId, f.source.seq), null);
  assert.equal((log.openEventLog().prepare('SELECT COUNT(*) AS n FROM expected_work_call_bindings WHERE session_id = ?').get(f.sessionId) as { n: number }).n, 0);
  assert.equal((log.openEventLog().prepare('SELECT COUNT(*) AS n FROM physical_dispatches WHERE session_id = ?').get(f.sessionId) as { n: number }).n, 0);
  assert.equal(log.listEvents(f.sessionId, { types: ['approval_requested'] }).length, 0);
});

test('native admission refuses forged tokens, changed arguments, source mutation, and Plan mode', async () => {
  const f = await fixture();
  await assert.rejects(async () => f.run(() => nested.withNestedCallAdmission({}, async () => true)), /host-issued/);
  for (const args of [{ ...f.request.args, content: 'different' }, { ...f.request.args, mode: 'overwrite' }]) {
    const refused = await consent.evaluateUncoveredHostMutationConsent({ ...f.request, args });
    assert.notEqual(refused.status, 'decided');
  }
  log.openEventLog().prepare("UPDATE events SET data_json = json_set(data_json, '$.text', 'Changed owner request') WHERE id = ?").run(f.source.id);
  const changedSource = await consent.evaluateUncoveredHostMutationConsent(f.request);
  assert.notEqual(changedSource.status, 'decided');
  const planning = await fixture('plan');
  const planned = await consent.evaluateUncoveredHostMutationConsent(planning.request);
  assert.equal(planned.status, 'conflict', 'Plan can never mint this ordinary native execution handoff');
});

test('current schema is revalidated at invocation; reopen can reevaluate only the same disclosed source', async () => {
  const f = await fixture();
  const result = await consent.evaluateUncoveredHostMutationConsent(f.request);
  assert.ok(result.status === 'decided' && result.nestedAdmission, JSON.stringify(result));
  if (result.status !== 'decided' || !result.nestedAdmission) return;
  local._setConfiguredLocalPlanningToolObserverForTests(() => null);
  try {
    await assert.rejects(() => f.run(() => nested.withNestedCallAdmission(result.nestedAdmission!, async () => assert.fail('stale body ran'))), /definition changed/);
  } finally { local._setConfiguredLocalPlanningToolObserverForTests(null); }
  log.closeEventLog();
  const reopened = await consent.evaluateUncoveredHostMutationConsent(f.request);
  assert.ok(reopened.status === 'decided' && reopened.nestedAdmission, JSON.stringify(reopened));
  const later = log.appendEvent({ sessionId: f.sessionId, turn: 2, role: 'user', type: 'user_input_received', data: { text: 'A later task.' } });
  assert.equal(local.nominateDisclosedLocalPlanningDefinition({ ...f.check, sourceUserSeq: later.seq,
    capabilityRef: f.definition.capabilityRef, operationId: 'write_file', effect: 'local_write' }), null);
});

test('an unused native handoff expires when its immediate invocation returns', async () => {
  const f = await fixture();
  const result = await consent.evaluateUncoveredHostMutationConsent(f.request);
  assert.ok(result.status === 'decided' && result.nestedAdmission, JSON.stringify(result));
  if (result.status !== 'decided' || !result.nestedAdmission) return;
  let release!: () => void;
  const later = new Promise<void>(resolve => { release = resolve; });
  let probe!: Promise<boolean>;
  await f.run(() => nested.withNestedCallAdmission(result.nestedAdmission!, async () => {
    assert.equal(nested.inspectCurrentExactLocalCallAdmission(f.check), true);
    probe = later.then(() => nested.inspectCurrentExactLocalCallAdmission(f.check));
  }));
  release();
  assert.equal(await probe, false, 'a detached continuation cannot retain unspent native authority');
});

test('native coverage requires both the persisted exact call and its current-source disclosure', async () => {
  const missingBinding = await fixture('normal', { persistBinding: false });
  const unbound = await consent.evaluateUncoveredHostMutationConsent(missingBinding.request);
  assert.deepEqual(unbound, {
    status: 'hold', reason: 'exact_host_call_durable_authority_reopen_mismatch', retryable: true,
  });

  const missingDisclosure = await fixture('normal', { disclose: false });
  const undisclosed = await consent.evaluateUncoveredHostMutationConsent(missingDisclosure.request);
  assert.deepEqual(undisclosed, {
    status: 'hold', reason: 'bound_local_definition_unavailable', retryable: true,
  });
  for (const f of [missingBinding, missingDisclosure]) {
    assert.equal((log.openEventLog().prepare('SELECT COUNT(*) AS n FROM physical_dispatches WHERE session_id = ?')
      .get(f.sessionId) as { n: number }).n, 0);
  }
});
