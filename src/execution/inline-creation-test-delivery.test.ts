import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-inline-creation-delivery-'));
process.env.CLEMENTINE_HOME = home;
const events = await import('../runtime/harness/eventlog.js');
const leases = await import('../runtime/harness/dispatch-lease.js');
const { armHostCallAuthority } = await import('../runtime/harness/accepted-turn-call-authority.js');
const { durableLogicalCallRecoveryMaterial } = await import('../runtime/harness/logical-call-contract.js');
const { withToolOutputContext } = await import('../runtime/harness/tool-output-context.js');
const { formatRecallableToolText } = await import('../runtime/harness/tool-output-format.js');
const { withoutHostReceiptLines } = await import('../runtime/host-receipt-lines.js');
const inline = await import('./inline-creation-test-delivery.js');
const { attachEventLogHooks } = await import('../runtime/harness/hooks.js');
const { ToolCallsCounter, withHarnessRunContext } = await import('../runtime/harness/brackets.js');
const reportBack = await import('./workflow-run-report-back.js');
const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');
mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
test.after(() => {
  reportBack._setWorkflowRunReportBackDeliveryForTests();
  rmSync(home, { recursive: true, force: true });
});

function fixture(options: { nested?: boolean; outcome?: 'done' | 'blocked'; hostChild?: boolean } = {}) {
  const session = events.createSession({ kind: 'chat' });
  const attempt = events.beginRunAttempt(session.id);
  const source = events.recordRunAttemptUserInput(attempt, { role: 'user', turn: 1, data: { text: 'Create a controlled read workflow.' } });
  const authority = armHostCallAuthority({ sessionId: session.id, sourceUserSeq: source.seq,
    catalogRevisionDigest: 'a'.repeat(64), bindingRevisionDigest: 'b'.repeat(64), maxLogicalCalls: 10, maxParallelCalls: 2 });
  assert.equal(authority.status, 'armed');
  const callId = `call-${randomUUID()}`;
  const tool = options.nested ? 'work_call' : 'workflow_create';
  const acceptedTaskId = `task:${session.id}#${source.seq}`;
  const material = durableLogicalCallRecoveryMaterial(acceptedTaskId, tool, { name: 'fixture' })!;
  events.openEventLog().prepare(`INSERT INTO logical_tool_calls
    (session_id, source_user_seq, accepted_task_id, logical_tool_call_id, tool_name, argument_digest, raw_argument_digest, state, opened_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)`)
    .run(session.id, source.seq, acceptedTaskId, callId, material.toolName, material.argumentDigest, material.argumentDigest, new Date().toISOString());
  // The host lane: the runner's lease issues a child lease bound to this one
  // call; the call runs under the child and its top-level return is recorded
  // under the runner's lease.
  const runnerLease = options.hostChild
    ? leases.activateDispatchLease({ sessionId: session.id, scopeId: `${session.id}:host-runner`, runAttemptId: attempt.attemptId })
    : undefined;
  const lease = leases.activateDispatchLease({ sessionId: session.id, scopeId: `${session.id}:call`, runAttemptId: attempt.attemptId,
    sourceUserSeq: source.seq, acceptedTaskId, logicalToolCallId: callId, recovery: { material, effect: 'local_write', businessCall: false },
    ...(runnerLease ? { parentLease: runnerLease } : {}) });
  const returnLease = runnerLease ?? lease;
  const nonce = randomUUID();
  const runId = `run-${randomUUID()}`;
  const file = path.join(WORKFLOW_RUNS_DIR, `${runId}.json`);
  const context = { sessionId: session.id, sourceUserSeq: source.seq, callId: options.nested ? `${callId}:inner` : callId,
    toolName: options.nested ? 'workflow_create' : tool, settlementNonce: options.nested ? randomUUID() : nonce };
  const owned = <T>(work: () => T) => leases.runWithDispatchLease(lease, () => withToolOutputContext(context, work)) as T;
  const intent = owned(() => inline.createInlineCreationTestDeliveryIntent(runId, session.id));
  assert.ok(intent, 'an exact accepted authoring invocation owns the initial intent');
  const detail = options.outcome === 'blocked' ? 'The saved creation test needs a fixture connection. No write ran.' : 'The fixture read returned data; mutation steps were only previewed.';
  const run = { id: runId, workflow: 'fixture', status: 'creation_test', finishedAt: new Date().toISOString(), notifiedAt: new Date().toISOString(),
    originSessionId: session.id, inlineCreationTestDelivery: intent,
    rehearsal: { passed: options.outcome !== 'blocked', definitionKey: 'fixture-version' },
    reportBack: { version: 1 as const, workflowName: 'fixture', outcome: options.outcome ?? 'done', detail, acknowledgedOriginSessionIds: [] as string[] } };
  const save = () => writeFileSync(file, JSON.stringify(run));
  save();
  const receipt = owned(() => inline.inlineCreationTestReceiptForSettlement({ runId, body: detail }));
  assert.match(receipt, /^\[clementine:inline-creation-test:v1\] /);
  const output = `${receipt}Creation test report:\n${detail}`;
  const called = events.appendEvent({ sessionId: session.id, role: 'Clem', type: 'tool_called', turn: 1,
    data: { sourceUserSeq: source.seq, callId, tool, accounting: 'top_level' } });
  const park = (text = output, invocationNonce = nonce, parkedCallId = callId, parkedTool = tool) => events.writeToolOutput({ sessionId: session.id, callId: parkedCallId, tool: parkedTool, output: text, invocationNonce });
  const metadata = (result: unknown = output, invocationNonce: string | undefined = nonce, authoritativeReturn = true) => inline.inlineCreationTestReturnedMetadata({
    sessionId: session.id, sourceUserSeq: source.seq, callId, toolName: tool, result, invocationNonce, authoritativeReturn, dispatchLease: returnLease });
  const returned = (data = metadata()) => events.appendEvent({ sessionId: session.id, role: 'tool', type: 'tool_returned', turn: 1, parentEventId: called.id,
    data: { sourceUserSeq: source.seq, callId, canonicalCallId: callId, tool, accounting: 'top_level', ok: true, ...data } });
  return { session, attempt, source, callId, tool, lease, runnerLease, nonce, runId, file, owned, run, save, receipt, output, park, metadata, returned };
}

