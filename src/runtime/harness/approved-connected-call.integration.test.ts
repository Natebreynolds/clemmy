/** Production-path approval proof. Only current discovery observations and
 * the final no-network SDK transport are supplied by the fixture. The real
 * card ingress, claim, default registered tool, gateway, logical refinement,
 * prepared client, physical reservation/I/O claim and terminal all run. */
import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-approved-connected-production-'));
process.env.CLEMENTINE_HOME = home;
process.env.COMPOSIO_BACKEND = 'sdk';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.HARNESS_TOOL_BRACKETS = 'on';
mkdirSync(path.join(home, 'state'), { recursive: true });
writeFileSync(path.join(home, 'state', 'machine-id'), 'machine-approved-connected-production\n');

const events = await import('./eventlog.js');
const actions = await import('./pending-actions.js');
const approvals = await import('./approval-registry.js');
const transition = await import('./pending-action-transition.js');
const resume = await import('./chat-approval-resume.js');
const client = await import('../../integrations/composio/client.js');
const schemas = await import('../../tools/composio-schema-cache.js');
const { recordAcceptedSourceGraph } = await import('./record-accepted-source-graph.js');
const { activateActionExpectedWork, expectedWorkPlanLines } = await import('./expected-work-admission.js');
const { freezeActionExpectedWorkContract } = await import('./expected-work-contract.js');
const { loadAcceptedTaskAuthority } = await import('./accepted-task-authority.js');
const { commitTurnOutcome } = await import('./delivery-committer.js');
const { turnOutcomeId } = await import('./turn-outcome.js');
const { HarnessSession } = await import('./session.js');
const { readPendingActionPublicResult } = await import('./pending-action-result-reader.js');
const completion = await import('./approved-action-completion-proof.js');
const { prepareApprovedActionHostCompletion } = await import('./approved-action-completion-receipt.js');
const { actionBus } = await import('../action-bus.js');
const { redeemSuccessfulSettlementResultForHost } = await import('./result-handle.js');
const { digestSchema } = await import('../../tools/tool-contract-store.js');

const OPERATION = 'SLACK_SEND_MESSAGE';
const ACCOUNT = 'ca-approved-connected-production';
const OWNER = 'owner-approved-connected-production';
const VERSION = '20261019_01';
const ARGUMENTS = { channel: 'C-CONTROLLED-APPROVAL', text: 'Controlled exact approved update.' };
const INPUT_SCHEMA = { type: 'object', additionalProperties: false, required: ['channel', 'text'],
  properties: { channel: { type: 'string' }, text: { type: 'string' } } };
const OUTPUT_SCHEMA = { type: 'object', properties: { channel: { type: 'string' }, ts: { type: 'string' } } };
const originalFetch = globalThis.fetch;
let forbiddenNetwork = 0;
const subscriptions: Array<() => void> = [];

beforeEach(() => {
  resume._resetChatApprovalResumeForTest();
  forbiddenNetwork = 0;
  globalThis.fetch = (async () => { forbiddenNetwork += 1; throw new Error('No network is permitted in this production-path fixture.'); }) as typeof fetch;
});
afterEach(() => {
  for (const stop of subscriptions.splice(0)) stop();
  resume._resetChatApprovalResumeForTest();
  client.__test__.setConnectedAccountsLoader(null);
  client.__test__.setComposioApiKeyOverride(null);
  client.resetComposioClient();
  schemas.resetToolSchemaCache();
  globalThis.fetch = originalFetch;
  process.env.COMPOSIO_BACKEND = 'sdk';
});
after(() => { events.closeEventLog(); rmSync(home, { recursive: true, force: true }); });

