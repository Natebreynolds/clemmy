/**
 * The publish gate labels; it does not veto.
 *
 * Run: npx tsx --test src/runtime/harness/delivery-disclosure-gate.test.ts
 *
 * Roughly thirty independent conditions could each withhold a completed turn at
 * publish time, and on 2026-08-12 six consecutive live runs each finished their
 * real job and were each refused by a different one — none of which protected
 * the user from anything. The checks still run and still speak; they now speak
 * as a disclosure attached to the real answer.
 *
 * A judged turn has one hard floor: an ambiguous IRREVERSIBLE effect. When the
 * different-family judge is unavailable, the earlier conservative hold policy
 * remains as the safe fallback.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-delivery-disclosure-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-delivery-disclosure\n', 'utf8');

const eventlog = await import('./eventlog.js');
const shadow = await import('../graph/turn-graph-shadow.js');
const workManifest = await import('./work-manifest.js');
const dispatch = await import('./dispatch-ledger.js');
const outcomes = await import('./attempt-outcome.js');
const settlements = await import('./logical-call-settlement-store.js');
const preparation = await import('./accepted-task-terminal-preparation.js');
const audit = await import('./accepted-source-settlement-audit.js');
const { commitTurnOutcome, deliveryMustHoldForHuman } = await import('./delivery-committer.js');
const { turnOutcomeId } = await import('./turn-outcome.js');
type TurnOutcome = import('./turn-outcome.js').TurnOutcome;

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

let serial = 0;

/** A workflow-controller step source: no action expected-work wall, so the
 * fixture can settle real business calls the way the live lane does. */
function acceptStepSource(text: string) {
  serial += 1;
  const sessionId = `workflow:disclosure-run-${serial}:main`;
  eventlog.createSession({ id: sessionId, kind: 'workflow', title: `step ${serial}` });
  const source = eventlog.appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text },
  });
  assert.ok(shadow.recordTurnGraphShadow({
    identity: { sessionId, sourceUserSeq: source.seq, turn: 1 },
    surface: 'workflow',
  }));
  return { sessionId, sourceUserSeq: source.seq, turn: 1 };
}
const acceptActivatedAction = acceptStepSource;

/** A MUTATING business call that crossed and failed: an unrecovered failure,
 * which is a verification refusal but not a reason to withhold everything. */
function settleFailedWrite(task: ReturnType<typeof acceptStepSource>, label: string): void {
  const identity = {
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    turn: task.turn,
    acceptedTaskId: `task:${task.sessionId}#${task.sourceUserSeq}`,
    logicalToolCallId: `logical:${label}`,
  };
  const begun = dispatch.beginPhysicalDispatch({
    identity: { ...identity, physicalDispatchId: `dispatch:${label}`, ordinal: 0 },
    tool: 'googlesheets_insert_dimension',
    args: { index: 9 },
  });
  assert.equal(begun.status, 'inserted', `fixture precondition: ${JSON.stringify(begun)}`);
  if (begun.status !== 'inserted') return;
  assert.equal(dispatch.settlePhysicalDispatch({
    identity: begun.identity,
    tool: 'googlesheets_insert_dimension',
    outcome: 'returned',
  }).status, 'inserted');
  const settled = settlements.commitLogicalCallSettlement({
    identity,
    contract: { toolName: 'googlesheets_insert_dimension', args: { index: 9 } },
    execution: { kind: 'provider_execution' },
    outcome: outcomes.classifyAttemptOutcome({ executionFailed: true }),
    recovery: { businessCall: true, mutating: true },
    observer: { lane: 'composio', turn: task.turn },
  });
  assert.equal(settled.status, 'committed', `fixture precondition: ${JSON.stringify(settled)}`);
}

/** One real, durably settled, SUCCESSFUL business call. */
function settleSucceededBusinessCall(
  task: ReturnType<typeof acceptActivatedAction>,
  label: string,
): void {
  const identity = {
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    turn: task.turn,
    acceptedTaskId: `task:${task.sessionId}#${task.sourceUserSeq}`,
    logicalToolCallId: `logical:${label}`,
  };
  const begun = dispatch.beginPhysicalDispatch({
    identity: { ...identity, physicalDispatchId: `dispatch:${label}`, ordinal: 0 },
    tool: 'googlesheets_batch_get',
    args: { ranges: ['A1:C5'] },
  });
  assert.equal(begun.status, 'inserted', `fixture precondition: ${JSON.stringify(begun)}`);
  if (begun.status !== 'inserted') return;
  assert.equal(dispatch.settlePhysicalDispatch({
    identity: begun.identity,
    tool: 'googlesheets_batch_get',
    outcome: 'returned',
  }).status, 'inserted');
  const settled = settlements.commitLogicalCallSettlement({
    identity,
    contract: { toolName: 'googlesheets_batch_get', args: { ranges: ['A1:C5'] } },
    execution: { kind: 'provider_execution' },
    result: { payload: { successful: true, data: { valueRanges: [{ values: [['a']] }] } } },
    outcome: outcomes.classifyAttemptOutcome({ envelopeSuccessful: true }),
    recovery: { businessCall: true, mutating: false },
    observer: { lane: 'composio', turn: task.turn },
  });
  assert.equal(settled.status, 'committed', `fixture precondition: ${JSON.stringify(settled)}`);
}

