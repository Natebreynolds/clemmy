/**
 * RED — accepted-source terminal truth must follow durable work identity.
 *
 * Run:
 *   npx tsx --test src/runtime/harness/accepted-source-settlement-reconciliation.red.test.ts
 *
 * A user-input boundary is not a work-identity boundary. An exact write can be
 * reconciled by a later accepted source, and an empty later source is not proof
 * that an earlier failed business call recovered.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-source-settlement-reconcile-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-source-settlement\n', 'utf8');

const eventlog = await import('./eventlog.js');
const { auditAcceptedSourceSettlementTruth } = await import('./accepted-source-settlement-audit.js');
const { auditWorkflowRunSettlementTruth } = await import('../../execution/workflow-runner.js');
const identities = await import('./attempt-identity.js');
const dispatch = await import('./dispatch-ledger.js');
const outcomes = await import('./attempt-outcome.js');
const settlements = await import('./logical-call-settlement-store.js');
const shadow = await import('../graph/turn-graph-shadow.js');
const { resolveWriteEvidence } = await import('./work-report.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

test('an exact later reconciliation clears the prior accepted source write reservation', () => {
  const sessionId = 'workflow:cross-source-write:send_update';
  eventlog.createSession({ id: sessionId, kind: 'workflow' });
  const source = eventlog.appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Send the update.' },
  });
  eventlog.appendEvent({
    sessionId,
    turn: 1,
    role: 'system',
    type: 'external_write',
    data: {
      shapeKey: 'SEND_EMAIL',
      preDispatch: true,
      canonicalCallId: 'call-cross-source-1',
      targets: ['casey@example.com'],
    },
  });
  eventlog.appendEvent({
    sessionId,
    turn: 2,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Reconcile the prior send.' },
  });
  eventlog.appendEvent({
    sessionId,
    turn: 2,
    role: 'system',
    type: 'external_write_succeeded',
    data: {
      shapeKey: 'SEND_EMAIL',
      canonicalCallId: 'call-cross-source-1',
      targets: ['casey@example.com'],
    },
  });

  const completeLedger = resolveWriteEvidence(eventlog.listEvents(sessionId, { limit: 100 }));
  assert.deepEqual(
    { confirmed: completeLedger.confirmed.length, uncertain: completeLedger.uncertain.length },
    { confirmed: 1, uncertain: 0 },
    'fixture precondition: the complete durable write ledger reconciles the exact call',
  );

  const audit = auditAcceptedSourceSettlementTruth({
    sessionId,
    sourceUserSeq: source.seq,
  });
  assert.equal(
    audit.status,
    'clean',
    'the accepted-source audit stopped at the next user event and permanently lost the exact later write reconciliation',
  );
  assert.equal(audit.facts.confirmedWrites, 1);
  assert.equal(audit.facts.uncertainWrites, 0);
});

test('a later accepted source with no business evidence cannot erase an older ordinary failure', () => {
  const runId = 'empty-retry-does-not-recover';
  const sessionId = `workflow:${runId}:read_records`;
  eventlog.createSession({ id: sessionId, kind: 'workflow' });
  const failedSource = eventlog.appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Read the records.' },
  });
  assert.ok(shadow.recordTurnGraphShadow({
    identity: { sessionId, turn: failedSource.turn, sourceUserSeq: failedSource.seq },
  }));
  const acceptedTaskId = identities.acceptedTaskIdFor(sessionId, failedSource.seq);
  const begun = dispatch.beginPhysicalDispatch({
    identity: {
      sessionId,
      sourceUserSeq: failedSource.seq,
      turn: failedSource.turn,
      acceptedTaskId,
      logicalToolCallId: 'logical:failed-read',
      physicalDispatchId: 'dispatch:failed-read',
      ordinal: 0,
    },
    tool: 'alpha_records_read',
    args: { id: 'alpha-1' },
  });
  assert.equal(begun.status, 'inserted');
  if (begun.status !== 'inserted') throw new Error('fixture dispatch was not admitted');
  assert.equal(dispatch.settlePhysicalDispatch({
    identity: begun.identity,
    tool: 'alpha_records_read',
    outcome: 'returned',
  }).status, 'inserted');
  assert.equal(settlements.commitLogicalCallSettlement({
    identity: {
      sessionId,
      sourceUserSeq: failedSource.seq,
      turn: failedSource.turn,
      acceptedTaskId,
      logicalToolCallId: 'logical:failed-read',
    },
    contract: { toolName: 'alpha_records_read', args: { id: 'alpha-1' } },
    execution: { kind: 'provider_execution' },
    result: { payload: { successful: false, error: 'not supported' } },
    outcome: outcomes.classifyAttemptOutcome({ httpStatus: 501 }),
    recovery: { businessCall: true, mutating: false },
    observer: { lane: 'composio', turn: failedSource.turn },
  }).status, 'committed');

  const emptyRetry = eventlog.appendEvent({
    sessionId,
    turn: 2,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Try again.' },
  });
  assert.equal(
    auditAcceptedSourceSettlementTruth({ sessionId, sourceUserSeq: emptyRetry.seq }).facts.successfulBusinessSettlements,
    0,
    'fixture precondition: the later source did no business work',
  );

  const audit = auditWorkflowRunSettlementTruth(runId);
  assert.equal(
    audit.clean,
    false,
    'the run audit treated mere chronology as recovery: an empty later source hid the earlier failed business call',
  );
  assert.ok(audit.reasons.some((reason) => /failure/i.test(reason)), JSON.stringify(audit));
});

test('a worked-around read failure does not block a source that completed other work', () => {
  // Live 2026-08-12: a Slack team-activity workflow that had run for days
  // began blocking. 12 Salesforce queries, 9 returned the data, 3 were
  // malformed SOQL. Recovery identity is the EXACT call, so getting the same
  // facts from a differently-shaped query never registered as recovery, and
  // the run refused to post anything. Exploration means some shapes fail.
  const runId = 'worked-around-read-failure';
  const sessionId = `workflow:${runId}:pull_activity`;
  eventlog.createSession({ id: sessionId, kind: 'workflow' });
  const source = eventlog.appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Pull the team activity.' },
  });
  assert.ok(shadow.recordTurnGraphShadow({
    identity: { sessionId, turn: source.turn, sourceUserSeq: source.seq },
  }));
  const acceptedTaskId = identities.acceptedTaskIdFor(sessionId, source.seq);

  const settleQuery = (id: string, query: string, ok: boolean) => {
    const begun = dispatch.beginPhysicalDispatch({
      identity: {
        sessionId,
        sourceUserSeq: source.seq,
        turn: source.turn,
        acceptedTaskId,
        logicalToolCallId: `logical:${id}`,
        physicalDispatchId: `dispatch:${id}`,
        ordinal: 0,
      },
      tool: 'alpha_records_read',
      args: { query },
    });
    assert.equal(begun.status, 'inserted');
    if (begun.status !== 'inserted') throw new Error('fixture dispatch was not admitted');
    assert.equal(dispatch.settlePhysicalDispatch({
      identity: begun.identity,
      tool: 'alpha_records_read',
      outcome: 'returned',
    }).status, 'inserted');
    settlements.commitLogicalCallSettlement({
      identity: {
        sessionId,
        sourceUserSeq: source.seq,
        turn: source.turn,
        acceptedTaskId,
        logicalToolCallId: `logical:${id}`,
      },
      contract: { toolName: 'alpha_records_read', args: { query } },
      execution: { kind: 'provider_execution' },
      ...(ok ? { result: { payload: { successful: true, data: { records: [{ id: 'a' }] } } } } : {}),
      outcome: ok
        ? outcomes.classifyAttemptOutcome({ envelopeSuccessful: true })
        : outcomes.classifyAttemptOutcome({ executionFailed: true }),
      recovery: { businessCall: true, mutating: false },
      observer: { lane: 'agents_runner', turn: source.turn },
    });
  };

  settleQuery('good-1', 'SELECT Id FROM Task', true);
  settleQuery('good-2', 'SELECT Id FROM Event', true);
  settleQuery('malformed-1', 'SELECT Owner.Name ownerName FROM Event', false);

  const audit = auditAcceptedSourceSettlementTruth({ sessionId, sourceUserSeq: source.seq });
  assert.equal(
    audit.status,
    'clean',
    `a differently-shaped retry is recovery in substance: ${JSON.stringify(audit)}`,
  );
  assert.equal(audit.facts.unrecoveredBusinessFailures, 0);
});

// ── A reversible ambiguous write is a disclosure, not a veto ────────────────
//
// Live (2026-08-12): a business-hours Slack review read every channel, updated
// its tracking sheet, and finished. One GOOGLESHEETS_INSERT_DIMENSION returned
// HTTP 400 invalid_arguments — which parks as ambiguous, because a provider may
// commit before returning a 4xx — and the model then repaired the arguments and
// inserted successfully. That reversible ambiguity still vetoed the terminal, so
// the user received none of the review. Both directions are pinned here: a
// reversible ambiguity is reported and passes; an irreversible or unclassified
// one still blocks.

function ambiguousWriteFixture(input: {
  sessionId: string;
  shapeKey: string;
  callId: string;
  irreversible?: boolean;
}): number {
  eventlog.createSession({ id: input.sessionId, kind: 'workflow' });
  const source = eventlog.appendEvent({
    sessionId: input.sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Review the channels and update the sheet.' },
  });
  eventlog.appendEvent({
    sessionId: input.sessionId,
    turn: 1,
    role: 'system',
    type: 'external_write',
    data: {
      shapeKey: input.shapeKey,
      preDispatch: true,
      canonicalCallId: input.callId,
      targets: ['sheet-1'],
      ...(input.irreversible === undefined ? {} : { irreversible: input.irreversible }),
    },
  });
  eventlog.appendEvent({
    sessionId: input.sessionId,
    turn: 1,
    role: 'system',
    type: 'external_write_orphaned',
    data: {
      shapeKey: input.shapeKey,
      canonicalCallId: input.callId,
      targets: ['sheet-1'],
      ...(input.irreversible === undefined ? {} : { irreversible: input.irreversible }),
      reason: '[provider-dispatch:uncertain] provider returned HTTP 400 after dispatch',
    },
  });
  return source.seq;
}

test('an ambiguous REVERSIBLE write is reported but does not veto the terminal', () => {
  const sessionId = 'workflow:reversible-ambiguous-write:main';
  const seq = ambiguousWriteFixture({
    sessionId,
    shapeKey: 'GOOGLESHEETS_INSERT_DIMENSION',
    callId: 'call-reversible-ambiguous',
    irreversible: false,
  });

  const audit = auditAcceptedSourceSettlementTruth({ sessionId, sourceUserSeq: seq });
  assert.notEqual(
    audit.status,
    'uncertain_write',
    `a reversible ambiguity withheld an entire completed review: ${JSON.stringify(audit)}`,
  );
  assert.equal(
    audit.facts.uncertainWrites,
    1,
    'the ambiguity stays visible in the facts so the work report can disclose it',
  );
  assert.equal(audit.facts.blockingUncertainWrites, 0);
});

test('an ambiguous IRREVERSIBLE write still blocks the terminal', () => {
  const sessionId = 'workflow:irreversible-ambiguous-write:main';
  const seq = ambiguousWriteFixture({
    sessionId,
    shapeKey: 'GMAIL_SEND_EMAIL',
    callId: 'call-irreversible-ambiguous',
    irreversible: true,
  });

  const audit = auditAcceptedSourceSettlementTruth({ sessionId, sourceUserSeq: seq });
  assert.equal(
    audit.status,
    'uncertain_write',
    `a possibly-sent email must never be waved through: ${JSON.stringify(audit)}`,
  );
  assert.equal(audit.facts.blockingUncertainWrites, 1);
});

test('an ambiguous write the host could not classify fails closed', () => {
  const sessionId = 'workflow:unclassified-ambiguous-write:main';
  const seq = ambiguousWriteFixture({
    sessionId,
    shapeKey: 'SOME_UNKNOWN_ACTION',
    callId: 'call-unclassified-ambiguous',
  });

  const audit = auditAcceptedSourceSettlementTruth({ sessionId, sourceUserSeq: seq });
  assert.equal(
    audit.status,
    'uncertain_write',
    `absent a reversibility classification the audit must stay strict: ${JSON.stringify(audit)}`,
  );
  assert.equal(audit.facts.blockingUncertainWrites, 1);
});

// ── A repaired write is a recovered write ──────────────────────────────────
//
// Recovery identity is the exact argument digest, so correcting the arguments a
// provider rejected produces a DIFFERENT identity and never counts as recovery
// — which is precisely what repair does. Same live run (2026-08-12): the 400 on
// GOOGLESHEETS_INSERT_DIMENSION was repaired and the next insert into the same
// spreadsheet succeeded, and the audit still called the source unrecovered.
// Recovery requires a LATER success of the same shape on the same target, and
// only for a reversible effect.

function repairFixture(input: {
  sessionId: string;
  failed: { shapeKey: string; targets: string[]; irreversible: boolean };
  repaired: { shapeKey: string; targets: string[]; irreversible: boolean };
  repairFirst?: boolean;
}): number {
  eventlog.createSession({ id: input.sessionId, kind: 'workflow' });
  const source = eventlog.appendEvent({
    sessionId: input.sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Update the tracker.' },
  });
  const reserve = (callId: string, spec: { shapeKey: string; targets: string[]; irreversible: boolean }) => {
    eventlog.appendEvent({
      sessionId: input.sessionId,
      turn: 1,
      role: 'system',
      type: 'external_write',
      data: {
        shapeKey: spec.shapeKey,
        preDispatch: true,
        canonicalCallId: callId,
        targets: spec.targets,
        irreversible: spec.irreversible,
      },
    });
  };
  assert.ok(shadow.recordTurnGraphShadow({
    identity: { sessionId: input.sessionId, turn: source.turn, sourceUserSeq: source.seq },
  }));
  const acceptedTaskId = identities.acceptedTaskIdFor(input.sessionId, source.seq);
  const settle = (callId: string, tool: string, args: unknown, ok: boolean) => {
    const begun = dispatch.beginPhysicalDispatch({
      identity: {
        sessionId: input.sessionId,
        sourceUserSeq: source.seq,
        turn: source.turn,
        acceptedTaskId,
        logicalToolCallId: callId,
        physicalDispatchId: `dispatch:${callId}`,
        ordinal: 0,
      },
      tool,
      args,
    });
    assert.equal(begun.status, 'inserted');
    if (begun.status !== 'inserted') throw new Error('fixture dispatch was not admitted');
    assert.equal(dispatch.settlePhysicalDispatch({
      identity: begun.identity,
      tool,
      outcome: 'returned',
    }).status, 'inserted');
    settlements.commitLogicalCallSettlement({
      identity: {
        sessionId: input.sessionId,
        sourceUserSeq: source.seq,
        turn: source.turn,
        acceptedTaskId,
        logicalToolCallId: callId,
      },
      contract: { toolName: tool, args },
      execution: { kind: 'provider_execution' },
      ...(ok ? { result: { payload: { successful: true, data: { done: true } } } } : {}),
      outcome: ok
        ? outcomes.classifyAttemptOutcome({ envelopeSuccessful: true })
        : outcomes.classifyAttemptOutcome({ executionFailed: true }),
      recovery: { businessCall: true, mutating: true },
      observer: { lane: 'agents_runner', turn: source.turn },
    });
  };
  const tool = input.failed.shapeKey.toLowerCase();
  if (input.repairFirst) {
    reserve('call-repair', input.repaired);
    settle('call-repair', input.repaired.shapeKey.toLowerCase(), { row: 9 }, true);
    reserve('call-broken', input.failed);
    settle('call-broken', tool, { row: 'NaN' }, false);
  } else {
    reserve('call-broken', input.failed);
    settle('call-broken', tool, { row: 'NaN' }, false);
    reserve('call-repair', input.repaired);
    settle('call-repair', input.repaired.shapeKey.toLowerCase(), { row: 9 }, true);
  }
  return source.seq;
}

test('a repaired reversible write on the same target recovers the rejected one', () => {
  const sessionId = 'workflow:repaired-write-recovers:main';
  const seq = repairFixture({
    sessionId,
    failed: { shapeKey: 'GOOGLESHEETS_INSERT_DIMENSION', targets: ['sheet-1'], irreversible: false },
    repaired: { shapeKey: 'GOOGLESHEETS_INSERT_DIMENSION', targets: ['sheet-1'], irreversible: false },
  });
  const audit = auditAcceptedSourceSettlementTruth({ sessionId, sourceUserSeq: seq });
  assert.equal(
    audit.status,
    'clean',
    `repairing rejected arguments IS recovery: ${JSON.stringify(audit)}`,
  );
  assert.equal(audit.facts.unrecoveredBusinessFailures, 0);
});

test('a later success on a DIFFERENT target does not recover a rejected write', () => {
  const sessionId = 'workflow:repair-wrong-target:main';
  const seq = repairFixture({
    sessionId,
    failed: { shapeKey: 'GOOGLESHEETS_INSERT_DIMENSION', targets: ['sheet-1'], irreversible: false },
    repaired: { shapeKey: 'GOOGLESHEETS_INSERT_DIMENSION', targets: ['sheet-2'], irreversible: false },
  });
  const audit = auditAcceptedSourceSettlementTruth({ sessionId, sourceUserSeq: seq });
  assert.equal(
    audit.status,
    'unrecovered_failure',
    `writing to a different resource never repairs the first one: ${JSON.stringify(audit)}`,
  );
});

test('an IRREVERSIBLE rejected write is never repaired by a later same-shape send', () => {
  const sessionId = 'workflow:repair-irreversible:main';
  const seq = repairFixture({
    sessionId,
    failed: { shapeKey: 'GMAIL_SEND_EMAIL', targets: ['casey@example.com'], irreversible: true },
    repaired: { shapeKey: 'GMAIL_SEND_EMAIL', targets: ['casey@example.com'], irreversible: true },
  });
  const audit = auditAcceptedSourceSettlementTruth({ sessionId, sourceUserSeq: seq });
  // Two unresolved irreversible reservations also block as ambiguous, which is
  // its own correct gate. Pin the fact this test is about: repair never erased
  // the failure.
  assert.equal(
    audit.facts.unrecoveredBusinessFailures,
    1,
    `an irreversible send keeps the strict exact-argument rule: ${JSON.stringify(audit)}`,
  );
  assert.notEqual(audit.status, 'clean', JSON.stringify(audit));
});

test('an EARLIER success does not recover a write rejected after it', () => {
  const sessionId = 'workflow:repair-wrong-order:main';
  const seq = repairFixture({
    sessionId,
    failed: { shapeKey: 'GOOGLESHEETS_INSERT_DIMENSION', targets: ['sheet-1'], irreversible: false },
    repaired: { shapeKey: 'GOOGLESHEETS_INSERT_DIMENSION', targets: ['sheet-1'], irreversible: false },
    repairFirst: true,
  });
  const audit = auditAcceptedSourceSettlementTruth({ sessionId, sourceUserSeq: seq });
  assert.equal(
    audit.status,
    'unrecovered_failure',
    `chronology must never pass for recovery: ${JSON.stringify(audit)}`,
  );
});

// ── A call that never crossed cannot hold a source open ────────────────────
//
// Live 2026-08-12: a DENIED `composio_search_tools` (discovery budget
// exhausted — free, read-only, zero-crossing) left its logical call `open`
// because the permission callback returned `deny` after the provider had
// already opened it. One stranded row held the whole source `in_flight` and
// withheld a completed Apify pull and a created sheet. Genuinely running work
// still blocks: an open call WITH a crossing is real ambiguity.

function openCallFixture(sessionId: string, withCrossing: boolean): number {
  eventlog.createSession({ id: sessionId, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Pull the data and build the sheet.' },
  });
  assert.ok(shadow.recordTurnGraphShadow({
    identity: { sessionId, turn: source.turn, sourceUserSeq: source.seq },
  }));
  const acceptedTaskId = identities.acceptedTaskIdFor(sessionId, source.seq);
  const identity = {
    sessionId,
    sourceUserSeq: source.seq,
    turn: source.turn,
    acceptedTaskId,
    logicalToolCallId: 'logical:stranded',
  };
  // One real success so the source has a story other than the stranded call.
  const done = dispatch.beginPhysicalDispatch({
    identity: { ...identity, logicalToolCallId: 'logical:done', physicalDispatchId: 'dispatch:done', ordinal: 0 },
    tool: 'alpha_records_read',
    args: { query: 'SELECT Id FROM Task' },
  });
  assert.equal(done.status, 'inserted');
  if (done.status !== 'inserted') throw new Error('fixture dispatch was not admitted');
  assert.equal(dispatch.settlePhysicalDispatch({
    identity: done.identity, tool: 'alpha_records_read', outcome: 'returned',
  }).status, 'inserted');
  settlements.commitLogicalCallSettlement({
    identity: { ...identity, logicalToolCallId: 'logical:done' },
    contract: { toolName: 'alpha_records_read', args: { query: 'SELECT Id FROM Task' } },
    execution: { kind: 'provider_execution' },
    result: { payload: { successful: true, data: { records: [{ id: 'a' }] } } },
    outcome: outcomes.classifyAttemptOutcome({ envelopeSuccessful: true }),
    recovery: { businessCall: true, mutating: false },
    observer: { lane: 'agents_runner', turn: source.turn },
  });
  // The stranded call: opened by the carrier, then refused without settling.
  identities.withLogicalToolCall({
    sessionId,
    sourceUserSeq: source.seq,
    tool: 'composio_search_tools',
    args: { query: 'sheets' },
    logicalToolCallId: 'logical:stranded',
  }, () => { /* the permission callback denied and returned; nothing settled */ });
  if (withCrossing) {
    const begun = dispatch.beginPhysicalDispatch({
      identity: { ...identity, physicalDispatchId: 'dispatch:stranded', ordinal: 0 },
      tool: 'composio_search_tools',
      args: { query: 'sheets' },
    });
    assert.equal(begun.status, 'inserted');
    if (begun.status !== 'inserted') throw new Error('fixture dispatch was not admitted');
    assert.equal(dispatch.settlePhysicalDispatch({
      identity: begun.identity, tool: 'composio_search_tools', outcome: 'returned',
    }).status, 'inserted');
  }
  return source.seq;
}