async function preparedProvider(options: { loseResponse?: boolean } = {}) {
  let accountReads = 0;
  let rawBodies = 0;
  let legacyBodies = 0;
  const noRetry: unknown[] = [];
  const sent: Array<{ slug: string; body: Record<string, unknown>; signal?: AbortSignal }> = [];
  client.__test__.setComposioApiKeyOverride('controlled-not-a-real-provider-key');
  client.__test__.setConnectedAccountsLoader(async () => {
    accountReads += 1;
    return [{ id: ACCOUNT, status: 'ACTIVE', user_id: OWNER, toolkit: { slug: 'slack' },
      data: { email: 'controlled-owner@example.test' } }];
  });
  // Existing discovery observations, prepared before the accepted action B.
  const connected = await client.listConnectedToolkits({ requireFresh: true });
  assert.equal(connected.find(row => row.connectionId === ACCOUNT)?.accountEmail, 'controlled-owner@example.test');
  schemas.rememberToolSchema(OPERATION, INPUT_SCHEMA, Date.now(), VERSION, OUTPUT_SCHEMA);
  assert.equal(schemas.liveComposioOperationVersion(OPERATION), VERSION);
  assert.ok(schemas.liveComposioSchemaFingerprint(OPERATION));
  client.__test__.setComposioClient({
    getClient: () => ({ withOptions: (retry: unknown) => {
      noRetry.push(retry);
      return { tools: { execute: async (slug: string, body: Record<string, unknown>, request?: { signal?: AbortSignal }) => {
        rawBodies += 1; sent.push({ slug, body: structuredClone(body), signal: request?.signal });
        if (options.loseResponse) throw new DOMException('Controlled response lost after SDK body crossed.', 'TimeoutError');
        return { successful: true, error: null, data: { channel: ARGUMENTS.channel, ts: '1000000000.000001' }, log_id: 'controlled-sdk-result' };
      } }, files: { createPresignedURL: async () => assert.fail('The approved one-body fixture cannot upload a file.') } };
    } }),
    tools: { execute: async () => { legacyBodies += 1; assert.fail('The SDK wrapper/retry transport must not run.'); } },
  });
  return { accountReads: () => accountReads, rawBodies: () => rawBodies, legacyBodies: () => legacyBodies, noRetry, sent };
}

function originalSnapshot(sessionId: string, sourceUserSeq: number) {
  const db = events.openEventLog();
  const metadata = HarnessSession.load(sessionId)!.sessionRow.metadata;
  return structuredClone({
    authority: db.prepare('SELECT * FROM accepted_task_authority WHERE session_id=? AND source_user_seq=?').get(sessionId, sourceUserSeq),
    contract: db.prepare('SELECT * FROM accepted_task_work_contracts WHERE session_id=? AND source_user_seq=?').get(sessionId, sourceUserSeq),
    workBindings: db.prepare('SELECT * FROM expected_work_call_bindings WHERE session_id=? AND source_user_seq=? ORDER BY logical_tool_call_id').all(sessionId, sourceUserSeq),
    settlements: db.prepare('SELECT * FROM logical_call_settlements WHERE session_id=? AND source_user_seq=? ORDER BY logical_tool_call_id').all(sessionId, sourceUserSeq),
    source: events.getUserInputEventAtSequence(sessionId, sourceUserSeq),
    terminals: events.listEvents(sessionId, { types: ['conversation_completed'] }).filter(row => row.data.sourceUserSeq === sourceUserSeq),
    parks: events.listEvents(sessionId, { types: ['approval_parked'] }).filter(row => row.data.sourceUserSeq === sourceUserSeq),
    markers: Object.fromEntries(['__run_in_flight', '__run_in_flight_owner', '__host_recovery_state', '__host_recovery_owner',
      '__continuation_owner', '__source_approval_checkpoints'].map(key => [key, metadata[key]])),
  });
}