test('on the host lane the runner lease that issued this exact call seals its return, so Clem\'s inline result is not posted again', () => {
  const f = fixture({ hostChild: true });
  assert.equal(f.run.inlineCreationTestDelivery!.lease.leaseId, f.lease.leaseId, 'the test registers under the call\'s child lease');
  f.park();
  const foreign = leases.activateDispatchLease({ sessionId: f.session.id, scopeId: `${f.session.id}:other-runner`, runAttemptId: f.attempt.attemptId });
  assert.deepEqual(inline.inlineCreationTestReturnedMetadata({ sessionId: f.session.id, sourceUserSeq: f.source.seq, callId: f.callId,
    toolName: f.tool, result: f.output, invocationNonce: f.nonce, authoritativeReturn: true, dispatchLease: foreign }), {},
  'a runner lease that did not issue this call cannot seal it');
  assert.deepEqual(inline.inlineCreationTestReturnedMetadata({ sessionId: f.session.id, sourceUserSeq: f.source.seq, callId: `${f.callId}-other`,
    toolName: f.tool, result: f.output, invocationNonce: f.nonce, authoritativeReturn: true, dispatchLease: f.runnerLease! }), {},
  'the issuing lease seals only the call its child was bound to');
  const sealed = f.metadata();
  assert.ok(sealed.inlineCreationTestDelivery, 'the issuing runner lease seals the exact return');
  f.returned(sealed);
  assert.equal(inline.inlineCreationTestOriginDisposition(f.run, f.session.id), 'acknowledged');
  leases.revokeDispatchLease(foreign);
});

test('retention alone keeps only the matching inline origin pending; exact paired return repairs ACK after restart/expiry', () => {
  const f = fixture();
  assert.equal(inline.inlineCreationTestOriginDisposition(f.run, f.session.id), 'pending');
  assert.equal(inline.inlineCreationTestOriginDisposition(f.run, 'another-origin'), 'fallback');
  f.park();
  assert.equal(inline.inlineCreationTestOriginDisposition(f.run, f.session.id), 'pending', 'formatter retention is not delivery');
  f.returned();
  leases.revokeDispatchLease(f.lease);
  assert.equal(inline.inlineCreationTestOriginDisposition(f.run, f.session.id, Date.parse(f.run.inlineCreationTestDelivery!.expiresAt) + 1), 'acknowledged', 'durable timely delivery repairs a crash before ACK');
  assert.equal(withoutHostReceiptLines(f.output).includes(f.run.inlineCreationTestDelivery!.token), false, 'host proof is absent from human prose');
});

