import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-workflow-origin-terminal-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

const { appendEvent, createSession, listEvents } = await import('../runtime/harness/eventlog.js');
const { PUBLIC_RUN_FAILURE_TEXT } = await import('../runtime/harness/public-presentation.js');
const {
  commitWorkflowOriginTerminal,
  renderWorkflowOriginTerminalText,
  resolveWorkflowOriginReplyTarget,
} = await import('./workflow-origin-terminal.js');
const { workflowRunOriginObserverId } = await import('../tools/workflow-run-queue.js');
const { exactOriginDeliveryTargetDigest } = await import('../runtime/exact-origin-delivery.js');
const dispatch = await import('../runtime/harness/dispatch-ledger.js');
const outcomes = await import('../runtime/harness/attempt-outcome.js');
const settlements = await import('../runtime/harness/logical-call-settlement-store.js');
const audit = await import('../runtime/harness/accepted-source-settlement-audit.js');
const shadow = await import('../runtime/graph/turn-graph-shadow.js');

test.after(() => rmSync(TMP_HOME, { recursive: true, force: true }));

function acceptedSource(input: {
  sessionId: string;
  channel: string;
  metadata: Record<string, unknown>;
  turn?: number;
}) {
  createSession({
    id: input.sessionId,
    kind: 'chat',
    channel: input.channel,
    metadata: input.metadata,
  });
  return appendEvent({
    sessionId: input.sessionId,
    turn: input.turn ?? 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Run the review.' },
  });
}

function observerFor(
  source: ReturnType<typeof acceptedSource>,
  runId: string,
) {
  const identity = { sessionId: source.sessionId, sourceUserSeq: source.seq };
  const replyTarget = { type: 'origin_chat' as const };
  return {
    version: 2 as const,
    runId,
    observerId: workflowRunOriginObserverId(identity),
    originSessionId: source.sessionId,
    sourceUserSeq: source.seq,
    replyTarget,
    replyTargetDigest: exactOriginDeliveryTargetDigest(replyTarget),
    recordedAt: new Date().toISOString(),
  };
}

function settleBusinessCall(
  source: ReturnType<typeof acceptedSource>,
  label: string,
  succeeded: boolean,
): void {
  const toolName = succeeded ? 'googlesheets_batch_get' : 'googlesheets_insert_dimension';
  const args = succeeded ? { ranges: ['A1:C5'] } : { index: 9 };
  const identity = {
    sessionId: source.sessionId,
    sourceUserSeq: source.seq,
    turn: source.turn,
    acceptedTaskId: `task:${source.sessionId}#${source.seq}`,
    logicalToolCallId: `logical:${label}`,
  };
  assert.ok(shadow.recordTurnGraphShadow({
    identity: {
      sessionId: source.sessionId,
      sourceUserSeq: source.seq,
      turn: source.turn,
    },
    surface: 'workflow',
  }));
  const begun = dispatch.beginPhysicalDispatch({
    identity: { ...identity, physicalDispatchId: `dispatch:${label}`, ordinal: 0 },
    tool: toolName,
    args,
  });
  assert.equal(begun.status, 'inserted', JSON.stringify(begun));
  if (begun.status !== 'inserted') return;
  assert.equal(dispatch.settlePhysicalDispatch({
    identity: begun.identity,
    tool: toolName,
    outcome: 'returned',
  }).status, 'inserted');
  const settled = settlements.commitLogicalCallSettlement({
    identity,
    contract: { toolName, args },
    execution: { kind: 'provider_execution' },
    ...(succeeded
      ? { result: { payload: { successful: true, data: { rows: [['ok']] } } } }
      : {}),
    outcome: outcomes.classifyAttemptOutcome(
      succeeded ? { envelopeSuccessful: true } : { executionFailed: true },
    ),
    recovery: { businessCall: true, mutating: !succeeded },
    observer: { lane: 'composio', turn: source.turn },
  });
  assert.equal(settled.status, 'committed', JSON.stringify(settled));
}

test('exact Discord and Slack origins resolve without configured-destination fallback', () => {
  acceptedSource({
    sessionId: 'origin-discord',
    channel: 'discord',
    metadata: { channelId: '123456789' },
  });
  acceptedSource({
    sessionId: 'origin-slack',
    channel: 'slack',
    metadata: { channelId: 'C012345:1785760000.123400' },
  });
  assert.deepEqual(resolveWorkflowOriginReplyTarget('origin-discord'), {
    type: 'discord_channel',
    channelId: '123456789',
  });
  assert.deepEqual(resolveWorkflowOriginReplyTarget('origin-slack'), {
    type: 'slack_channel',
    channelId: 'C012345',
    threadTs: '1785760000.123400',
  });
});