async function queuedOriginal(options: { explicitAccount?: boolean; innerRouting?: Record<string, unknown> } = {}) {
  const session = events.createSession({ kind: 'chat', channel: 'desktop' });
  const attempt = events.beginRunAttempt(session.id, { runId: `controlled-original:${session.id}` });
  const source = events.recordRunAttemptUserInput(attempt, { turn: 1, role: 'user', data: {
    text: 'Post the approved Slack update, then update the tracking record. Keep both results for verification.',
  } }, { armRunInFlight: true });
  const identity = { sessionId: session.id, sourceUserSeq: source.seq, turn: source.turn };
  assert.ok(await recordAcceptedSourceGraph({ identity, surface: 'dashboard', acceptedText: String(source.data.text) }));
  const activated = activateActionExpectedWork(identity);
  assert.ok(activated.status === 'activated' || activated.status === 'replayed', JSON.stringify(activated));
  const frozen = freezeActionExpectedWorkContract({ ...identity, proposal: {
    version: 1, operations: [
      { id: 'post_update', effect: 'external_write', dependsOn: [], dataFrom: [], cardinality: { kind: 'once' } },
      { id: 'update_tracking', effect: 'external_write', dependsOn: ['post_update'], dataFrom: [], cardinality: { kind: 'once' } },
    ], universes: [],
  } });
  assert.ok(frozen.status === 'fixed' || frozen.status === 'replayed', JSON.stringify(frozen));
  const explicitAccount = options.explicitAccount !== false;
  const payload = { tool_slug: OPERATION,
    arguments: JSON.stringify({ ...ARGUMENTS, ...(explicitAccount ? { connected_account_id: ACCOUNT } : {}), ...options.innerRouting }),
    connected_account_id: explicitAccount ? ACCOUNT : null };
  const action = actions.getOrCreatePendingActionByPayloadAndSource({
    title: 'Post the controlled reviewed update', summary: 'One exact Slack message; the tracking-record task remains separate.',
    kind: 'external_send', toolName: 'composio_execute_tool', payload, sessionId: session.id, sourceUserSeq: source.seq,
    createdBy: 'controlled-production-approval',
  }).record;
  // The same typed queue edge used by pending_action_queue; materialization,
  // immutable snapshot, resume key and public park are production functions.
  events.appendEvent({ sessionId: session.id, turn: source.turn, role: 'Clem', type: 'autonomy_note', data: {
    kind: 'pending_action_queued', pendingActionId: action.id, actionKind: action.kind,
    approvalRequired: true, approvalIntent: 'request_now', autoMaterialize: true,
    payloadHash: action.payloadHash, sourceUserSeq: source.seq,
  } });
  const transitions = transition.queuedApprovalTransitionsForRequest(session.id, source.seq);
  assert.equal(transitions.length, 1);
  const materialized = transition.materializeQueuedApprovals(session.id, source.turn, source.seq, transitions);
  assert.equal(materialized.length, 1, 'the actual graph transition creates one linked human card');
  const card = materialized[0]!.approval;
  assert.equal(card.tool, 'request_approval');
  assert.ok(!card.presentation, 'desktop card uses the exact synthetic approval-resume decision');
  assert.equal(frozen.contract.operations.length, 2);
  assert.deepEqual(expectedWorkPlanLines(identity).map(row => row.settledInstances), [0, 0],
    'the active original objective retains both unsettled write operations before its canonical approval pause');
  const pause = commitTurnOutcome({ version: 2, id: turnOutcomeId(identity), identity, status: 'needs_input', resumable: true,
    needs: { kind: 'approval' }, presentation: { kind: 'approval', text: 'The exact update is ready for your approval.', approvalId: card.approvalId } });
  assert.equal(pause.presentation.status, 'needs_input');
  events.finishRunAttempt(attempt);
  HarnessSession.load(session.id)?.clearRunInFlight();
  const before = originalSnapshot(session.id, source.seq);
  assert.ok(before.authority && before.contract, 'the canonical pause retains actual original authority and immutable work-contract rows');
  assert.equal((before.contract as { operation_count: number }).operation_count, 2);
  assert.deepEqual(before.workBindings, []);
  assert.deepEqual(before.settlements, [], 'neither original write is settled by the approval pause');
  return { session, source, identity, action, card, payload, before,
    cardArgs: structuredClone(card.args) };
}