for (const outcome of ['done', 'blocked'] as const) test(`a truthful ${outcome} test ACKs only its legacy origin without claiming test success`, () => {
  const f = fixture({ outcome });
  const other = events.createSession({ kind: 'chat' });
  Object.assign(f.run, { originSessionIds: [f.session.id, other.id] });
  f.save();
  const delivered: string[] = [];
  reportBack._setWorkflowRunReportBackDeliveryForTests((_outcome, context) => {
    delivered.push(context.originSessionId!);
    return { acknowledged: true, disposition: 'acknowledged' } as never;
  });
  assert.equal(reportBack.attemptWorkflowRunReportBack(f.file), false);
  assert.deepEqual(delivered, [other.id], 'the other origin still receives its report while inline is pending');
  const pending = JSON.parse(readFileSync(f.file, 'utf8'));
  assert.equal(pending.reportBackRetry, undefined, 'an active bounded waiter consumes no failure/quarantine attempts');
  f.park(); f.returned();
  assert.equal(reportBack.attemptWorkflowRunReportBack(f.file), true);
  const acked = JSON.parse(readFileSync(f.file, 'utf8'));
  assert.deepEqual(new Set(acked.reportBack.acknowledgedOriginSessionIds), new Set([f.session.id, other.id]));
  assert.deepEqual(delivered, [other.id], 'the exact inline route was never posted a second time');
  assert.equal(acked.rehearsal.passed, outcome === 'done');
  assert.equal(acked.reportBack.outcome, outcome);
  reportBack._setWorkflowRunReportBackDeliveryForTests();
});

test('nested authoring uses the actual outer invocation; an inner nonce alone never proves top-level delivery', () => {
  const f = fixture({ nested: true });
  f.park(f.output, 'inner-only-nonce', `${f.callId}:inner`, 'workflow_create');
  assert.deepEqual(f.metadata(f.output, 'inner-only-nonce'), {});
  assert.equal(inline.inlineCreationTestOriginDisposition(f.run, f.session.id), 'pending');
  const outer = JSON.stringify({ content: [{ type: 'text', text: f.output }] });
  f.park(outer);
  const sealed = f.metadata({ content: [{ type: 'text', text: f.output }] });
  assert.ok(sealed.inlineCreationTestDelivery, 'formal outer MCP text-envelope parity is exact');
  f.returned(sealed);
  assert.equal(inline.inlineCreationTestOriginDisposition(f.run, f.session.id), 'acknowledged');
});

test('wrong actual bytes, foreign invocation, omitted live-return admission, and report drift never ACK', () => {
  for (const change of ['actual', 'nonce', 'late-audit', 'report', 'parent-source'] as const) {
    const f = fixture(); f.park();
    if (change === 'actual') assert.deepEqual(f.metadata(`${f.output}\nchanged`), {});
    else if (change === 'nonce') assert.deepEqual(f.metadata(f.output, 'foreign'), {});
    else if (change === 'late-audit') assert.deepEqual(f.metadata(f.output, f.nonce, false), {});
    else if (change === 'report') { f.returned(); f.run.reportBack.detail += ' changed after retention'; }
    else {
      const bad = events.appendEvent({ sessionId: f.session.id, role: 'Clem', type: 'tool_called', turn: 1, data: { sourceUserSeq: f.source.seq + 1, callId: f.callId, tool: f.tool, accounting: 'top_level' } });
      events.appendEvent({ sessionId: f.session.id, role: 'tool', type: 'tool_returned', turn: 1, parentEventId: bad.id,
        data: { sourceUserSeq: f.source.seq, callId: f.callId, tool: f.tool, accounting: 'top_level', ...f.metadata() } });
    }
    assert.notEqual(inline.inlineCreationTestOriginDisposition(f.run, f.session.id), 'acknowledged', change);
  }
});