test('a stranded open call that never dispatched does not hold the source in flight', () => {
  const sessionId = 'sess-stranded-zero-crossing';
  const seq = openCallFixture(sessionId, false);
  const audit = auditAcceptedSourceSettlementTruth({ sessionId, sourceUserSeq: seq });
  assert.notEqual(
    audit.status,
    'in_flight',
    `a refused call that never left the house is not work in progress: ${JSON.stringify(audit)}`,
  );
  assert.equal(audit.facts.openLogicalCalls, 0);
});

test('an open call that DID cross still holds the source in flight', () => {
  const sessionId = 'sess-stranded-with-crossing';
  const seq = openCallFixture(sessionId, true);
  const audit = auditAcceptedSourceSettlementTruth({ sessionId, sourceUserSeq: seq });
  assert.equal(
    audit.status,
    'in_flight',
    `something crossed and never settled — that is real ambiguity: ${JSON.stringify(audit)}`,
  );
  assert.equal(audit.facts.openLogicalCalls, 1);
});

// ── A refusal is not a failed effect ───────────────────────────────────────
//
// `refused_pre_dispatch` means the harness blocked the call before it crossed:
// no request sent, no external state moved, nothing to reconcile. Counting it
// as an unrecovered failure makes Clementine's own guardrails the reason she
// cannot report (live 2026-08-12: a pre-dispatch policy denial on
// GOOGLESHEETS_CREATE, followed immediately by the sheet being created through
// another carrier, still blocked the turn). A DISPATCHED failure still counts.