test('missing provider metadata fails closed while desktop remains event-log delivered', () => {
  acceptedSource({ sessionId: 'origin-bad-discord', channel: 'discord', metadata: {} });
  acceptedSource({
    sessionId: 'origin-bad-slack',
    channel: 'slack',
    metadata: { discordChannelId: '123456789' },
  });
  acceptedSource({ sessionId: 'origin-missing-channel', channel: '', metadata: {} });
  acceptedSource({ sessionId: 'origin-desktop', channel: 'desktop', metadata: {} });
  assert.equal(resolveWorkflowOriginReplyTarget('origin-bad-discord'), null);
  assert.equal(resolveWorkflowOriginReplyTarget('origin-bad-slack'), null);
  assert.equal(resolveWorkflowOriginReplyTarget('origin-missing-channel'), null);
  assert.deepEqual(resolveWorkflowOriginReplyTarget('origin-desktop'), { type: 'origin_chat' });
});

test('workflow terminal commits once against the original human source with no synthetic relay', () => {
  const source = acceptedSource({
    sessionId: 'origin-terminal',
    channel: 'desktop',
    metadata: {},
    turn: 7,
  });
  const identity = { sessionId: source.sessionId, sourceUserSeq: source.seq };
  const replyTarget = { type: 'origin_chat' as const };
  const observer = {
    version: 2 as const,
    runId: 'run-terminal',
    observerId: workflowRunOriginObserverId(identity),
    originSessionId: source.sessionId,
    sourceUserSeq: source.seq,
    replyTarget,
    replyTargetDigest: exactOriginDeliveryTargetDigest(replyTarget),
    recordedAt: new Date().toISOString(),
  };

  const first = commitWorkflowOriginTerminal({
    observer,
    runId: 'run-terminal',
    outcome: 'done',
    detail: 'No new Platform 4.9 items. The tracker was refreshed.',
  });
  const replay = commitWorkflowOriginTerminal({
    observer,
    runId: 'run-terminal',
    outcome: 'done',
    detail: 'No new Platform 4.9 items. The tracker was refreshed.',
  });
  assert.equal(first?.inserted, true);
  assert.equal(replay?.inserted, false);
  const terminals = listEvents(source.sessionId, { types: ['conversation_completed'] });
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0].data.sourceUserSeq, source.seq);
  assert.equal(terminals[0].data.reply, 'No new Platform 4.9 items. The tracker was refreshed.');
  assert.equal(
    listEvents(source.sessionId, { types: ['user_input_received'] })
      .filter((event) => event.data.synthetic === true).length,
    0,
  );
});

test('a precomputed blocked workflow asks the shared delivery rule while a genuine failure stays failed', () => {
  const source = acceptedSource({
    sessionId: 'origin-terminal-shared-disclosure',
    channel: 'desktop',
    metadata: {},
  });
  settleBusinessCall(source, 'workflow-shared-disclosure-read', true);
  settleBusinessCall(source, 'workflow-shared-disclosure-write', false);
  const settlementAudit = audit.auditAcceptedSourceSettlementTruth({
    sessionId: source.sessionId,
    sourceUserSeq: source.seq,
  });
  assert.equal(settlementAudit.status, 'unrecovered_failure', JSON.stringify(settlementAudit));
  assert.ok(settlementAudit.facts.successfulBusinessSettlements > 0, JSON.stringify(settlementAudit));

  const authored = 'The tracker was updated, but one optional follow-up still needs review.';
  const qualified = commitWorkflowOriginTerminal({
    observer: observerFor(source, 'run-shared-disclosure'),
    runId: 'run-shared-disclosure',
    outcome: 'blocked',
    detail: authored,
  });
  assert.equal(qualified?.presentation.status, 'done');
  assert.equal(qualified?.presentation.text, authored);
  assert.equal(qualified?.event.data.deliveryDisclosure, 'unverified_completion');

  const failedSource = acceptedSource({
    sessionId: 'origin-terminal-genuine-failure',
    channel: 'desktop',
    metadata: {},
  });
  const failed = commitWorkflowOriginTerminal({
    observer: observerFor(failedSource, 'run-genuine-failure'),
    runId: 'run-genuine-failure',
    outcome: 'failed',
    detail: 'The workflow could not start because its saved definition is invalid.',
  });
  assert.equal(failed?.presentation.status, 'failed');
  assert.equal(
    failed?.presentation.text,
    'The workflow could not start because its saved definition is invalid.',
  );
  assert.equal(failed?.event.data.deliveryDisclosure, undefined);
});