test('Stop, release and expiry fall back when there is no timely paired delivery; late results cannot ACK', () => {
  for (const change of ['stop', 'release', 'expiry'] as const) {
    const f = fixture(); f.park();
    if (change === 'stop') events.requestKill(f.session.id, 'fixture Stop', { sourceUserSeq: f.source.seq });
    else if (change === 'release') { f.owned(() => inline.releaseInlineCreationTestWait(f.runId)); Object.assign(f.run, JSON.parse(readFileSync(f.file, 'utf8'))); }
    const now = change === 'expiry' ? Date.parse(f.run.inlineCreationTestDelivery!.expiresAt) + 1 : Date.now();
    assert.equal(inline.inlineCreationTestOriginDisposition(f.run, f.session.id, now), 'fallback');
    if (change !== 'expiry') {
      assert.equal(f.owned(() => inline.inlineCreationTestReceiptForSettlement({ runId: f.runId, body: f.run.reportBack.detail })), '');
      // A late audit event carries no host-authorized projection.
      f.returned(f.metadata(f.output, f.nonce, false));
      assert.equal(inline.inlineCreationTestOriginDisposition(f.run, f.session.id), 'fallback');
    }
  }
});

test('Stop or a newer real source blocks a fresh projection even while the physical lease remains current', () => {
  for (const change of ['stop', 'new-source'] as const) {
    const f = fixture(); f.park();
    if (change === 'stop') events.requestKill(f.session.id, 'fixture Stop', { sourceUserSeq: f.source.seq });
    else events.appendEvent({ sessionId: f.session.id, turn: 2, role: 'user', type: 'user_input_received', data: { text: 'Do a different controlled task.' } });
    assert.equal(leases.isDispatchLeaseCurrent(f.lease), true, 'lease liveness alone does not prove current accepted-source delivery');
    assert.deepEqual(f.metadata(), {});
    f.returned(f.metadata());
    assert.equal(inline.inlineCreationTestOriginDisposition(f.run, f.session.id), 'fallback');
  }
});


test('a real large formatter projection redeems only its exact outer retained invocation', () => {
  const f = fixture();
  const large = `${f.output}\n${'controlled fixture detail '.repeat(3_000)}`;
  const compact = leases.runWithDispatchLease(f.lease, () => withToolOutputContext({ sessionId: f.session.id,
    sourceUserSeq: f.source.seq, callId: f.callId, toolName: f.tool, settlementNonce: f.nonce },
    () => formatRecallableToolText(large, { maxChars: 1_000 }))) as string;
  assert.ok(compact.length < large.length);
  assert.match(compact, /exact-output-receipt:v1/);
  const valid = f.metadata(compact);
  assert.ok(valid.inlineCreationTestDelivery);
  assert.deepEqual(f.metadata(compact.replace(f.nonce, randomUUID())), {}, 'another invocation nonce does not redeem this output');
  assert.deepEqual(f.metadata(compact.replace(/sha256=[a-f0-9]{64}/, `sha256=${'0'.repeat(64)}`)), {}, 'a mutated digest is not a retained-output projection');
  assert.deepEqual(f.metadata('A snippet without an exact-output receipt.'), {}, 'arbitrary snippets do not redeem retained bytes');
  f.returned(valid);
  assert.equal(inline.inlineCreationTestOriginDisposition(f.run, f.session.id), 'acknowledged');
});

test('a real whole-payload host frame preserves payload bytes; altered payload cannot ACK', () => {
  const f = fixture();
  const frame = leases.runWithDispatchLease(f.lease, () => withToolOutputContext({ sessionId: f.session.id,
    sourceUserSeq: f.source.seq, callId: f.callId, toolName: f.tool, settlementNonce: f.nonce,
    wholeInlinePresentation: { nominalReadSucceeded: true, effectiveToolName: 'read_file' } },
    () => formatRecallableToolText(f.output))) as string;
  const parsed = JSON.parse(frame);
  assert.equal(parsed.__clementine.kind, 'whole_inline_result_v1');
  assert.equal(parsed.providerPayload, f.output);
  const valid = f.metadata(frame);
  assert.ok(valid.inlineCreationTestDelivery);
  assert.deepEqual(f.metadata(JSON.stringify({ ...parsed, providerPayload: 'changed' })), {});
  f.returned(valid);
  assert.equal(inline.inlineCreationTestOriginDisposition(f.run, f.session.id), 'acknowledged');
});