/** An IRREVERSIBLE effect whose outcome nobody can prove. */
function reserveAmbiguousIrreversibleSend(task: ReturnType<typeof acceptActivatedAction>): void {
  for (const type of ['external_write', 'external_write_orphaned'] as const) {
    eventlog.appendEvent({
      sessionId: task.sessionId,
      turn: task.turn,
      role: 'system',
      type,
      data: {
        shapeKey: 'GMAIL_SEND_EMAIL',
        canonicalCallId: 'call-ambiguous-send',
        targets: ['alex@example.com'],
        irreversible: true,
        ...(type === 'external_write' ? { preDispatch: true } : {}),
      },
    });
  }
}

function doneOutcome(task: ReturnType<typeof acceptActivatedAction>, text: string): TurnOutcome {
  const identity = { sessionId: task.sessionId, turn: task.turn, sourceUserSeq: task.sourceUserSeq };
  return {
    version: 2,
    id: turnOutcomeId(identity),
    identity,
    status: 'done',
    resumable: false,
    presentation: { kind: 'answer', text },
  };
}

const ANSWER = 'Updated the tracker with all five rows.';

test('an unverified completion alongside real work publishes the answer with a disclosure', () => {
  const task = acceptStepSource('Update the tracker with the five rows.');
  settleSucceededBusinessCall(task, 'ok-read');
  settleFailedWrite(task, 'failed-insert');

  // FIXTURE PROOF — the terminal gate genuinely refuses this done, and real
  // work succeeded underneath it: exactly the shape that used to withhold
  // everything.
  const settlementAudit = audit.auditAcceptedSourceSettlementTruth({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
  });
  assert.equal(settlementAudit.status, 'unrecovered_failure', JSON.stringify(settlementAudit));
  assert.ok(settlementAudit.facts.successfulBusinessSettlements > 0, JSON.stringify(settlementAudit));

  const committed = commitTurnOutcome(doneOutcome(task, ANSWER));

  assert.equal(
    committed.presentation.status,
    'done',
    `a reversible verification gap withheld a completed turn: ${JSON.stringify(committed.presentation)}`,
  );
  assert.ok(
    committed.presentation.text.includes(ANSWER),
    'the user must still receive the real answer',
  );
  assert.equal(
    committed.presentation.text,
    ANSWER,
    'the synchronous committer labels the limit in metadata; it never writes in Clementine\'s voice',
  );
  assert.equal(committed.event.data.deliveryDisclosure, 'unverified_completion');
});

test('an ambiguous IRREVERSIBLE effect still holds for a human', () => {
  const task = acceptActivatedAction('Update the tracker and email Alex.');
  settleSucceededBusinessCall(task, 'irreversible-case');
  reserveAmbiguousIrreversibleSend(task);

  const settlementAudit = audit.auditAcceptedSourceSettlementTruth({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
  });
  assert.equal(settlementAudit.status, 'uncertain_write', JSON.stringify(settlementAudit));

  const committed = commitTurnOutcome(doneOutcome(task, 'Updated the tracker and emailed Alex.'));
  assert.equal(
    committed.presentation.status,
    'blocked',
    `an email that may or may not have sent is exactly what a human must check: ${JSON.stringify(committed.presentation)}`,
  );
});

test('a source where nothing succeeded holds rather than publishing a bare claim', () => {
  const task = acceptStepSource('Update the tracker with the five rows.');
  settleFailedWrite(task, 'only-failure');

  const settlementAudit = audit.auditAcceptedSourceSettlementTruth({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
  });
  assert.equal(settlementAudit.facts.successfulBusinessSettlements, 0, JSON.stringify(settlementAudit));

  const committed = commitTurnOutcome(doneOutcome(task, ANSWER));
  assert.equal(
    committed.presentation.status,
    'blocked',
    `judge-unavailable fallback must preserve today's safe behavior: ${JSON.stringify(committed.presentation)}`,
  );
});

test('a different-family DELIVER verdict removes the zero-success hard-coded veto', () => {
  const task = acceptStepSource('Try the requested update and report the result.');
  settleFailedWrite(task, 'judge-deliver-failure');
  const settlementAudit = audit.auditAcceptedSourceSettlementTruth({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
  });
  assert.equal(settlementAudit.facts.successfulBusinessSettlements, 0, JSON.stringify(settlementAudit));
  assert.equal(
    deliveryMustHoldForHuman(settlementAudit),
    false,
    'code—not the judge—may hard-hold only an unprovable irreversible effect',
  );

  const authored = 'The update did not land: the provider rejected the request before I could verify a changed record.';
  const committed = commitTurnOutcome(doneOutcome(task, authored), {
    terminalJudgeDisposition: 'deliver',
    presentationAlreadyDiscloses: true,
    metadata: {
      terminalJudgeDisposition: 'deliver',
      terminalJudgeReason: 'the failed attempt is final and there is no safe retry needed',
    },
  });
  assert.equal(committed.presentation.status, 'done');
  assert.equal(committed.presentation.text, authored, 'the judge authors the user-visible account');
  assert.equal(committed.event.data.terminalJudgeDisposition, 'deliver');
});
