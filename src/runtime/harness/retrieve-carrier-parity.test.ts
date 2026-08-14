/**
 * CARRIER PARITY for the deterministic retrieve route.
 *
 * The same semantic ask must reach the same terminal truth whatever carrier
 * grounded it: memory (zero tool calls), a provider point read, a provider
 * collection read (with or without a provable end), a read-only CLI through
 * the shell, or a local file read. Two live incidents (2026-08-11 shell,
 * 2026-08-12 calendar) blocked correct answers because each carrier met a
 * predicate written for a different carrier — and every per-incident test
 * passed while the sibling carrier stayed broken. This sweep exists so a
 * predicate change that strands ANY carrier fails here, not in a live run.
 *
 * Each grounded case must clear the WHOLE gauntlet: terminal preparation
 * (contract finalization + evidence issuing) AND terminal publication (the
 * durable proof recomputation) — the calendar incident spanned both.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-retrieve-parity-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-retrieve-parity\n', 'utf8');

const eventlog = await import('./eventlog.js');
const shadow = await import('../graph/turn-graph-shadow.js');
const identities = await import('./attempt-identity.js');
const contracts = await import('./expected-work-contract.js');
const dispatch = await import('./dispatch-ledger.js');
const outcomes = await import('./attempt-outcome.js');
const settlements = await import('./logical-call-settlement-store.js');
const attempts = await import('./attempt-settlement.js');
const authority = await import('./accepted-task-authority.js');
const preparation = await import('./accepted-task-terminal-preparation.js');
const delivery = await import('./delivery-committer.js');
const turnOutcomes = await import('./turn-outcome.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

let serial = 0;

interface RetrieveTask {
  sessionId: string;
  sourceUserSeq: number;
  turn: number;
  acceptedTaskId: string;
}

function acceptRetrieve(text = 'Find all current alpha records.'): RetrieveTask {
  const session = eventlog.createSession({ id: `retrieve-parity-${++serial}`, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text },
  });
  assert.ok(shadow.recordTurnGraphShadow({
    identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 },
  }));
  const fixed = contracts.freezeDeterministicExpectedWorkContract({
    sessionId: session.id,
    sourceUserSeq: source.seq,
  });
  assert.ok(fixed.status === 'fixed' || fixed.status === 'replayed', JSON.stringify(fixed));
  return {
    sessionId: session.id,
    sourceUserSeq: source.seq,
    turn: 1,
    acceptedTaskId: identities.acceptedTaskIdFor(session.id, source.seq),
  };
}

/** A provider-lane read: real dispatch, composio observer, provider payload. */
function settleProvider(task: RetrieveTask, tool: string, payload: unknown): void {
  const logicalToolCallId = `logical:retrieve-parity:${serial}`;
  const begun = dispatch.beginPhysicalDispatch({
    identity: {
      ...task,
      logicalToolCallId,
      physicalDispatchId: `dispatch:retrieve-parity:${serial}`,
      ordinal: 0,
    },
    tool,
    args: { query: 'alpha' },
  });
  assert.equal(begun.status, 'inserted', JSON.stringify(begun));
  if (begun.status !== 'inserted') throw new Error(begun.reason);
  assert.equal(dispatch.settlePhysicalDispatch({
    identity: begun.identity,
    tool,
    outcome: 'returned',
  }).status, 'inserted');
  const settled = settlements.commitLogicalCallSettlement({
    identity: { ...task, logicalToolCallId },
    contract: { toolName: tool, args: { query: 'alpha' } },
    execution: { kind: 'provider_execution' },
    result: { payload },
    outcome: outcomes.classifyAttemptOutcome({ envelopeSuccessful: true }),
    recovery: { businessCall: true, mutating: false },
    observer: { lane: 'composio', turn: task.turn },
  });
  assert.equal(settled.status, 'committed', JSON.stringify(settled));
}

/** A local-lane carrier: unbound agents_runner execution, exactly as chat runs it. */
function settleLocalCarrier(task: RetrieveTask, tool: string, args: unknown, result: unknown): void {
  const logicalToolCallId = `logical:retrieve-parity:${serial}:local`;
  assert.equal(dispatch.admitLogicalCall({
    identity: { ...task, logicalToolCallId },
    tool,
    args,
  }).status, 'inserted');
  const settled = attempts.settleToolAttempt({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    turn: task.turn,
    lane: 'agents_runner',
    toolName: tool,
    callId: logicalToolCallId,
    args,
    mutating: false,
    businessCall: true,
    result,
  });
  assert.equal(settled.outcome.kind, 'succeeded', JSON.stringify(settled.outcome));
}