for (const stop of [false, true]) test(`the actual standard lifecycle ${stop ? 'preserves a late Stop audit without delivery ACK' : 'durably ACKs the matching inline result once'}`, () => {
  const f = fixture();
  const sdk = new EventEmitter();
  const detach = attachEventLogHooks(sdk, { getSessionId: () => f.session.id });
  const details = { toolCall: { callId: f.callId, id: f.callId, arguments: '{"name":"fixture"}' } };
  f.park();
  try {
    f.owned(() => withHarnessRunContext({ sessionId: f.session.id, sourceUserSeq: f.source.seq,
      runAttemptId: f.attempt.attemptId, dispatchLease: f.lease, counter: new ToolCallsCounter() }, () => {
      sdk.emit('agent_tool_start', {}, { name: 'Clem' }, { name: f.tool }, details);
      if (stop) events.requestKill(f.session.id, 'fixture Stop before lifecycle return', { sourceUserSeq: f.source.seq });
      sdk.emit('agent_tool_end', {}, { name: 'Clem' }, { name: f.tool }, f.output, details);
    }));
    const rows = events.listEvents(f.session.id, { types: ['tool_returned'] });
    assert.equal(rows.length, 1);
    const saved = JSON.parse(readFileSync(f.file, 'utf8'));
    if (stop) {
      assert.equal(rows[0]!.data.inlineCreationTestDelivery, undefined);
      assert.deepEqual(saved.reportBack.acknowledgedOriginSessionIds, []);
      assert.equal(inline.inlineCreationTestOriginDisposition(saved, f.session.id), 'fallback');
    } else {
      assert.ok(rows[0]!.data.inlineCreationTestDelivery);
      assert.deepEqual(saved.reportBack.acknowledgedOriginSessionIds, [f.session.id], 'post-commit nudge uses actual paired return proof');
      assert.ok(saved.reportBackAcknowledgedAt);
      inline.notifyInlineCreationTestReturned(rows[0]!.id);
      assert.deepEqual(JSON.parse(readFileSync(f.file, 'utf8')).reportBack.acknowledgedOriginSessionIds, [f.session.id], 'replay only repairs the same ACK');
    }
  } finally { detach(); }
});

test('the initial visible queue record already contains the exact authoring intent, before any await', async () => {
  const f = fixture();
  const { writeWorkflow } = await import('../memory/workflow-store.js');
  const { queueWorkflowCreationTest } = await import('../tools/workflow-run-queue.js');
  writeWorkflow('inline-queue-fixture', { name: 'inline-queue-fixture', description: 'controlled queue test', enabled: false,
    trigger: { manual: true }, steps: [{ id: 'fixture', prompt: 'Read controlled fixture', sideEffect: 'read' }] } as import('../memory/workflow-store.js').WorkflowDefinition);
  const queued = f.owned(() => queueWorkflowCreationTest('inline-queue-fixture', {}, { originSessionId: f.session.id }));
  assert.ok(queued.id);
  const initial = JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, `${queued.id}.json`), 'utf8'));
  assert.equal(initial.inlineCreationTestDelivery.runId, queued.id);
  assert.equal(initial.inlineCreationTestDelivery.sourceUserSeq, f.source.seq);
  assert.equal(initial.inlineCreationTestDelivery.logicalToolCallId, f.callId);
  assert.equal(inline.inlineCreationTestOriginDisposition(initial, f.session.id), 'pending');
});

test('a stale runner snapshot cannot erase a waiter release while publishing its terminal report', async () => {
  const f = fixture();
  const { publishWorkflowRunTerminalForTest } = await import('./workflow-runner.js');
  const queued = { ...f.run, finishedAt: undefined };
  writeFileSync(f.file, JSON.stringify(queued));
  f.owned(() => inline.releaseInlineCreationTestWait(f.runId));
  const release = JSON.parse(readFileSync(f.file, 'utf8')).inlineCreationTestDelivery.releasedAt;
  assert.ok(release);
  publishWorkflowRunTerminalForTest(f.file, { ...queued, finishedAt: new Date().toISOString() } as never,
    { workflowName: f.run.reportBack.workflowName, outcome: f.run.reportBack.outcome, detail: f.run.reportBack.detail });
  const saved = JSON.parse(readFileSync(f.file, 'utf8'));
  assert.equal(saved.inlineCreationTestDelivery.releasedAt, release);
  assert.equal(inline.inlineCreationTestOriginDisposition(saved, f.session.id), 'fallback');
});


