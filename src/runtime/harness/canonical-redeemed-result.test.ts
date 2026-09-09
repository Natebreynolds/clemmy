/**
 * Canonical redeemed-result branches.
 *
 * Run:
 *   node scripts/run-tests-isolated.mjs src/runtime/harness/canonical-redeemed-result.test.ts
 *
 * ADOPTED from the reviewer's C28 canonical fixture. My earlier fixtures never
 * bound a durable result handle, so redemption returned missing and every case
 * landed on the authority-failure path — they proved that path, never these two.
 * This persists through the real kernel (beginPhysicalDispatch →
 * settlePhysicalDispatch → commitLogicalCallSettlement), which writes the
 * durable handle and freezes the crossing set itself, so redemption genuinely
 * succeeds before the collector runs. No skip-on-error branches: any setup
 * failure fails the test.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-redeemed-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.EMBEDDINGS_DISABLED = 'true';
mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'redeemed\n', 'utf8');

const eventlog = await import('./eventlog.js');
const shadow = await import('../graph/turn-graph-shadow.js');
const identities = await import('./attempt-identity.js');
const dispatch = await import('./dispatch-ledger.js');
const outcomes = await import('./attempt-outcome.js');
const settlements = await import('./logical-call-settlement-store.js');
const handles = await import('./result-handle.js');
const runner = await import('./host-turn-runner.js');
const spaces = await import('../../spaces/store.js');
const workspaceDb = await import('../../spaces/workspace-db.js');
const dataset = await import('../../spaces/workspace-set-data-carrier.js');

after(() => { workspaceDb.closeWorkspaceDb(); eventlog.closeEventLog(); rmSync(HOME, { recursive: true, force: true }); });

async function persistCanonicalLocalResult(input: {
  label: string;
  toolName: string;
  args: Record<string, unknown>;
  rawPayload?: unknown;
  /** Actual producer runs inside this fixture's admitted host crossing. */
  produce?: () => unknown | Promise<unknown>;
}) {
  const session = eventlog.createSession({
    id: 'c28-redeemed-' + input.label,
    kind: 'chat', channel: 'desktop', userId: 'private-fixture-owner',
  });
  const source = eventlog.appendEvent({
    sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'Record the private ' + input.label + ' host-result fixture.', userId: 'private-fixture-owner' },
  });
  const task = {
    sessionId: session.id, sourceUserSeq: source.seq, turn: source.turn,
    acceptedTaskId: identities.acceptedTaskIdFor(session.id, source.seq),
  };
  assert.ok(shadow.recordTurnGraphShadow({ identity: task }), 'existing test authority helper must succeed');
  const logicalToolCallId = 'logical:' + input.label;
  const opened = dispatch.beginPhysicalDispatch({
    identity: { ...task, logicalToolCallId, physicalDispatchId: 'dispatch:' + input.label, ordinal: 0 },
    tool: input.toolName, args: input.args, executionSite: 'host',
  });
  assert.equal(opened.status, 'inserted', JSON.stringify(opened));
  if (opened.status !== 'inserted') throw new Error('host crossing fixture admission failed');
  const rawPayload = input.produce ? await input.produce() : input.rawPayload;
  const returned = dispatch.settlePhysicalDispatch({ identity: opened.identity, tool: input.toolName, outcome: 'returned' });
  assert.equal(returned.status, 'inserted', JSON.stringify(returned));
  const identity = { ...task, logicalToolCallId };
  const committed = settlements.commitLogicalCallSettlement({
    identity,
    contract: { toolName: input.toolName, args: input.args },
    execution: { kind: 'local_execution' },
    result: { payload: rawPayload },
    outcome: outcomes.classifyAttemptOutcome({ envelopeSuccessful: true }),
    recovery: { businessCall: true, mutating: true },
    observer: { lane: 'byo', turn: task.turn },
  });
  assert.equal(committed.status, 'committed', JSON.stringify(committed));
  if (committed.status !== 'committed') throw new Error('logical settlement fixture did not commit');
  assert.ok(committed.settlement.resultHandleId, 'canonical transaction must bind the result handle');
  assert.equal(committed.settlement.crossingAuthorityVersion, 2);
  assert.equal(committed.settlement.physicalCrossingCount, 0, 'zero provider crossings');
  assert.equal(committed.settlement.hostCrossingCount, 1);
  const redeemed = handles.redeemSuccessfulSettlementResultForHost(identity);
  assert.equal(redeemed.status, 'ok', JSON.stringify(redeemed));
  if (redeemed.status !== 'ok') throw new Error('real canonical redemption failed');
  assert.equal(redeemed.value.executionSite, 'host');
  assert.equal(redeemed.value.toolName, input.toolName);
  assert.equal(redeemed.value.outcomeKind, 'succeeded');
  assert.deepEqual(redeemed.value.rawPayload, rawPayload, 'retained raw bytes, not a display projection');
  return { input, identity, settlement: committed.settlement, redeemed };
}


