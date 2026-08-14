/**
 * Run: npx tsx --test src/runtime/harness/envelope-inspection-verdict.red.test.ts
 *
 * INVARIANT — dispatch outcome is separate from evidence eligibility.
 *
 * The provider-envelope inspector is bounded (depth/node/entry limits). Hitting
 * a bound means the envelope is UNINSPECTED, never CONTRADICTED: a clean
 * top-level ack (`successful:true`, `error:null`, `data.ok:true`) settles the
 * dispatch as succeeded even when deeper content is uninspectable. Inability
 * to inspect must not rewrite a successful dispatch into ignored_requirement,
 * eliminate the working candidate, or open a discovery epoch. Content-derived
 * PROOF (exhaustion/completeness) still requires a clean inspection — an
 * uninspected envelope mints no proof — but that is an evidence question, not
 * a dispatch verdict (live 2026-08-11: a working tool was eliminated and
 * discovery reopened off a large, perfectly clean provider response).
 *
 * Genuine structured contradictions WITHIN bounds must keep failing: those
 * guards are pinned here at the same seam.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-envelope-verdict-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-envelope-verdict\n', 'utf8');

const eventlog = await import('./eventlog.js');
const shadow = await import('../graph/turn-graph-shadow.js');
const identity = await import('./attempt-identity.js');
const dispatch = await import('./dispatch-ledger.js');
const governorModule = await import('./discovery-governor.js');
const settlement = await import('./attempt-settlement.js');
const resultHandles = await import('./result-handle.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

let serial = 0;

function accept(label: string) {
  const session = eventlog.createSession({ id: `envelope-verdict-${++serial}`, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: `Read the ${label} records and report what you find.` },
  });
  assert.ok(shadow.recordTurnGraphShadow({
    identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 },
  }), 'fixture graph persisted');
  return {
    sessionId: session.id,
    sourceUserSeq: source.seq,
    turn: 1,
    acceptedTaskId: identity.acceptedTaskIdFor(session.id, source.seq),
  };
}

/** A real provider crossing, exactly as every dispatching lane records one. */
function admitReturnedProviderCall(input: {
  task: ReturnType<typeof accept>;
  logicalToolCallId: string;
  tool: string;
  args: unknown;
}) {
  const started = dispatch.beginPhysicalDispatch({
    identity: {
      ...input.task,
      logicalToolCallId: input.logicalToolCallId,
      physicalDispatchId: `dispatch:${input.logicalToolCallId}`,
      ordinal: 0,
    },
    tool: input.tool,
    args: input.args,
  });
  assert.equal(started.status, 'inserted', 'fixture crossing admitted');
  if (started.status !== 'inserted') throw new Error('provider fixture was not admitted');
  assert.equal(dispatch.settlePhysicalDispatch({
    identity: started.identity,
    tool: input.tool,
    outcome: 'returned',
  }).status, 'inserted', 'fixture crossing returned');
}

function settleReturned(input: {
  task: ReturnType<typeof accept>;
  logicalToolCallId: string;
  tool: string;
  args: unknown;
  result: unknown;
}) {
  admitReturnedProviderCall(input);
  return settlement.settleToolAttempt({
    ...input.task,
    lane: 'composio',
    toolName: input.tool,
    callId: input.logicalToolCallId,
    args: input.args,
    businessCall: true,
    mutating: false,
    result: input.result,
  });
}

/**
 * A clean, wide Slack-like listing ack (~50KB). The bulk sits under
 * `data.channels` DELIBERATELY: the inspector's result-array skip list spares
 * `data.messages` / `records` / `items` etc., and a fixture under one of those
 * keys would never reach the node bound. 220 channel objects x 3 nodes each
 * exceed the 512-node traversal bound while every inspected field is clean.
 */
function wideCleanAck(): unknown {
  return {
    successful: true,
    error: null,
    data: {
      ok: true,
      channels: Array.from({ length: 220 }, (_, i) => ({
        id: `C0${1000 + i}`,
        name: `growth-pod-${i}`,
        is_channel: true,
        topic: { value: `Weekly growth sync ${i}`, creator: 'U02QGK9AL', last_set: 1719430000 + i },
        purpose: { value: 'Pipeline reviews and follow-ups', creator: 'U02QGK9AL', last_set: 1719430000 + i },
      })),
      response_metadata: { next_cursor: '' },
    },
  };
}

test('a deep clean provider ack settles as succeeded — an uninspectable envelope is not a contradiction', () => {
  const task = accept('wide clean listing');
  const tool = 'workchat__conversations_list';
  const args = { limit: 200 };
  const settled = settleReturned({
    task,
    logicalToolCallId: 'logical:wide-clean',
    tool,
    args,
    result: wideCleanAck(),
  });
  // TARGET: today this is 'ignored_requirement' — the bounded inspector calls
  // the limit a contradiction and the settlement rewrites its own success.
  assert.equal(
    settled.outcome.kind,
    'succeeded',
    `a clean top-level ack settles the dispatch; got ${JSON.stringify(settled.outcome)}`,
  );
});

test('a deep clean provider ack does not eliminate the settling candidate for the task', () => {
  const task = accept('candidate keeps working');
  const tool = 'workchat__conversations_list';
  const args = { limit: 200 };
  settleReturned({
    task,
    logicalToolCallId: 'logical:keeps-candidate',
    tool,
    args,
    result: wideCleanAck(),
  });
  // TARGET: today the rewritten ignored_requirement durably records
  // eliminates_candidate=1 and the working tool disappears from the task.
  assert.equal(
    settlement.candidateEliminatedForTask(task.sessionId, task.sourceUserSeq, tool),
    false,
    'a successful call must never prove its own candidate unsuitable',
  );
});