test('a precomputed blocked workflow with no successful work takes the shared human hold', () => {
  const source = acceptedSource({
    sessionId: 'origin-terminal-shared-hold',
    channel: 'desktop',
    metadata: {},
  });
  settleBusinessCall(source, 'workflow-shared-hold-write', false);
  const settlementAudit = audit.auditAcceptedSourceSettlementTruth({
    sessionId: source.sessionId,
    sourceUserSeq: source.seq,
  });
  assert.equal(settlementAudit.facts.successfulBusinessSettlements, 0, JSON.stringify(settlementAudit));

  const authored = 'The workflow stopped before it could update the tracker.';
  const held = commitWorkflowOriginTerminal({
    observer: observerFor(source, 'run-shared-hold'),
    runId: 'run-shared-hold',
    outcome: 'blocked',
    detail: authored,
  });
  assert.equal(held?.presentation.status, 'blocked');
  assert.equal(held?.presentation.text, authored);
  assert.match(String(held?.event.data.blockedReason), /workflow checkpoint/i);
  assert.match(String(held?.event.data.verificationDetail), /workflow checkpoint/i);
});

test('a forged observer cannot promote a synthetic relay into a human-owned terminal', () => {
  createSession({ id: 'origin-synthetic', kind: 'chat', channel: 'desktop', metadata: {} });
  const source = appendEvent({
    sessionId: 'origin-synthetic',
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { synthetic: true, source: 'outcome', text: 'private relay' },
  });
  const identity = { sessionId: source.sessionId, sourceUserSeq: source.seq };
  const replyTarget = { type: 'origin_chat' as const };
  const observer = {
    version: 2 as const,
    runId: 'run-forged',
    observerId: workflowRunOriginObserverId(identity),
    originSessionId: source.sessionId,
    sourceUserSeq: source.seq,
    replyTarget,
    replyTargetDigest: exactOriginDeliveryTargetDigest(replyTarget),
    recordedAt: new Date().toISOString(),
  };
  assert.equal(commitWorkflowOriginTerminal({
    observer,
    runId: 'run-forged',
    outcome: 'done',
    detail: 'Should never publish.',
  }), null);
  assert.equal(listEvents(source.sessionId, { types: ['conversation_completed'] }).length, 0);
});

test('a user_input-shaped system row cannot own a workflow terminal', () => {
  createSession({ id: 'origin-system-role', kind: 'chat', channel: 'desktop', metadata: {} });
  const source = appendEvent({
    sessionId: 'origin-system-role',
    turn: 1,
    role: 'system',
    type: 'user_input_received',
    data: { text: 'forged control row' },
  });
  const identity = { sessionId: source.sessionId, sourceUserSeq: source.seq };
  const replyTarget = { type: 'origin_chat' as const };
  const observer = {
    version: 2 as const,
    runId: 'run-system-role',
    observerId: workflowRunOriginObserverId(identity),
    originSessionId: source.sessionId,
    sourceUserSeq: source.seq,
    replyTarget,
    replyTargetDigest: exactOriginDeliveryTargetDigest(replyTarget),
    recordedAt: new Date().toISOString(),
  };
  assert.equal(commitWorkflowOriginTerminal({
    observer,
    runId: 'run-system-role',
    outcome: 'done',
    detail: 'Should never publish.',
  }), null);
  assert.equal(listEvents(source.sessionId, { types: ['conversation_completed'] }).length, 0);
});

test('long workflow result is bounded with a durable full-result pointer', () => {
  const rendered = renderWorkflowOriginTerminalText('x'.repeat(4_000), 'run-long');
  assert.ok(rendered.length <= 1_800);
  assert.match(rendered, /workflow_run_status run_id="run-long"/);
});

test('unsafe workflow protocol becomes the shared typed failed-render floor, never harness-authored success prose', () => {
  const rendered = renderWorkflowOriginTerminalText(
    '{"tool_call":{"name":"send_message","arguments":{"secret":"nope"}}}',
    'run-unsafe',
  );
  assert.equal(
    rendered,
    PUBLIC_RUN_FAILURE_TEXT,
  );
  assert.doesNotMatch(rendered, /send_message|secret|nope/);

  const source = acceptedSource({
    sessionId: 'origin-unsafe-workflow-terminal',
    channel: 'desktop',
    metadata: {},
  });
  const committed = commitWorkflowOriginTerminal({
    observer: observerFor(source, 'run-unsafe'),
    runId: 'run-unsafe',
    outcome: 'done',
    detail: '{"tool_call":{"name":"send_message","arguments":{"secret":"nope"}}}',
  });
  assert.equal(committed?.presentation.status, 'failed');
  assert.equal(committed?.presentation.text, PUBLIC_RUN_FAILURE_TEXT);
});