test('a REDEEMED acknowledgement discharges the file requirement — contract none', async () => {
  const built = await persistCanonicalLocalResult({
    label: 'acknowledgement',
    toolName: 'workflow_delete',
    args: { name: 'private-fixture-workflow' },
    rawPayload: 'Deleted workflow private-fixture-workflow.',
  });
  const evidence = runner.settledSourceArtifacts({
    sessionId: built.identity.sessionId, sourceUserSeq: built.identity.sourceUserSeq,
  });
  assert.equal(evidence.evidenceAvailable, true);
  assert.equal(evidence.count, 1, 'the deletion is retained as settled work');
  const entry = evidence.artifacts[0]!;
  assert.equal(entry.evidenceContract, 'none',
    'an AUTHENTICATED acknowledgement owes no host file');
  assert.equal(entry.unresolvedReason, undefined,
    'and is completed work, not a failure to produce evidence');
});

test('a REDEEMED but malformed promised receipt stays unknown with its reason', async () => {
  const built = await persistCanonicalLocalResult({
    label: 'malformed',
    toolName: 'workflow_create',
    args: { name: 'private-fixture-workflow' },
    // Redemption succeeds; the returned marker is missing its required fields.
    rawPayload: '[clementine:host-local-write-commit:v1] {"version":1}\nok',
  });
  const evidence = runner.settledSourceArtifacts({
    sessionId: built.identity.sessionId, sourceUserSeq: built.identity.sourceUserSeq,
  });
  assert.equal(evidence.count, 1, 'the write is retained');
  const entry = evidence.artifacts[0]!;
  assert.equal(entry.evidenceContract, 'unknown',
    'an operation that OWES a receipt and returned an unusable one is unresolved');
  assert.equal(entry.unresolvedReason, 'promised_receipt_missing_or_malformed');
});

for (const shape of ['native-marker', 'reviewed-object', 'reviewed-json'] as const) {
  test(`${shape} dataset producer survives canonical redemption and SQLite reopen as current file evidence`, async () => {
    const slug = `collector-${shape}`;
    spaces.spaceStore.save({ id: slug, title: 'Collector fixture', viewContent: '<html>Owned data</html>' });
    const args = { slug, source_id: 'accounts', data_json: '[{"id":"one","state":"Ready"}]' };
    const built = await persistCanonicalLocalResult({
      label: shape, toolName: 'space_set_data', args,
      produce: async () => {
        if (shape === 'native-marker') return (await dataset.executeManualWorkspaceSetData(args)).hostFileCommit;
        const result = await dataset.executeReviewedWorkspaceSetData(args);
        return shape === 'reviewed-json' ? JSON.stringify(result) : result;
      },
    });
    workspaceDb.closeWorkspaceDb();
    eventlog.closeEventLog();
    const collected = runner.settledSourceArtifacts(built.identity);
    assert.equal(collected.count, 1);
    assert.equal(collected.evidenceAvailable, true);
    const artifact = collected.artifacts[0]!;
    assert.equal(artifact.evidenceContract, 'file');
    assert.equal(artifact.handle, `spaces/${slug}/data.json`, 'whole physical document, not a source fragment');
    assert.equal(artifact.digestMatches, true);
    assert.equal(artifact.unresolvedReason, undefined);
    assert.equal(runner.settledSourceArtifacts({ ...built.identity, sourceUserSeq: built.identity.sourceUserSeq + 1 }).count, 0);
    writeFileSync(spaces.resolveInSpace(slug, 'data.json'), '{"changed_after_judging":true}');
    const drift = runner.settledSourceArtifacts(built.identity);
    assert.equal(drift.count, 1, 'current drift does not erase the write');
    assert.equal(drift.artifacts[0]!.evidenceContract, 'file');
    assert.equal(drift.artifacts[0]!.digestMatches, false);
  });
}