type Original = Awaited<ReturnType<typeof queuedOriginal>>;
function decisionFor(f: Original) {
  return events.listEvents(f.session.id, { types: ['user_input_received'] })
    .find(row => row.data.approvalId === f.card.approvalId && row.data.source === 'approval_resume');
}
function assertOriginalUntouched(f: Original) {
  assert.deepEqual(originalSnapshot(f.session.id, f.source.seq), f.before,
    'B must leave original source, two-operation contract, authority, pause and markers byte-identical');
  assert.deepEqual(approvals.get(f.card.approvalId)?.args, f.cardArgs, 'the human-approved payload snapshot never changes');
  assert.equal((f.before.contract as { operation_count: number }).operation_count, 2);
  assert.deepEqual(f.before.workBindings, []);
  assert.deepEqual(f.before.settlements, []);
  assert.ok(f.before.terminals.length === 1 && f.before.parks.length === 1, 'A has its real typed card pause');
  assert.equal((f.before.terminals[0]!.data.turnOutcome as { status: string }).status, 'needs_input');
}
function resolveCard(f: Original) {
  const resolved = approvals.resolve(f.card.approvalId, 'approved', 'desktop-chat-card');
  assert.equal(resolved.ok, true); assert.ok(resolved.row); return resolved.row;
}
const noModel = async () => assert.fail('An exact pending-action approval must not hand work back to a model.');
async function approve(f: Original) {
  const row = resolveCard(f);
  await resume.handleResolvedApprovalForChatResume(row, noModel);
  return row;
}
function businessRows(sessionId: string, sourceUserSeq?: number) {
  return sourceUserSeq === undefined
    ? events.openEventLog().prepare('SELECT * FROM physical_dispatches WHERE session_id=?').all(sessionId) as Array<Record<string, unknown>>
    : events.openEventLog().prepare('SELECT * FROM physical_dispatches WHERE session_id=? AND source_user_seq=?').all(sessionId, sourceUserSeq) as Array<Record<string, unknown>>;
}

function controlledFailureDiagnostic(f: Original, sourceUserSeq: number, provider: Awaited<ReturnType<typeof preparedProvider>>) {
  const db = events.openEventLog();
  // This disposable session contains fixture text only. Keep the diagnostic
  // bounded to dispatch identity/state and returned guard/error evidence.
  return {
    rawBodies: provider.rawBodies(), forbiddenNetwork,
    logical: db.prepare(`SELECT tool_name,state,raw_argument_digest,argument_digest,refinement_event_id,outcome_kind
      FROM logical_tool_calls WHERE session_id=? AND source_user_seq=?`).all(f.session.id, sourceUserSeq),
    physical: businessRows(f.session.id, sourceUserSeq),
    intent: db.prepare('SELECT intent_json FROM approved_action_completion_intents_v1 WHERE session_id=? AND source_user_seq=?').all(f.session.id, sourceUserSeq),
    authority: db.prepare('SELECT * FROM accepted_task_authority WHERE session_id=? AND source_user_seq=?').get(f.session.id, sourceUserSeq),
    resolution: db.prepare('SELECT * FROM accepted_task_resolutions WHERE session_id=? AND source_user_seq=?').get(f.session.id, sourceUserSeq),
    returned: events.listEvents(f.session.id, { types: ['tool_returned'] }).slice(-3).map(row => ({
      sourceUserSeq: row.data.sourceUserSeq, tool: row.data.tool,
      error: row.data.error, result: String(JSON.stringify(row.data.result)).slice(0, 3500),
    })),
    guards: events.listEvents(f.session.id, { types: ['autonomy_note'] }).filter(row => row.data.guard || row.data.reason).slice(-5)
      .map(row => ({ kind: row.data.kind, guard: row.data.guard, reason: row.data.reason })),
  };
}