for (const kind of ['background-report', 'live-approval', 'unknown-synthetic'] as const) {
  test(`the accepted-source gate treats ${kind} with the shared execution-boundary contract`, () => {
    const f = fixture(); f.park();
    const data = kind === 'background-report'
      ? { synthetic: true, source: 'outcome', deliveryPhase: 'passive', sourceLabel: 'workflow run', sourceId: 'controlled-background-result' }
      : kind === 'live-approval'
      ? { synthetic: true, liveApprovalControl: { version: 1, ownerAttemptId: f.attempt.attemptId, ownerSourceUserSeq: f.source.seq } }
      : { synthetic: true, source: 'outcome', text: 'Incomplete source marker is a new execution boundary.' };
    events.appendEvent({ sessionId: f.session.id, role: 'user', type: 'user_input_received', turn: 2, data,
      ...(kind === 'live-approval' ? { parentEventId: f.source.id } : {}) });
    const projection = f.metadata();
    if (kind === 'unknown-synthetic') {
      assert.deepEqual(projection, {});
      assert.equal(inline.inlineCreationTestOriginDisposition(f.run, f.session.id), 'fallback');
    } else {
      assert.ok(projection.inlineCreationTestDelivery, 'a recognized result/control is not a new assignment');
      f.returned(projection);
      assert.equal(inline.inlineCreationTestOriginDisposition(f.run, f.session.id), 'acknowledged');
    }
  });
}


