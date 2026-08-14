/**
 * RED (by absence): fresh/current claims need accepted-task-local evidence.
 *
 * A "today"/"current" ask is a question about NOW. A prior turn's settled read
 * proves what was true THEN; it cannot silently satisfy a new today-question
 * unless an explicit typed freshness lease says so. Learned memory may say HOW
 * to retrieve, never what today's state IS. Today no typed freshness decision
 * exists anywhere for reads: a current-state reply grounded only in prior-turn
 * evidence publishes untouched through the conversational door unless its
 * wording happens to trip a text-shape guard (live 2026-08-11).
 *
 * Carrier chosen for the pin (of the mapper's two candidates): the terminal
 * preparation result for the accepted source. The fix must surface EITHER a
 * typed `freshness` decision on the preparation result OR a typed freshness
 * gap kind in `missing` — this test accepts both shapes and fails while
 * neither exists.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-freshness-lease-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-freshness-lease\n', 'utf8');

const eventlog = await import('./eventlog.js');
const shadow = await import('../graph/turn-graph-shadow.js');
const identities = await import('./attempt-identity.js');
const contracts = await import('./expected-work-contract.js');
const admission = await import('./expected-work-admission.js');
const dispatch = await import('./dispatch-ledger.js');
const outcomes = await import('./attempt-outcome.js');
const settlements = await import('./logical-call-settlement-store.js');
const preparation = await import('./accepted-task-terminal-preparation.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

test('a today-ask answered on prior-turn evidence alone requires a typed freshness decision', () => {
  const session = eventlog.createSession({ id: 'freshness-lease-1', kind: 'chat' });

  // Turn N: a real settled business read — durable evidence of THAT day's state.
  const priorSource = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Find all current alpha records.' },
  });
  const priorTask = {
    sessionId: session.id,
    sourceUserSeq: priorSource.seq,
    turn: 1,
    acceptedTaskId: identities.acceptedTaskIdFor(session.id, priorSource.seq),
  };
  assert.ok(shadow.recordTurnGraphShadow({
    identity: { sessionId: session.id, sourceUserSeq: priorSource.seq, turn: 1 },
  }));
  const fixed = contracts.freezeDeterministicExpectedWorkContract(priorTask);
  assert.ok(fixed.status === 'fixed' || fixed.status === 'replayed', JSON.stringify(fixed));
  const logicalToolCallId = 'logical:freshness-prior-read';
  const begun = dispatch.beginPhysicalDispatch({
    identity: {
      ...priorTask,
      logicalToolCallId,
      physicalDispatchId: 'dispatch:freshness-prior-read',
      ordinal: 0,
    },
    tool: 'alpha_records_search',
    args: { query: 'alpha' },
  });
  assert.equal(begun.status, 'inserted', JSON.stringify(begun));
  if (begun.status !== 'inserted') return;
  assert.equal(dispatch.settlePhysicalDispatch({
    identity: begun.identity,
    tool: 'alpha_records_search',
    outcome: 'returned',
  }).status, 'inserted');
  const settled = settlements.commitLogicalCallSettlement({
    identity: { ...priorTask, logicalToolCallId },
    contract: { toolName: 'alpha_records_search', args: { query: 'alpha' } },
    execution: { kind: 'provider_execution' },
    result: {
      payload: {
        successful: true,
        data: { records: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] },
        meta: { complete: true },
      },
    },
    outcome: outcomes.classifyAttemptOutcome({ envelopeSuccessful: true }),
    recovery: { businessCall: true, mutating: false },
    observer: { lane: 'composio', turn: 1 },
  });
  assert.equal(settled.status, 'committed', JSON.stringify(settled));
  const priorPrepared = preparation.prepareAcceptedTaskTerminal(priorTask);
  assert.equal(priorPrepared.status, 'ready', JSON.stringify(priorPrepared));

  // Turn N+1: the same session asks a NEW today-question and settles nothing.
  const todaySource = eventlog.appendEvent({
    sessionId: session.id,
    turn: 2,
    role: 'user',
    type: 'user_input_received',
    data: { text: "what's on my plate today?" },
  });
  const todayTask = { sessionId: session.id, sourceUserSeq: todaySource.seq };
  assert.ok(shadow.recordTurnGraphShadow({
    identity: { sessionId: session.id, sourceUserSeq: todaySource.seq, turn: 2 },
  }));
  const activated = admission.activateActionExpectedWork(todayTask);
  assert.ok(
    activated.status === 'activated'
    || activated.status === 'replayed'
    || activated.status === 'not_action',
    JSON.stringify(activated),
  );

  // The reply asserts CURRENT state without one settlement in this turn.
  const prepared = preparation.prepareAcceptedTaskTerminal({
    ...todayTask,
    proposedReply: 'You have 3 items on your plate today.',
  });

  const freshness = (prepared as { freshness?: { decision?: unknown } }).freshness;
  const missing = prepared.status === 'needs_verification' ? prepared.missing ?? [] : [];
  assert.ok(
    freshness !== undefined || missing.some((gap) => /fresh/i.test(gap)),
    'a current-state reply for a today-ask with zero task-local settlements '
    + 'must carry a typed freshness decision (or a typed freshness gap) — '
    + 'a prior turn cannot silently satisfy a new today-question without an '
    + 'explicit freshness lease. Got: '
    + JSON.stringify(prepared),
  );
});