test('actual desktop approval runs the default registered SDK write once and canonically closes only exact B', async () => {
  const provider = await preparedProvider();
  const f = await queuedOriginal();
  const row = resolveCard(f);
  await Promise.all([resume.handleResolvedApprovalForChatResume(row, noModel), resume.handleResolvedApprovalForChatResume(row, noModel)]);
  const decision = decisionFor(f); assert.ok(decision);
  const saved = actions.getPendingAction(f.action.id)!;
  if (saved.status !== 'executed') console.error('Controlled production-path failure:', JSON.stringify(controlledFailureDiagnostic(f, decision.seq, provider)));
  assert.equal(saved.status, 'executed', saved.resultSummary ?? '');
  assert.equal(provider.rawBodies(), 1);
  assert.equal(provider.legacyBodies(), 0);
  assert.equal(provider.accountReads(), 1, 'the business path consumes only the already-current account observation');
  assert.equal(forbiddenNetwork, 0, 'warm schema/account preparation performs no hidden metadata or HTTP requests');
  assert.ok(provider.noRetry.length >= 1);
  for (const options of provider.noRetry) assert.deepEqual(options, { maxRetries: 0 });
  assert.deepEqual(provider.sent.map(({ slug, body }) => ({ slug, body })), [{ slug: OPERATION,
    body: { arguments: ARGUMENTS, user_id: OWNER, version: VERSION, connected_account_id: ACCOUNT } }]);
  assert.ok(provider.sent[0]!.signal, 'the actual prepared transport keeps the owned abort/deadline signal');
  const physical = businessRows(f.session.id, decision.seq);
  assert.equal(physical.length, 1); assert.equal(physical[0]!.state, 'returned');
  assert.ok(physical[0]!.io_claimed_at, 'the typed final I/O CAS was claimed');
  assert.match(String(physical[0]!.io_owner), /^approved-composio-sdk:/);
  const proven = completion.proveApprovedActionCompletionInTransaction(events.openEventLog(), { sessionId: f.session.id, sourceUserSeq: decision.seq });
  assert.equal(proven.intent.originalSourceUserSeq, f.source.seq);
  assert.equal(proven.intent.effect, 'external_write');
  assert.equal(proven.intent.providerDispatchProtocol, 'approved_composio_sdk_v1');
  assert.ok(proven.receipt.refinementEventId, 'the real resolver removed the inline account selector via durable one-way refinement');
  assert.notEqual(proven.receipt.admittedArgumentDigest, proven.receipt.executedArgumentDigest);
  const bindings = events.openEventLog().prepare('SELECT binding_json FROM approved_action_provider_bindings_v1 WHERE intent_id=?').all(proven.intentId) as Array<{ binding_json: string }>;
  assert.equal(bindings.length, 1);
  const binding = JSON.parse(bindings[0]!.binding_json) as Record<string, unknown>;
  assert.equal(binding.invokePortId, 'composio_sdk_v3_execute'); assert.equal(binding.providerOperationId, OPERATION);
  assert.equal(binding.providerOperationVersion, VERSION); assert.equal(binding.connectedAccountId, ACCOUNT);
  assert.equal(binding.providerInputSchemaDigest, digestSchema(INPUT_SCHEMA));
  assert.equal(binding.schemaFingerprint, schemas.liveComposioSchemaFingerprint(OPERATION));
  assert.equal(binding.rawArgumentDigest, proven.receipt.admittedArgumentDigest);
  assert.equal(binding.effectiveArgumentDigest, proven.receipt.executedArgumentDigest);
  assert.equal(binding.effect, 'external_write'); assert.equal(binding.physicalDispatchId, physical[0]!.physical_dispatch_id);
  const closed = loadAcceptedTaskAuthority(f.session.id, decision.seq);
  assert.equal(closed.status, 'ok'); if (closed.status !== 'ok') return;
  assert.equal(closed.authority.state, 'terminal'); assert.ok(closed.authority.hostCompletionReceiptId);
  const terminal = events.readValidatedTerminalEvent(closed.authority.terminalEventId!, f.session.id, decision.seq);
  assert.equal((terminal.data.turnOutcome as { status: string }).status, 'done');
  assert.equal(readPendingActionPublicResult(saved)?.source, 'terminal');
  assert.equal(prepareApprovedActionHostCompletion({ sessionId: f.session.id, sourceUserSeq: decision.seq }).status, 'redeemed');
  assertOriginalUntouched(f);
  resume._resetChatApprovalResumeForTest();
  await resume.handleResolvedApprovalForChatResume(approvals.get(row.approvalId)!, noModel);
  assert.equal(provider.rawBodies(), 1, 'durable card replay cannot prepare a second provider request');
  assert.equal(businessRows(f.session.id).length, 1); assertOriginalUntouched(f);
});

test('a disconnected exact approved account cannot be replaced by the remaining connected account', async () => {
  const provider = await preparedProvider(); const f = await queuedOriginal();
  client._setConnectedToolkitsSnapshotForTests([{ slug: 'slack', accountLabel: 'Controlled other account', status: 'ACTIVE',
    connectionId: 'ca-other-not-approved', ownerUserId: 'other-controlled-owner' }]);
  await approve(f);
  assert.equal(provider.rawBodies(), 0); assert.equal(forbiddenNetwork, 0);
  assert.notEqual(actions.getPendingAction(f.action.id)?.status, 'executed');
  assert.equal(businessRows(f.session.id).length, 0);
  assert.equal(events.openEventLog().prepare('SELECT count(*) AS n FROM approved_action_completion_receipts_v1 WHERE session_id=?').get(f.session.id)?.n, 0);
  assertOriginalUntouched(f);
});