test('a deep clean provider ack mints redeemable result authority', () => {
  const task = accept('result authority');
  const settled = settleReturned({
    task,
    logicalToolCallId: 'logical:mints-handle',
    tool: 'workchat__conversations_list',
    args: { limit: 200 },
    result: wideCleanAck(),
  });
  // TARGET: today no handle exists because the settlement never records the
  // success it was handed.
  assert.equal(
    typeof settled.resultHandleId,
    'string',
    'a succeeded provider settlement carries durable raw-result authority',
  );
});

test('a successful new capability may credit the next bounded discovery epoch', () => {
  const task = accept('no discovery epoch');
  const governor = new governorModule.DiscoveryGovernor();
  // Known capability: the first broad search is already spent, so bogus
  // candidate_unsupported evidence would open a fresh epoch immediately.
  governor.initializeTask({ ...task, knownCapability: true });
  const settled = settleReturned({
    task,
    logicalToolCallId: 'logical:no-epoch',
    tool: 'workchat__conversations_list',
    args: { limit: 200 },
    result: wideCleanAck(),
  });
  // TARGET: today the rewrite emits candidate_unsupported governor evidence
  // and the settlement opens a discovery epoch off a successful response.
  assert.equal(
    settled.openedDiscoveryEpoch,
    true,
    'successful progress may unlock the next requirement without treating the envelope as a failure',
  );
  assert.equal(governor.getTaskState(task)?.policy.epoch, 1, 'progress opens exactly one bounded epoch');
});

test('a contradiction beyond the inspection bound settles the dispatch on the clean top-level ack, and mints no content proof', () => {
  const task = accept('buried contradiction');
  // The failure marker sits ~14 levels deep — past the depth bound, so the
  // inspector cannot see it. Everything it CAN inspect is clean.
  let buried: Record<string, unknown> = { error: 'channel_not_found', ok: false };
  for (let i = 0; i < 10; i += 1) buried = { elements: [buried] };
  const result = {
    successful: true,
    error: null,
    data: {
      ok: true,
      channel: 'C0925AL',
      ts: '1754899123.000200',
      message: { blocks: [buried] },
    },
  };
  const logicalToolCallId = 'logical:buried-contradiction';
  const settled = settleReturned({
    task,
    logicalToolCallId,
    tool: 'workchat__post_lookup',
    args: { channel: 'C0925AL' },
    result,
  });
  // TARGET half 1: the dispatch verdict comes from what WAS inspected — the
  // clean top-level ack. Today this settles ignored_requirement.
  assert.equal(
    settled.outcome.kind,
    'succeeded',
    `an uninspectable depth does not un-succeed a clean ack; got ${JSON.stringify(settled.outcome)}`,
  );
  // Half 2: evidence eligibility stays fail-closed. Whatever the settlement
  // minted, an envelope the host could not fully inspect proves NOTHING about
  // content: the read is never exhausted, completeness is never 'complete'.
  if (settled.resultHandleId) {
    const redeemed = resultHandles.redeemSuccessfulSettlementResultForHost({
      sessionId: task.sessionId,
      sourceUserSeq: task.sourceUserSeq,
      acceptedTaskId: task.acceptedTaskId,
      logicalToolCallId,
    });
    if (redeemed.status === 'ok') {
      assert.equal(
        resultHandles.redeemedReadIsExhausted(redeemed.value),
        false,
        'an uninspected envelope must never prove the read exhausted',
      );
      assert.notEqual(
        redeemed.value.handle.completeness,
        'complete',
        'completeness is content-derived proof and requires a clean inspection',
      );
    }
  }
});

test('GUARD: a shallow structured failure within bounds (nested isError + 503) stays a failure at the settlement seam', () => {
  const task = accept('shallow nested failure');
  const settled = settleReturned({
    task,
    logicalToolCallId: 'logical:nested-503',
    tool: 'workchat__conversations_list',
    args: { limit: 20 },
    result: {
      successful: true,
      error: null,
      data: { isError: true, status: 503, message: 'The service is temporarily unavailable.' },
    },
  });
  assert.notEqual(settled.outcome.kind, 'succeeded', 'a nested structured failure is not success');
  assert.notEqual(settled.outcome.kind, 'empty_result');
  assert.equal(settled.resultHandleId, undefined, 'no result authority mints from a failure');
});

test('GUARD: successful:false settles as a failure at the settlement seam', () => {
  const task = accept('envelope failure');
  const settled = settleReturned({
    task,
    logicalToolCallId: 'logical:envelope-false',
    tool: 'workchat__conversations_list',
    args: { limit: 20 },
    result: { successful: false, error: 'channel_not_found', data: null },
  });
  assert.notEqual(settled.outcome.kind, 'succeeded', 'an explicit envelope failure is not success');
  assert.equal(settled.resultHandleId, undefined);
  assert.equal(settled.creditedProgress, false);
});

test('GUARD: a genuine nested contradiction WITHIN bounds (5-digit provider status) stays a non-success', () => {
  const task = accept('genuine nested contradiction');
  // The provider says successful:true while its payload carries an explicit
  // 5-digit failure status a few levels down — fully inspectable, genuinely
  // contradicted. This must keep failing after limits become 'uninspected'.
  const settled = settleReturned({
    task,
    logicalToolCallId: 'logical:five-digit-status',
    tool: 'rankdata__task_get',
    args: { task_id: 'task-7' },
    result: {
      successful: true,
      error: null,
      data: { status: 40401, status_message: 'Task not found.', tasks: [] },
    },
  });
  assert.notEqual(settled.outcome.kind, 'succeeded', 'a contradicted envelope is not success');
  assert.equal(settled.resultHandleId, undefined, 'no result authority mints from a contradiction');
});