/** The whole gauntlet: preparation must be ready/done, publication must close. */
function assertPublishesDone(task: RetrieveTask, carrier: string): void {
  const prepared = preparation.prepareAcceptedTaskTerminal({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    proposedReply: 'Here is what I found.',
  });
  assert.equal(prepared.status, 'ready', `${carrier}: ${JSON.stringify(prepared)}`);
  assert.equal(prepared.status === 'ready' && prepared.verdict.status, 'done', carrier);
  const identity = {
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    turn: task.turn,
  };
  const outcome: import('./turn-outcome.js').TurnOutcome = {
    version: 2,
    id: turnOutcomes.turnOutcomeId(identity),
    identity,
    status: 'done',
    resumable: false,
    presentation: { kind: 'answer', text: 'Here is what I found.' },
  };
  const appended = eventlog.appendTerminalEventOnce({
    sessionId: task.sessionId,
    turn: task.turn,
    role: 'system',
    data: delivery.completionDataForTurnOutcome(outcome),
  }, outcome.id);
  assert.ok(appended.inserted, `${carrier}: terminal did not publish`);
  const closed = authority.loadAcceptedTaskAuthority(task.sessionId, task.sourceUserSeq);
  assert.equal(
    closed.status === 'ok' && closed.authority.state,
    'terminal',
    `${carrier}: accepted-task authority did not close`,
  );
}

test('carrier parity: a memory answer with zero tool calls publishes done', () => {
  // No freshness keywords: recall alone may ground this ask, exactly as it
  // did before the retrieve contract existed. The frozen once-read bounds
  // what work MAY count; it never mandates that work occur.
  const task = acceptRetrieve('Find the alpha records we keep on file.');
  assertPublishesDone(task, 'memory (zero tool calls)');
});

test('carrier parity: a current-state ask with zero reads holds, and stays repairable', () => {
  // The honesty floor is carrier-neutral in the other direction too: an
  // answer claiming CURRENT state without any successful read this turn may
  // not publish — and the hold must leave the resolution open so a later
  // read can repair the same task instead of conflicting with a closed
  // zero-operation resolution.
  const task = acceptRetrieve('Find all current alpha records.');
  const held = preparation.prepareAcceptedTaskTerminal({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    proposedReply: 'Your current alpha records are A and B.',
  });
  assert.equal(held.status, 'needs_verification', JSON.stringify(held));

  settleProvider(task, 'alpha_records_search', {
    successful: true,
    data: { records: [{ id: 'alpha-1' }] },
    meta: { complete: true },
  });
  assertPublishesDone(task, 'current-state ask repaired by a later read');
});

test('carrier parity: a provider point read publishes done', () => {
  const task = acceptRetrieve();
  settleProvider(task, 'alpha_record_lookup_byid', {
    successful: true,
    data: { record: { id: 'alpha-1', name: 'Alpha One' } },
  });
  assertPublishesDone(task, 'provider point read');
});

test('carrier parity: a provider collection read with a provable end publishes done', () => {
  const task = acceptRetrieve();
  settleProvider(task, 'alpha_records_search', {
    successful: true,
    data: { records: [{ id: 'alpha-1' }, { id: 'alpha-2' }] },
    meta: { complete: true },
  });
  assertPublishesDone(task, 'provider collection read (complete)');
});

test('carrier parity: a provider collection read with no completeness signal publishes done', () => {
  // The 2026-08-12 calendar incident carrier: bounded view, every record
  // returned, no cursor, completeness unknown — nothing more the provider
  // can say.
  const task = acceptRetrieve();
  settleProvider(task, 'alpha_records_list_view', {
    successful: true,
    data: { records: [{ id: 'evt-1' }, { id: 'evt-2' }] },
  });
  assertPublishesDone(task, 'provider collection read (unknown completeness)');
});

test('carrier parity: a read-only CLI through the shell publishes done', () => {
  // The 2026-08-11 Salesforce incident carrier: an unbound local compute
  // execution whose payload is the answer.
  const task = acceptRetrieve();
  settleLocalCarrier(
    task,
    'run_shell_command',
    { command: 'alpha-cli records list --json' },
    JSON.stringify({ records: [{ id: 'alpha-1' }, { id: 'alpha-2' }] }),
  );
  assertPublishesDone(task, 'shell CLI (compute)');
});

test('carrier parity: a local file read publishes done', () => {
  const task = acceptRetrieve();
  settleLocalCarrier(
    task,
    'read_file',
    { path: 'alpha-records.json' },
    JSON.stringify([{ id: 'alpha-1' }, { id: 'alpha-2' }]),
  );
  assertPublishesDone(task, 'local file read');
});

test('carrier parity: an outstanding provider cursor still refuses on every carrier that can carry one', () => {
  // The honesty floor is carrier-neutral too: a read that KNOWS it stopped
  // early can never publish done, however it was transported.
  const task = acceptRetrieve();
  settleProvider(task, 'alpha_records_search', {
    successful: true,
    data: { records: [{ id: 'alpha-1' }] },
    next_cursor: 'page-2',
  });
  const prepared = preparation.prepareAcceptedTaskTerminal({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    proposedReply: 'Here is what I found.',
  });
  assert.equal(prepared.status, 'needs_verification', JSON.stringify(prepared));

  const local = acceptRetrieve();
  settleLocalCarrier(
    local,
    'read_file',
    { path: 'alpha-records.json' },
    { records: [{ id: 'alpha-1' }], next_cursor: 'page-2' },
  );
  const localPrepared = preparation.prepareAcceptedTaskTerminal({
    sessionId: local.sessionId,
    sourceUserSeq: local.sourceUserSeq,
    proposedReply: 'Here is what I found.',
  });
  assert.equal(localPrepared.status, 'needs_verification', JSON.stringify(localPrepared));
});
