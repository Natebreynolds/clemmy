/** Actual isolated logical/binding/crossing/settlement producers; no model or
 * provider is contacted. A later unrelated observation never proves a write. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-pending-unacknowledged-'));
process.env.CLEMENTINE_HOME = home;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(home, 'state'), { recursive: true });
writeFileSync(path.join(home, 'state', 'machine-id'), 'machine-pending-unacknowledged\n');

const events = await import('./eventlog.js');
const authorities = await import('./accepted-turn-call-authority.js');
const bindings = await import('./host-call-capability-binding.js');
const identities = await import('./attempt-identity.js');
const contracts = await import('./logical-call-contract.js');
const leases = await import('./dispatch-lease.js');
const brackets = await import('./brackets.js');
const invocation = await import('./host-tool-invocation.js');
const projection = await import('./external-write-event-projection.js');
const audit = await import('./accepted-source-settlement-audit.js');
const manifestTools = await import('./capability-manifest.js');
const manifestStores = await import('./capability-manifest-store.js');
const catalogs = await import('./host-capability-catalog-factory.js');
const typedRuntime = await import('../semantic-boundary/configure-typed-execution-runtime.js');
const typedAuthority = await import('./resolved-call-authority.js');
const dispatches = await import('./dispatch-ledger.js');
const semantic = await import('../semantic-boundary/semantic-disposition.js');
const shadow = await import('../graph/turn-graph-shadow.js');
const canonicalLeases = await import('./canonical-graph-node-lease.fixture.js');
const crossings = await import('./physical-crossing-identity.js');
const observations = await import('./independent-capability-observation.js');
const typedPorts = await import('./isolated-attested-transport.fixture.js');
const settlements = await import('./logical-call-settlement-store.js');
const outcomes = await import('./attempt-outcome.js');
const { readPendingUnacknowledgedWritesForSource: read } = await import('./pending-unacknowledged-writes.js');

test.after(() => { events.closeEventLog(); rmSync(home, { recursive: true, force: true }); });

const digest = (text: string) => createHash('sha256').update(text).digest('hex');
let serial = 0;
function fixture() {
  const session = events.createSession({ id: `pending-write-${++serial}`, kind: 'chat' });
  const source = events.appendEvent({ sessionId: session.id, turn: 1, role: 'user',
    type: 'user_input_received', data: { text: 'Update the named controlled records, then report what happened.' } });
  const armed = authorities.armHostCallAuthority({ sessionId: session.id, sourceUserSeq: source.seq,
    catalogRevisionDigest: digest(`catalog:${session.id}`), bindingRevisionDigest: digest(`binding:${session.id}`),
    maxLogicalCalls: 20, maxParallelCalls: 4 });
  assert.equal(armed.status, 'armed');
  const parentLease = leases.activateDispatchLease({ sessionId: session.id, scopeId: `${session.id}::parent` });
  const identity = { sessionId: session.id, sourceUserSeq: source.seq };
  return { ...identity, acceptedTaskId: identities.acceptedTaskIdFor(session.id, source.seq), parentLease,
    context: { ...identity, turn: 1, counter: new brackets.ToolCallsCounter(20), dispatchLease: parentLease } };
}

async function call(task: ReturnType<typeof fixture>, id: string,
  effect: 'read' | 'compute' | 'local_write' | 'external_write' | 'admin',
  invoke: () => Promise<unknown>, account = 'account:controlled') {
  const toolName = effect === 'read' ? 'controlled_read' : effect === 'compute' ? 'controlled_compute' : 'controlled_write';
  const args = { record_id: id };
  const root = authorities.acceptedTurnCallAuthorityFor(task.sessionId, task.sourceUserSeq);
  assert.equal(root.status, 'ok');
  if (root.status !== 'ok') throw new Error(root.reason);
  const contract = contracts.durableLogicalCallContract(task.acceptedTaskId, toolName, args)!;
  const base = {
    ...task, logicalToolCallId: id, toolName: contract.toolName, argumentDigest: contract.argumentDigest,
    sourceEventId: root.authority.sourceEventId, sourceEventDigest: root.authority.sourceEventDigest,
    effect, bindingKind: 'catalog_manifest' as const, capabilityId: `cap:${toolName}`,
    schemaFingerprint: digest(`schema:${toolName}`), accountId: account, invokePortId: 'controlled:invoke',
    operationId: toolName, manifestId: `manifest:${toolName}`, manifestDigest: digest(`manifest:${toolName}`),
    engineVersion: root.authority.engineVersion, surfaceVersion: root.authority.surfaceVersion,
    authorityDigest: root.authority.authorityDigest, authorityRevision: root.authority.revision,
    surfaceDigest: root.authority.surfaceDigest, catalogRevisionDigest: root.authority.catalogRevisionDigest!,
    bindingRevisionDigest: root.authority.bindingRevisionDigest!,
  };
  const attestation = { ...base, bindingDigest: bindings.hostCallAttestationBindingDigest(base) };
  return authorities.withHostCallAttestation(attestation, () => brackets.withHarnessRunContext(task.context,
    () => invocation.invokeHostToolCall({ identity: { ...task, modelCallId: id, toolName, args, turn: 1 },
      parentLease: task.parentLease, effect, businessCall: true, boundary: 'host_owned_external',
      deadlineMs: 500, invoke })));
}

async function unknown(task: ReturnType<typeof fixture>, id: string, effect: 'external_write' | 'admin' = 'external_write') {
  await assert.rejects(call(task, id, effect, async () => { throw new Error('socket hang up'); }), /socket hang up/);
  const row = events.openEventLog().prepare(`SELECT outcome_kind, outcome_detail, requires_reconciliation
    FROM logical_call_settlements WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?`)
    .get(task.sessionId, task.sourceUserSeq, id);
  assert.deepEqual(row, { outcome_kind: 'uncertain_write', outcome_detail: 'unacknowledged_mutation', requires_reconciliation: 1 });
}

function resolved(task: ReturnType<typeof fixture>, id: string, type: 'external_write_succeeded' | 'external_write_failed',
  data: Record<string, unknown> = {}) {
  const reservation = events.listEvents(task.sessionId, { types: ['external_write'] })
    .find(event => event.data.canonicalCallId === id)!;
  const identity = projection.externalWriteProjectionIdentityFromReservation(reservation)!;
  projection.projectExternalWriteTerminal({ ...task, ...identity,
    physicalDispatchId: String(reservation.data.physicalDispatchId), type, reason: 'verified_fixture_resolution', data });
  return reservation;
}

test('two exact unknown calls survive unrelated/failed/partial reads, compute and database re-entry', async () => {
  const task = fixture();
  await unknown(task, 'write-a');
  await unknown(task, 'write-b', 'admin');
  const initial = read(task);
  assert.equal(initial.status, 'ok');
  if (initial.status !== 'ok') return;
  assert.deepEqual(initial.pending.map(row => row.logicalToolCallId), ['write-a', 'write-b']);
  assert.deepEqual(initial.pending.map(row => [row.accountId, row.effect]),
    [['account:controlled', 'external_write'], ['account:controlled', 'admin']]);
  assert.ok(initial.pending.every(row => row.physicalDispatchIds.length === 1 && /^[a-f0-9]{64}$/.test(row.authorityDigest)));
  await call(task, 'unrelated-read', 'read', async () => ({ successful: true, data: { record_id: 'unrelated' } }));
  await call(task, 'failed-read', 'read', async () => ({ successful: false, error: { code: 'not_found' } }));
  await call(task, 'partial-read', 'read', async () => ({ successful: true, data: { items: [], next_cursor: 'more' } }));
  await call(task, 'compute', 'compute', async () => ({ successful: true, data: { value: 667 } }));
  await call(task, 'other-account-read', 'read', async () => ({ successful: true, data: { record_id: 'write-a' } }), 'account:other');
  assert.deepEqual(read(task), initial, 'no observation is upgraded into write-resolution authority');
  events.closeEventLog();
  assert.deepEqual(read(task), initial, 'the inventory reopens its durable call identities after restart');
  const facts = audit.auditAcceptedSourceSettlementTruth(task);
  assert.equal(facts.status, 'uncertain_write');
  assert.equal(facts.facts.blockingUncertainWrites, 2);
  leases.revokeDispatchLease(task.parentLease);
});

for (const [type, expected] of [['external_write_succeeded', 'present'], ['external_write_failed', 'absent']] as const) {
  test(`one exact original reservation terminal resolves ${expected}, without resolving another call`, async () => {
    const task = fixture();
    await unknown(task, 'one');
    await unknown(task, 'two');
    const reservation = resolved(task, 'one', type);
    const result = read(task);
    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') return;
    assert.deepEqual(result.pending.map(row => row.logicalToolCallId), ['two']);
    assert.equal(result.resolved.length, 1);
    assert.equal(result.resolved[0]!.resolution, expected);
    assert.equal(result.resolved[0]!.reservationEventId, reservation.id);
    const auditResult = audit.auditAcceptedSourceSettlementTruth(task);
    assert.equal(auditResult.status, 'uncertain_write');
    assert.equal(auditResult.facts.blockingUncertainWrites, 1);
    events.closeEventLog();
    assert.deepEqual(read(task), result, 'resolution belongs to that same original call after re-entry');
    leases.revokeDispatchLease(task.parentLease);
  });
}

test('generic execution reconciliation and account-conflicting terminals are not promoted', async () => {
  for (const data of [{ reconciledBy: 'execution_reconcile_write' }, { reconciledBy: 'artifact_ledger' }, { accountId: 'account:other' }]) {
    const task = fixture();
    await unknown(task, 'held');
    resolved(task, 'held', 'external_write_succeeded', data);
    const result = read(task);
    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') continue;
    assert.equal(result.pending.length, 1);
    assert.equal(result.resolved.length, 0);
    assert.equal(audit.auditAcceptedSourceSettlementTruth(task).status, 'uncertain_write');
    leases.revokeDispatchLease(task.parentLease);
  }
});

test('a foreign source or a successful sibling write cannot resolve an unknown call', async () => {
  const task = fixture();
  await unknown(task, 'original');
  await call(task, 'sibling', 'external_write', async () => ({ successful: true, data: { record_id: 'original' } }));
  const otherSource = events.appendEvent({ sessionId: task.sessionId, turn: 2, role: 'user',
    type: 'user_input_received', data: { text: 'A separate task.' } });
  const other = read({ sessionId: task.sessionId, sourceUserSeq: otherSource.seq });
  assert.deepEqual(other, { status: 'ok', pending: [], resolved: [] }, 'another accepted source never borrows the earlier freeze');
  const result = read(task);
  assert.equal(result.status, 'ok');
  if (result.status !== 'ok') return;
  assert.deepEqual(result.pending.map(row => row.logicalToolCallId), ['original']);
  leases.revokeDispatchLease(task.parentLease);
});

test('provider refusal and contradiction remain answered, never a missing acknowledgement inventory', async () => {
  const task = fixture();
  await call(task, 'refusal', 'external_write', async () => ({ successful: false, error: { code: 'not_found' } }));
  await call(task, 'contradiction', 'external_write', async () => ({ successful: true, data: { success: false, error: 'not found' } }));
  assert.deepEqual(read(task), { status: 'ok', pending: [], resolved: [] });
  assert.equal(audit.auditAcceptedSourceSettlementTruth(task).facts.blockingUncertainWrites, 0);
  leases.revokeDispatchLease(task.parentLease);
});

test('an exact host-bound local write is not promoted into the external/admin write freeze', async () => {
  const task = fixture();
  await assert.rejects(call(task, 'local-write', 'local_write', async () => { throw new Error('socket hang up'); }), /socket hang up/);
  assert.deepEqual(read(task), { status: 'ok', pending: [], resolved: [] });
  leases.revokeDispatchLease(task.parentLease);
});

test('the original sealed typed local effect excludes a write without a host-v1 binding', async () => {
  const session = events.createSession({ id: `pending-typed-local-${++serial}`, kind: 'chat' });
  const source = events.appendEvent({ sessionId: session.id, turn: 1, role: 'user',
    type: 'user_input_received', data: { text: 'Update the controlled local record.' } });
  const task = { sessionId: session.id, sourceUserSeq: source.seq,
    acceptedTaskId: identities.acceptedTaskIdFor(session.id, source.seq) };
  semantic.recordSemanticParticipation(session.id, source.seq, 'participated');
  assert.ok(shadow.recordTurnGraphShadow({ identity: { ...task, turn: 1 } }));
  const manifest = manifestTools.attachSemanticContract({ version: 1,
    manifestId: 'cap:pending:local', providerKind: 'local_registry', operationId: 'controlled_local_write',
    providerIdentity: 'local_registry', providerVersion: 'local-v1', operationVersion: '1',
    definitionFingerprint: digest('pending-local-schema'), effect: 'local_write',
    accountId: 'account:controlled:local', destination: { family: 'workspace', posture: 'named_existing' },
    idempotency: { required: true, policy: 'key_before_dispatch' },
    reconciliation: { supported: false, policy: 'uncertain_if_absent' },
    outputContract: { kind: 'created_resource' },
    evidenceContract: { kinds: ['receipt', 'readback'], readbackRequired: true },
    provenance: { issuer: 'host:pending-local-fixture', issuedAt: '2026-10-13T00:00:00.000Z', trusted: true },
    lifecycle: { state: 'current' }, advisoryRoles: ['destination'] });
  const priorStore = manifestStores.peekCapabilityManifestStore();
  const priorCatalog = catalogs.peekHostCapabilityCatalogFactory();
  try {
    const store = manifestStores.createCapabilityManifestStore();
    assert.equal(store.install(manifest).ok, true);
    manifestStores.installCapabilityManifestStore(store);
    catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory([{
      capabilityId: manifest.manifestId, toolName: manifest.operationId,
      schemaVersion: manifest.operationVersion, schemaDigest: manifest.definitionFingerprint,
      effect: manifest.effect, account: manifest.accountId,
      manifestDigest: manifestTools.capabilityManifestDigest(manifest), providerKind: manifest.providerKind,
      liveFingerprint: manifest.definitionFingerprint, manifest, invoke: async () => ({}) }]));
    typedRuntime.configureTypedExecutionRuntime();
    typedPorts.registerShippedTestPort(manifest);
    typedRuntime.refreshTypedExecutionReadiness();
    const graphId = `graph:${session.id}`;
    const nodeId = 'write-local';
    const logicalCallId = 'original-local';
    const lease = canonicalLeases.acquireCanonicalGraphNodeLease({ ...task, graphId, nodeId, owner: session.id });
    assert.equal(lease.ok, true);
    if (!lease.ok) throw new Error(lease.reason);
    const observation = observations.independentlyObserveCapability(manifest.operationId, manifest.accountId);
    assert.ok(observation);
    const args = { record_id: 'controlled-local-record', content: 'one exact value' };
    const physicalDispatchId = crossings.derivePhysicalDispatchId({ ...task, graphId, nodeId,
      logicalCallId, ordinal: 1, relation: 'primary' });
    const minted = typedAuthority.mintResolvedCallAuthority({ acceptedSource: task,
      acceptedTaskId: task.acceptedTaskId, goalRevision: 0, graphId, graphHash: digest(graphId), nodeId,
      operationId: manifest.operationId, capabilityRef: manifest.manifestId, manifest,
      canonicalArgumentDigest: '', canonicalArgs: args, logicalCallId,
      liveFingerprint: manifest.definitionFingerprint, liveProviderVersion: manifest.providerVersion,
      liveAccountId: manifest.accountId, nodeEffect: manifest.effect, graphCeiling: manifest.effect,
      graphDestination: manifest.destination,
      policySnapshotDigest: digest('local-policy'), catalogSnapshotDigest: digest('local-catalog'),
      writeJudge: { identity: 'judge:controlled-local', digest: digest('local-judge') },
      groundingIdentity: 'ground:controlled-local', groundingReceiptDigest: digest('local-grounding'),
      proposalDigest: digest('local-proposal'), claimEventId: source.id,
      semanticProvenanceDigest: digest('local-provenance'), physicalDispatchId, ordinal: 1,
      relation: 'primary', ownerFence: lease.ownerFence, observation: observation! });
    assert.equal(minted.ok, true, JSON.stringify(minted));
    if (!minted.ok) throw new Error(minted.reason);
    const identity = { ...task, logicalToolCallId: logicalCallId, physicalDispatchId, ordinal: 1 };
    assert.equal(dispatches.beginTypedPhysicalDispatch({ authority: minted.authority, identity,
      executionSite: 'host' }).status, 'inserted');
    assert.equal(dispatches.settlePhysicalDispatch({ identity, tool: manifest.operationId, outcome: 'threw',
      authorityDigest: minted.authority.authorityDigest }).status, 'inserted');
    const settlement = settlements.commitLogicalCallSettlement({ identity: { ...task, logicalToolCallId: logicalCallId },
      contract: { toolName: manifest.operationId, args }, execution: { kind: 'local_execution' },
      outcome: outcomes.classifyAttemptOutcome({ mutating: true, acknowledged: false }),
      recovery: { businessCall: false, mutating: true }, observer: { lane: 'agents_runner', turn: 1 } });
    assert.equal(settlement.status, 'committed', JSON.stringify(settlement));
    assert.equal(bindings.loadHostCallCapabilityBinding({ db: events.openEventLog(), ...task,
      logicalToolCallId: logicalCallId }).status, 'missing');
    assert.deepEqual(read(task), { status: 'ok', pending: [], resolved: [] });
    events.closeEventLog();
    assert.deepEqual(read(task), { status: 'ok', pending: [], resolved: [] }, 'classification survives process-local catalog loss/re-entry');
    const copyPath = path.join(home, 'typed-local-authority-corruption.db');
    await events.openEventLog().backup(copyPath);
    const corrupted = new Database(copyPath);
    try {
      const triggers = corrupted.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'physical_dispatch_authority_sealed'`)
        .all() as Array<{ name: string }>;
      for (const trigger of triggers) corrupted.exec(`DROP TRIGGER "${trigger.name.replaceAll('"', '""')}"`);
      corrupted.prepare(`UPDATE physical_dispatch_authority_sealed SET sealed_json = ? WHERE session_id = ?`)
        .run(JSON.stringify({ ...JSON.parse(typedAuthority.serializeResolvedCallAuthority(minted.authority)),
          resolvedEffect: 'read' }), session.id);
      assert.equal(read(task, corrupted).status, 'unavailable', 'an altered effect cannot downgrade a frozen authority');
    } finally { corrupted.close(); }
  } finally {
    manifestStores.installCapabilityManifestStore(priorStore);
    catalogs.installHostCapabilityCatalogFactory(priorCatalog);
  }
});

test('storage unavailable, missing source, missing binding and temporary authority shadows hold', async () => {
  const empty = new Database(':memory:');
  assert.equal(read({ sessionId: 'absent', sourceUserSeq: 1 }, empty).status, 'unavailable');
  empty.close();
  const task = fixture();
  await unknown(task, 'held');
  const db = events.openEventLog();
  assert.equal(read({ ...task, sourceUserSeq: Number.MAX_SAFE_INTEGER }).status, 'unavailable');
  db.exec('CREATE TEMP TABLE host_call_capability_bindings (id TEXT)');
  try { assert.equal(read(task).status, 'unavailable'); }
  finally { db.exec('DROP TABLE temp.host_call_capability_bindings'); }
  const copyPath = path.join(home, 'binding-corruption.db');
  await db.backup(copyPath);
  const cloned = new Database(copyPath);
  try {
    const triggers = cloned.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'host_call_capability_bindings'`)
      .all() as Array<{ name: string }>;
    for (const trigger of triggers) cloned.exec(`DROP TRIGGER "${trigger.name.replaceAll('"', '""')}"`);
    cloned.prepare(`DELETE FROM host_call_capability_bindings WHERE session_id = ? AND source_user_seq = ?`)
      .run(task.sessionId, task.sourceUserSeq);
    assert.equal(read(task, cloned).status, 'unavailable', 'missing binding cannot manufacture an empty inventory');
  } finally { cloned.close(); }
  leases.revokeDispatchLease(task.parentLease);
});