test('Stop on original A before approval prevents business I/O without a replacement model turn', async () => {
  const provider = await preparedProvider(); const f = await queuedOriginal();
  events.requestKill(f.session.id, 'Controlled Stop before approval.', { sourceUserSeq: f.source.seq });
  await approve(f);
  assert.equal(provider.rawBodies(), 0); assert.equal(forbiddenNetwork, 0);
  assert.equal(actions.getPendingAction(f.action.id)?.status, 'cancelled');
  assert.equal(businessRows(f.session.id).length, 0);
  assert.equal(decisionFor(f), undefined, 'an already-stopped original source never accepts a fresh effect source B');
});

test('Stop after actual resolver refinement prevents final reservation/provider I/O and never replays', async () => {
  const provider = await preparedProvider(); const f = await queuedOriginal(); let stopped = false;
  subscriptions.push(actionBus.subscribe(event => {
    if (stopped || event.kind !== 'harness.event' || event.sessionId !== f.session.id || event.event.type !== 'logical_call_contract_refined') return;
    const source = decisionFor(f); assert.ok(source);
    stopped = true; events.requestKill(f.session.id, 'Controlled Stop after exact resolver refinement.', { sourceUserSeq: source.seq });
  }));
  const row = await approve(f);
  assert.equal(stopped, true, 'the production resolver actually reached durable refinement before Stop');
  assert.equal(provider.rawBodies(), 0); assert.equal(forbiddenNetwork, 0);
  const decision = decisionFor(f); assert.ok(decision);
  assert.equal(businessRows(f.session.id, decision.seq).length, 0);
  assert.notEqual(actions.getPendingAction(f.action.id)?.status, 'executed');
  await resume.handleResolvedApprovalForChatResume(row, noModel);
  assert.equal(provider.rawBodies(), 0); assertOriginalUntouched(f);
});

test('SDK default-account routing is outside the exact approved connected-write bridge', async () => {
  const provider = await preparedProvider(); const f = await queuedOriginal({ explicitAccount: false });
  await approve(f);
  assert.equal(provider.rawBodies(), 0, 'a default account can never satisfy the explicit approved account binding');
  assert.equal(forbiddenNetwork, 0); assert.equal(businessRows(f.session.id).length, 0);
  assert.notEqual(actions.getPendingAction(f.action.id)?.status, 'executed');
  assertOriginalUntouched(f);
});

for (const key of ['connected_account_id', 'connectedAccountId', 'connection_id', 'connectionId', 'account_alias']) {
  test(`exact approved preparation refuses conflicting inner ${key} instead of substituting account routing`, async () => {
    const provider = await preparedProvider(); const f = await queuedOriginal({ innerRouting: { [key]: 'ca-other-not-approved' } });
    const row = await approve(f);
    assert.equal(provider.rawBodies(), 0); assert.equal(forbiddenNetwork, 0);
    assert.equal(businessRows(f.session.id).length, 0);
    assert.notEqual(actions.getPendingAction(f.action.id)?.status, 'executed');
    assert.equal(events.openEventLog().prepare('SELECT count(*) AS n FROM approved_action_provider_bindings_v1 WHERE session_id=?').get(f.session.id)?.n, 0);
    resume._resetChatApprovalResumeForTest();
    await resume.handleResolvedApprovalForChatResume(approvals.get(row.approvalId)!, noModel);
    assert.equal(provider.rawBodies(), 0); assertOriginalUntouched(f);
  });
}