function refusalFixture(sessionId: string, refused: boolean): number {
  eventlog.createSession({ id: sessionId, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Create the sheet.' },
  });
  assert.ok(shadow.recordTurnGraphShadow({
    identity: { sessionId, turn: source.turn, sourceUserSeq: source.seq },
  }));
  const acceptedTaskId = identities.acceptedTaskIdFor(sessionId, source.seq);
  const base = { sessionId, sourceUserSeq: source.seq, turn: source.turn, acceptedTaskId };

  if (refused) {
    // The carrier opens the call, then the harness refuses it before dispatch.
    identities.withLogicalToolCall({
      sessionId,
      sourceUserSeq: source.seq,
      tool: 'googlesheets_create_google_sheet1',
      args: { title: 'A' },
      logicalToolCallId: 'logical:blocked',
    }, () => {
      settlements.commitLogicalCallSettlement({
        identity: { ...base, logicalToolCallId: 'logical:blocked' },
        contract: { toolName: 'googlesheets_create_google_sheet1', args: { title: 'A' } },
        execution: { kind: 'refused_pre_dispatch' },
        outcome: outcomes.classifyAttemptOutcome({ preDispatch: true, policyRefused: true }),
        recovery: { businessCall: true, mutating: true },
        observer: { lane: 'agents_runner', turn: source.turn },
      });
    });
  } else {
    const begun = dispatch.beginPhysicalDispatch({
      identity: { ...base, logicalToolCallId: 'logical:blocked', physicalDispatchId: 'dispatch:blocked', ordinal: 0 },
      tool: 'googlesheets_create_google_sheet1',
      args: { title: 'A' },
    });
    assert.equal(begun.status, 'inserted');
    if (begun.status !== 'inserted') throw new Error('fixture dispatch was not admitted');
    assert.equal(dispatch.settlePhysicalDispatch({
      identity: begun.identity, tool: 'googlesheets_create_google_sheet1', outcome: 'returned',
    }).status, 'inserted');
    settlements.commitLogicalCallSettlement({
      identity: { ...base, logicalToolCallId: 'logical:blocked' },
      contract: { toolName: 'googlesheets_create_google_sheet1', args: { title: 'A' } },
      execution: { kind: 'provider_execution' },
      outcome: outcomes.classifyAttemptOutcome({ executionFailed: true }),
      recovery: { businessCall: true, mutating: true },
      observer: { lane: 'agents_runner', turn: source.turn },
    });
  }
  // Other real work succeeded in the same source.
  const done = dispatch.beginPhysicalDispatch({
    identity: { ...base, logicalToolCallId: 'logical:ok', physicalDispatchId: 'dispatch:ok', ordinal: 0 },
    tool: 'alpha_records_read',
    args: { query: 'SELECT Id FROM Task' },
  });
  assert.equal(done.status, 'inserted');
  if (done.status !== 'inserted') throw new Error('fixture dispatch was not admitted');
  assert.equal(dispatch.settlePhysicalDispatch({
    identity: done.identity, tool: 'alpha_records_read', outcome: 'returned',
  }).status, 'inserted');
  settlements.commitLogicalCallSettlement({
    identity: { ...base, logicalToolCallId: 'logical:ok' },
    contract: { toolName: 'alpha_records_read', args: { query: 'SELECT Id FROM Task' } },
    execution: { kind: 'provider_execution' },
    result: { payload: { successful: true, data: { records: [{ id: 'a' }] } } },
    outcome: outcomes.classifyAttemptOutcome({ envelopeSuccessful: true }),
    recovery: { businessCall: true, mutating: false },
    observer: { lane: 'agents_runner', turn: source.turn },
  });
  return source.seq;
}

test('a pre-dispatch refusal is not an unrecovered failure', () => {
  const sessionId = 'sess-refused-pre-dispatch';
  const seq = refusalFixture(sessionId, true);
  const audit = auditAcceptedSourceSettlementTruth({ sessionId, sourceUserSeq: seq });
  assert.equal(
    audit.status,
    'clean',
    `a call the harness blocked before dispatch changed nothing outside: ${JSON.stringify(audit)}`,
  );
  assert.equal(audit.facts.unrecoveredBusinessFailures, 0);
});

test('a DISPATCHED write failure is still an unrecovered failure', () => {
  const sessionId = 'sess-dispatched-write-failure';
  const seq = refusalFixture(sessionId, false);
  const audit = auditAcceptedSourceSettlementTruth({ sessionId, sourceUserSeq: seq });
  assert.equal(
    audit.facts.unrecoveredBusinessFailures,
    1,
    `a write that crossed and failed still needs recovery: ${JSON.stringify(audit)}`,
  );
  assert.notEqual(audit.status, 'clean', JSON.stringify(audit));
});