for (const [label, payload] of [
  ['missing-dataset-receipt', { artifactId: 'workspace-dataset:historical', handle: 'spaces/collector/data.json#source=accounts' }],
  ['malformed-dataset-receipt', { hostFileCommit: 'saved, but not a receipt' }],
] as const) {
  test(`${label} retains authenticated work as unknown coverage`, async () => {
    const built = await persistCanonicalLocalResult({ label, toolName: 'space_set_data', args: { slug: 'collector', source_id: 'accounts', data_json: '{}' }, rawPayload: payload });
    const collected = runner.settledSourceArtifacts(built.identity);
    assert.equal(collected.count, 1);
    assert.equal(collected.artifacts[0]!.evidenceContract, 'unknown');
    assert.equal(collected.artifacts[0]!.unresolvedReason, 'promised_receipt_missing_or_malformed');
  });
}

test('a redeemed worker coordination receipt does not invent a missing file', async () => {
  const built = await persistCanonicalLocalResult({
    label: 'worker-acknowledgement', toolName: 'run_worker', args: { item: 'research' },
    rawPayload: 'Batch complete: 1/1 items succeeded. Source facts returned.',
  });
  eventlog.closeEventLog();
  const evidence = runner.settledSourceArtifacts(built.identity);
  assert.equal(evidence.count, 1, 'coordination remains visible in the settled-effects ledger');
  assert.equal(evidence.artifacts[0]!.evidenceContract, 'none');
  assert.equal(evidence.artifacts[0]!.unresolvedReason, undefined);
  assert.equal(evidence.artifacts[0]!.handle, '');
  assert.doesNotMatch(evidence.summary, /missing|undeclared/i);
});

test('a valid dataset receipt in another operation carrier cannot change that operation evidence contract', async () => {
  const slug = 'collector-wrong-carrier';
  spaces.spaceStore.save({ id: slug, title: 'Wrong carrier fixture', viewContent: '<html>Owned data</html>' });
  const result = await dataset.executeManualWorkspaceSetData({ slug, source_id: 'accounts', data_json: '{}' });
  assert.ok(result.hostFileCommit);
  const create = await persistCanonicalLocalResult({ label: 'wrong-carrier-create', toolName: 'workflow_create', args: { name: 'fixture' }, rawPayload: { hostFileCommit: result.hostFileCommit } });
  assert.equal(runner.settledSourceArtifacts(create.identity).artifacts[0]!.evidenceContract, 'unknown');
  const acknowledgement = await persistCanonicalLocalResult({ label: 'wrong-carrier-ack', toolName: 'workflow_delete', args: { name: 'fixture' }, rawPayload: { hostFileCommit: result.hostFileCommit } });
  const artifact = runner.settledSourceArtifacts(acknowledgement.identity).artifacts[0]!;
  assert.equal(artifact.evidenceContract, 'none');
  assert.equal(artifact.handle, '');
});