test('Stop after the canonical successful settlement retains its known result under cancelled B without replay', async () => {
  const provider = await preparedProvider(); const f = await queuedOriginal(); let stopped = false;
  subscriptions.push(actionBus.subscribe(event => {
    if (stopped || event.kind !== 'harness.event' || event.sessionId !== f.session.id
      || event.event.type !== 'tool_attempt_settled' || event.event.data.kind !== 'succeeded') return;
    const decision = decisionFor(f); assert.ok(decision);
    if (event.event.data.sourceUserSeq !== decision.seq) return;
    // This is the production durable result boundary, after the real
    // no-network SDK body returned and its raw bytes were retained. It is not
    // a callback inside the provider stand-in before its promise returns.
    stopped = true; events.requestKill(f.session.id, 'Controlled late Stop after the known SDK result settled.', { sourceUserSeq: decision.seq });
  }));
  const row = await approve(f);
  const decision = decisionFor(f); assert.ok(decision);
  assert.equal(stopped, true, 'Stop is issued only after an actual canonical successful result settlement');
  assert.equal(provider.rawBodies(), 1); assert.equal(forbiddenNetwork, 0);
  const terminals = events.listEvents(f.session.id, { types: ['conversation_completed'] }).filter(event => event.data.sourceUserSeq === decision.seq);
  assert.equal(terminals.length, 1); assert.equal((terminals[0]!.data.turnOutcome as { status: string }).status, 'cancelled');
  const physical = businessRows(f.session.id, decision.seq);
  assert.equal(physical.length, 1); assert.equal(physical[0]!.state, 'returned');
  const settlement = events.openEventLog().prepare(`SELECT logical_tool_call_id,outcome_kind,result_handle_id,requires_reconciliation
    FROM logical_call_settlements WHERE session_id=? AND source_user_seq=?`).get(f.session.id, decision.seq) as {
      logical_tool_call_id: string; outcome_kind: string; result_handle_id: string | null; requires_reconciliation: number;
    };
  assert.ok(settlement); assert.equal(settlement.outcome_kind, 'succeeded');
  assert.equal(settlement.requires_reconciliation, 0); assert.ok(settlement.result_handle_id, 'Stop does not erase an already-known returned result');
  const retained = redeemSuccessfulSettlementResultForHost({ sessionId: f.session.id, sourceUserSeq: decision.seq,
    acceptedTaskId: `task:${f.session.id}#${decision.seq}`, logicalToolCallId: settlement.logical_tool_call_id });
  assert.equal(retained.status, 'ok');
  if (retained.status === 'ok') assert.match(JSON.stringify(retained.value.rawPayload), /1000000000\.000001/);
  assert.equal(events.openEventLog().prepare('SELECT count(*) AS n FROM approved_action_provider_bindings_v1 WHERE session_id=?').get(f.session.id)?.n, 1);
  assert.notEqual(prepareApprovedActionHostCompletion({ sessionId: f.session.id, sourceUserSeq: decision.seq }).status, 'redeemed');
  resume._resetChatApprovalResumeForTest(); await resume.handleResolvedApprovalForChatResume(approvals.get(row.approvalId)!, noModel);
  assert.equal(provider.rawBodies(), 1); assertOriginalUntouched(f);
});

const preparedObservationChanges: Array<{ name: string; change: () => void }> = [
  { name: 'same connection assigned to another provider owner', change: () => {
    client._setConnectedToolkitsSnapshotForTests([{ slug: 'slack', accountLabel: 'Controlled replacement owner', status: 'ACTIVE',
      connectionId: ACCOUNT, accountEmail: 'controlled-owner@example.test', ownerUserId: 'replacement-controlled-owner' }]);
  } },
  { name: 'provider input schema changed', change: () => {
    schemas.rememberToolSchema(OPERATION, { ...INPUT_SCHEMA, properties: { ...INPUT_SCHEMA.properties,
      text: { type: 'string', enum: ['a different controlled value'] } } }, Date.now(), VERSION, OUTPUT_SCHEMA);
  } },
  { name: 'provider operation version changed', change: () => {
    schemas.rememberToolSchema(OPERATION, INPUT_SCHEMA, Date.now(), '20261019_02', OUTPUT_SCHEMA);
  } },
  { name: 'execution backend changed', change: () => { process.env.COMPOSIO_BACKEND = 'cli'; } },
  { name: 'provider credential changed', change: () => { client.__test__.setComposioApiKeyOverride('a-different-controlled-provider-key'); } },
];

