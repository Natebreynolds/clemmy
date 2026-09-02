/**
 * Run: npx tsx --test src/runtime/harness/delivery-committer-effect-truth.red.test.ts
 *
 * Terminal copy derives from the WRITE LEDGER's effect-truth, never from
 * tool-shape heuristics.
 *
 * Measured live (gauntlet 2026-08-26): all 12 blocked terminals told the user
 * "The tool stopped after execution may have begun… its effect must be
 * reconciled before continuing" about HOST-ONLY meta-tools (plan_task,
 * tool_search) — while physical_dispatches held ZERO non-host rows for those
 * sessions (sess-desktop-5bcd…: 98 dispatches, 0 external; sess-desktop-8823…:
 * 4, 0 external). The phantom uncertainty then poisoned later turns
 * cross-brain (S6: codex refused writes citing "the earlier uncertain sheet
 * operation") and user correction could not clear it.
 *
 * The law: a turn with zero external dispatches may never claim possible
 * external execution. The committer is the single durable delivery boundary,
 * so honesty is enforced here — and a turn WITH a genuinely unresolved
 * external write keeps the reconciliation-required copy (direction pin).
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-committer-effect-truth-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-effect-truth\n', 'utf8');

const { appendEvent, createSession, listEvents, closeEventLog } = await import('./eventlog.js');
const {
  commitTurnOutcome,
  HOST_LOCAL_FAILURE_BLOCKED_TEXT,
} = await import('./delivery-committer.js');
const { turnOutcomeId } = await import('./turn-outcome.js');
const { publicCompletionText, projectHarnessEventsForPublic } = await import('./public-presentation.js');
const { HOST_TOOL_UNCERTAIN_BLOCKED_TEXT } = await import('./host-turn-runner.js');
const shadow = await import('../graph/turn-graph-shadow.js');
const identityModule = await import('./attempt-identity.js');
const dispatch = await import('./dispatch-ledger.js');
type TurnOutcome = import('./turn-outcome.js').TurnOutcome;

test.after(() => {
  closeEventLog();
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

function acceptedSource(sessionId: string) {
  createSession({ id: sessionId, kind: 'chat', title: 'effect truth' });
  const source = appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Create the sheet and add one row.' },
  });
  assert.ok(shadow.recordTurnGraphShadow({
    identity: { sessionId, sourceUserSeq: source.seq, turn: 1 },
  }));
  return {
    sessionId,
    sourceUserSeq: source.seq,
    turn: source.turn,
    acceptedTaskId: identityModule.acceptedTaskIdFor(sessionId, source.seq),
  };
}

function uncertainBlockedOutcome(source: ReturnType<typeof acceptedSource>): TurnOutcome {
  const identity = { sessionId: source.sessionId, turn: source.turn, sourceUserSeq: source.sourceUserSeq };
  return {
    version: 2,
    id: turnOutcomeId(identity),
    identity,
    status: 'blocked',
    resumable: false,
    presentation: { kind: 'blocked', text: HOST_TOOL_UNCERTAIN_BLOCKED_TEXT },
  };
}

function committedText(sessionId: string): string {
  const all = listEvents(sessionId, { limit: 200 });
  const terminals = projectHarnessEventsForPublic(all)
    .filter((event) => event.type === 'conversation_completed');
  assert.equal(terminals.length, 1);
  return publicCompletionText(terminals[0]!.data as Record<string, unknown>, '');
}

test('a zero-external-dispatch turn can never render the may-have-begun copy', () => {
  const source = acceptedSource('sess-effect-truth-host-only');
  // Only a HOST crossing exists — exactly the live plan_task shape.
  const started = dispatch.beginPhysicalDispatch({
    identity: {
      sessionId: source.sessionId,
      sourceUserSeq: source.sourceUserSeq,
      acceptedTaskId: source.acceptedTaskId,
      logicalToolCallId: 'logical:plan-task-1',
      physicalDispatchId: 'dispatch:host:logical:plan-task-1',
      ordinal: 1,
    },
    tool: 'plan_task',
    args: { preamble: 'On it.' },
    relation: 'primary',
    executionSite: 'host',
  });
  assert.equal(started.status, 'inserted');
  if (started.status !== 'inserted') throw new Error('host crossing not admitted');
  assert.equal(dispatch.settlePhysicalDispatch({
    identity: started.identity,
    tool: 'plan_task',
    outcome: 'returned',
  }).status, 'inserted');

  commitTurnOutcome(uncertainBlockedOutcome(source));
  const text = committedText(source.sessionId);
  assert.doesNotMatch(text, /may have begun/i,
    'zero external dispatches in the ledger: possible external execution may not be claimed');
  assert.doesNotMatch(text, /must be reconciled/i,
    'with nothing external in flight there is nothing to reconcile — the door this copy locks does not exist');
  assert.match(text, /what I already gathered is kept|retained results remain preserved/i,
    'the honest terminal preserves prior work instead of denying that an earlier read ran');
  assert.match(text, /nothing was sent or changed|no uncertain external change is pending/i,
    'the terminal states only the ledger fact it can prove about the failed step');
  assert.equal(text, HOST_LOCAL_FAILURE_BLOCKED_TEXT,
    'the residual terminal is one bounded factual host error, not a recovery instruction');
  assert.doesNotMatch(text, /ask me|continue|retry|checkpoint|resume/i,
    'a terminal with no retained recovery owner must not solicit user lifting or promise a retry');
});

test('a turn with a genuinely unresolved external write keeps the reconciliation copy', () => {
  const source = acceptedSource('sess-effect-truth-uncertain-write');
  // A provider crossing whose fate is unknown — the one case the copy is FOR.
  const started = dispatch.beginPhysicalDispatch({
    identity: {
      sessionId: source.sessionId,
      sourceUserSeq: source.sourceUserSeq,
      acceptedTaskId: source.acceptedTaskId,
      logicalToolCallId: 'logical:sheet-write-1',
      physicalDispatchId: 'dispatch:provider:logical:sheet-write-1',
      ordinal: 1,
    },
    tool: 'googlesheets_batch_update',
    args: { rows: [['a']] },
    relation: 'primary',
  });
  assert.equal(started.status, 'inserted');
  if (started.status !== 'inserted') throw new Error('provider crossing not admitted');
  assert.equal(dispatch.settlePhysicalDispatch({
    identity: started.identity,
    tool: 'googlesheets_batch_update',
    outcome: 'unknown',
  }).status, 'inserted');

  commitTurnOutcome(uncertainBlockedOutcome(source));
  const text = committedText(source.sessionId);
  assert.match(text, /reconcil/i,
    'a real unresolved external write keeps the reconciliation-required terminal');
});