for (const route of ['standard-bracket', 'direct-mcp', 'nested-mcp'] as const) {
  test(`real ${route} authoring creates and ACKs a query-owned intent without a global call lease`, async () => {
    const { createClementineMcpServer, initializeClementineMcpCapabilityAuthority } = await import('../tools/mcp-server.js');
    const { getLocalRuntimeTools } = await import('../tools/local-runtime-tools.js');
    const { wrapToolForHarness } = await import('../runtime/harness/brackets.js');
    const { writeWorkflow, readWorkflow } = await import('../memory/workflow-store.js');
    const { workflowRehearsalKey } = await import('./workflow-run-definition.js');
    const { publishWorkflowRunTerminalForTest } = await import('./workflow-runner.js');
    const { registerWorkflowRunDrainKick } = await import('../tools/workflow-run-queue.js');
    const session = events.createSession({ kind: 'chat' });
    const attempt = events.beginRunAttempt(session.id);
    const source = events.recordRunAttemptUserInput(attempt, { turn: 1, role: 'user', data: { text: 'Rehearse the controlled saved workflow without enabling it.' } });
    const { recordTurnGraphShadow } = await import('../runtime/graph/turn-graph-shadow.js');
    assert.ok(recordTurnGraphShadow({ identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 } }),
      'the legacy SDK/bracket fixture uses its real persisted graph authority, not a host-v1 root lacking capability attestation');
    const lease = leases.activateDispatchLease({ sessionId: session.id, scopeId: `${session.id}:physical-query`, runAttemptId: attempt.attemptId });
    assert.equal(lease.logicalToolCallId, undefined);
    assert.equal(leases.currentDispatchLease(), undefined, 'the production MCP path does not install global call authority');
    const slug = `delivery-${route}`;
    writeWorkflow(slug, { name: slug, description: 'controlled delivery fixture', enabled: false, trigger: { manual: true },
      steps: [{ id: 'read', prompt: 'Read controlled fixture', sideEffect: 'read' }] } as import('../memory/workflow-store.js').WorkflowDefinition);
    const callbackCallId = `actual-provider-${randomUUID()}`;
    const callbackTool = route === 'nested-mcp' ? 'call_tool' : 'workflow_test';
    const sdk = new EventEmitter();
    const detach = attachEventLogHooks(sdk, { getSessionId: () => session.id });
    const context = { sessionId: session.id, sourceUserSeq: source.seq, runAttemptId: attempt.attemptId,
      behaviorScopeId: `${session.id}:query`, dispatchLease: lease, counter: new ToolCallsCounter() };
    const input = route === 'nested-mcp' ? { name: 'workflow_test', args_json: JSON.stringify({ name: slug }) } : { name: slug };
    const details = { toolCall: { callId: callbackCallId, arguments: JSON.stringify(input) } };
    let savedRun: Record<string, unknown> | undefined;
    let producerError: unknown;
    // This fixture isolates delivery from execution quality: a controlled
    // producer publishes the real immutable terminal/report contract after the
    // ACTUAL authoring handler queues it. No models/providers or step writes run.
    const producer = setInterval(() => {
      if (savedRun || producerError) return;
      try {
        for (const name of readdirSync(WORKFLOW_RUNS_DIR)) {
          if (!name.endsWith('.json')) continue;
          const file = path.join(WORKFLOW_RUNS_DIR, name);
          const run = JSON.parse(readFileSync(file, 'utf8'));
          if (run.workflow !== slug || run.finishedAt) continue;
          const report = { workflowName: slug, outcome: 'done' as const, detail: `Controlled rehearsal for ${slug} returned fixture data; it remains disabled.` };
          savedRun = publishWorkflowRunTerminalForTest(file, { ...run, finishedAt: new Date().toISOString(),
            rehearsal: { passed: true, definitionKey: workflowRehearsalKey(readWorkflow(slug)!.data) } }, report) as unknown as Record<string, unknown>;
          // Publish first so an assertion about the initial record cannot
          // strand the real authoring waiter for its production240s bound.
          assert.ok(run.inlineCreationTestDelivery, 'intent is in the first queue record');
          assert.equal(run.inlineCreationTestDelivery.callId, undefined, 'no generated child id is promoted to original execution authority');
          assert.equal(run.inlineCreationTestDelivery.lease.leaseId, lease.leaseId);
          break;
        }
      } catch (error) { producerError = error; }
    }, 5);
    const unregister = registerWorkflowRunDrainKick(() => {});
    try {
      const result = await withHarnessRunContext(context, async () => {
        sdk.emit('agent_tool_start', {}, { name: 'Clem' }, { name: callbackTool }, details);
        if (route === 'standard-bracket') {
          const real = getLocalRuntimeTools().find(tool => tool.name === 'workflow_test');
          assert.ok(real);
          const wrapped = wrapToolForHarness(real as never) as unknown as { invoke: (context: unknown, input: string, details: unknown) => Promise<unknown> };
          return wrapped.invoke({ context: { sessionId: session.id, sourceUserSeq: source.seq } },
            JSON.stringify({ name: slug, test_inputs: null }), details);
        }
        const server = createClementineMcpServer({ sessionId: session.id, sourceUserSeq: source.seq,
          runScopeId: context.behaviorScopeId, dispatchLease: lease,
          ...(route === 'nested-mcp' ? { allowedTools: ['call_tool', 'tool_search'], deferredTools: ['workflow_test'] } : { allowedTools: ['workflow_test'] }) });
        const registered = (server as unknown as { _registeredTools: Record<string, { handler: (input: unknown) => Promise<unknown> }> })._registeredTools;
        if (route === 'nested-mcp') {
          assert.equal(await initializeClementineMcpCapabilityAuthority(server), true);
          await registered.tool_search!.handler({ query: 'workflow_test', limit: 5 });
        }
        return registered[callbackTool]!.handler(input);
      });
      if (producerError) throw producerError;
      assert.ok(savedRun, `the actual ${route} handler queued the creation test`);
      const text = typeof result === 'string' ? result : JSON.stringify(result);
      assert.match(text, /clementine:inline-creation-test:v1/);
      const existing = events.listToolOutputInvocationNonces(session.id, callbackCallId, 2);
      const nonce = route === 'standard-bracket' && existing.length === 1 ? existing[0]! : randomUUID();
      if (route !== 'standard-bracket' || existing.length === 0) events.writeToolOutput({ sessionId: session.id, callId: callbackCallId,
        tool: callbackTool, output: text, invocationNonce: nonce });
      const foreign = leases.activateDispatchLease({ sessionId: session.id, scopeId: `${session.id}:foreign-query`, runAttemptId: attempt.attemptId });
      assert.deepEqual(inline.inlineCreationTestReturnedMetadata({ sessionId: session.id, sourceUserSeq: source.seq,
        callId: callbackCallId, toolName: callbackTool, result, invocationNonce: nonce, authoritativeReturn: true, dispatchLease: foreign }), {},
      'another live query on the same accepted source cannot claim this report');
      withHarnessRunContext(context, () => sdk.emit('agent_tool_end', {}, { name: 'Clem' }, { name: callbackTool }, result, details));
      const returned = events.listEvents(session.id, { types: ['tool_returned'] }).filter(row => row.data.accounting === 'top_level');
      assert.equal(returned.length, 1);
      assert.ok(returned[0]!.data.inlineCreationTestDelivery, 'actual retained outer callback seals the source/query-owned report');
      const canonical = JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, `${savedRun.id}.json`), 'utf8'));
      assert.deepEqual(canonical.reportBack.acknowledgedOriginSessionIds, [session.id]);
      assert.equal(leases.currentDispatchLease(), undefined, 'delivery proof never installs execution authority');
    } finally { clearInterval(producer); unregister(); detach(); }
  });
}