for (const scenario of preparedObservationChanges) {
  test(`after physical reservation, ${scenario.name} refuses the actual SDK body and card replay`, async () => {
    const provider = await preparedProvider(); const f = await queuedOriginal(); let changed = false;
    subscriptions.push(actionBus.subscribe(event => {
      if (changed || event.kind !== 'harness.event' || event.sessionId !== f.session.id
        || event.event.type !== 'approved_action_provider_bound') return;
      const decision = decisionFor(f); assert.ok(decision);
      if (event.event.data.sourceUserSeq !== decision.seq) return;
      const physical = businessRows(f.session.id, decision.seq);
      assert.equal(physical.length, 1, 'the real gateway has durably reserved its exact provider crossing');
      assert.equal(physical[0]!.io_claimed_at, null, 'the final typed I/O claim has not run yet');
      changed = true; scenario.change();
    }));
    const row = await approve(f);
    const decision = decisionFor(f); assert.ok(decision);
    assert.equal(changed, true, 'the observation changes only at the actual committed reservation event');
    assert.equal(provider.rawBodies(), 0); assert.equal(provider.legacyBodies(), 0); assert.equal(forbiddenNetwork, 0);
    const physical = businessRows(f.session.id, decision.seq);
    assert.equal(physical.length, 1, 'a refused final claim retains the actual reservation rather than erasing it');
    assert.equal(physical[0]!.io_claimed_at, null); assert.equal(physical[0]!.io_owner, null);
    assert.notEqual(actions.getPendingAction(f.action.id)?.status, 'executed');
    assert.notEqual(prepareApprovedActionHostCompletion({ sessionId: f.session.id, sourceUserSeq: decision.seq }).status, 'redeemed');
    const terminals = events.listEvents(f.session.id, { types: ['conversation_completed'] }).filter(event => event.data.sourceUserSeq === decision.seq);
    assert.ok(terminals.every(event => (event.data.turnOutcome as { status: string }).status !== 'done'));
    resume._resetChatApprovalResumeForTest();
    await resume.handleResolvedApprovalForChatResume(approvals.get(row.approvalId)!, noModel);
    assert.equal(provider.rawBodies(), 0); assert.equal(businessRows(f.session.id, decision.seq).length, 1);
    assertOriginalUntouched(f);
  });
}

test('a lost response after the actual SDK body retains claimed uncertain write evidence and never replays', async () => {
  const provider = await preparedProvider({ loseResponse: true }); const f = await queuedOriginal();
  const row = await approve(f); const decision = decisionFor(f); assert.ok(decision);
  assert.equal(provider.rawBodies(), 1); assert.equal(provider.legacyBodies(), 0); assert.equal(forbiddenNetwork, 0);
  const physical = businessRows(f.session.id, decision.seq);
  assert.equal(physical.length, 1); assert.equal(physical[0]!.state, 'threw'); assert.ok(physical[0]!.io_claimed_at);
  const settlement = events.openEventLog().prepare(`SELECT outcome_kind,retry_same_candidate,requires_reconciliation,result_handle_id
    FROM logical_call_settlements WHERE session_id=? AND source_user_seq=?`).get(f.session.id, decision.seq) as {
      outcome_kind: string; retry_same_candidate: number; requires_reconciliation: number; result_handle_id: string | null;
    };
  assert.ok(settlement); assert.equal(settlement.outcome_kind, 'uncertain_write');
  assert.equal(settlement.retry_same_candidate, 0); assert.equal(settlement.requires_reconciliation, 1);
  assert.notEqual(actions.getPendingAction(f.action.id)?.status, 'executed');
  assert.notEqual(prepareApprovedActionHostCompletion({ sessionId: f.session.id, sourceUserSeq: decision.seq }).status, 'redeemed');
  const terminals = events.listEvents(f.session.id, { types: ['conversation_completed'] }).filter(event => event.data.sourceUserSeq === decision.seq);
  assert.ok(terminals.every(event => (event.data.turnOutcome as { status: string }).status !== 'done'));
  resume._resetChatApprovalResumeForTest();
  await resume.handleResolvedApprovalForChatResume(approvals.get(row.approvalId)!, noModel);
  assert.equal(provider.rawBodies(), 1, 'unknown effect ownership cannot become a new provider occurrence');
  assert.equal(businessRows(f.session.id, decision.seq).length, 1); assertOriginalUntouched(f);
});
