/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/settlement-audit-platform-plane.test.ts
 *
 * An uncertain mutation remains consequential even when its name belongs to a
 * provider platform namespace. Connection/control operations can change
 * credentials and routing, and real business actions also use `composio_*`
 * names. Only refused_pre_dispatch proves no effect crossed the boundary.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-settlement-audit-platform-plane-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-settlement-plane\n', 'utf8');

const eventlog = await import('./eventlog.js');
const { auditAcceptedSourceSettlementTruth } = await import('./accepted-source-settlement-audit.js');
const { resolveWriteEvidence } = await import('./work-report.js');
const identities = await import('./attempt-identity.js');
const dispatch = await import('./dispatch-ledger.js');
const outcomes = await import('./attempt-outcome.js');
const settlements = await import('./logical-call-settlement-store.js');
const shadow = await import('../graph/turn-graph-shadow.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

interface Accepted { sessionId: string; sourceUserSeq: number; turn: number; acceptedTaskId: string }

function acceptedSource(sessionId: string, text: string): Accepted {
  // Settlement classification is the subject of this fixture. Use the host
  // chat engine so its expected-work binder is present; a binderless workflow
  // must now refuse before any physical row and is pinned separately.
  eventlog.createSession({ id: sessionId, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text },
  });
  assert.ok(shadow.recordTurnGraphShadow({
    identity: { sessionId, turn: source.turn, sourceUserSeq: source.seq },
  }));
  return {
    sessionId,
    sourceUserSeq: source.seq,
    turn: source.turn,
    acceptedTaskId: identities.acceptedTaskIdFor(sessionId, source.seq),
  };
}

function settleCall(
  accepted: Accepted,
  id: string,
  toolName: string,
  args: Record<string, unknown>,
  outcome: ReturnType<typeof outcomes.classifyAttemptOutcome>,
  mutating: boolean,
  result?: unknown,
): void {
  const begun = dispatch.beginPhysicalDispatch({
    identity: {
      sessionId: accepted.sessionId,
      sourceUserSeq: accepted.sourceUserSeq,
      turn: accepted.turn,
      acceptedTaskId: accepted.acceptedTaskId,
      logicalToolCallId: `logical:${id}`,
      physicalDispatchId: `dispatch:${id}`,
      ordinal: 0,
    },
    tool: toolName,
    args,
  });
  assert.equal(begun.status, 'inserted');
  if (begun.status !== 'inserted') throw new Error('fixture dispatch was not admitted');
  assert.equal(dispatch.settlePhysicalDispatch({
    identity: begun.identity,
    tool: toolName,
    outcome: 'returned',
  }).status, 'inserted');
  assert.equal(settlements.commitLogicalCallSettlement({
    identity: {
      sessionId: accepted.sessionId,
      sourceUserSeq: accepted.sourceUserSeq,
      turn: accepted.turn,
      acceptedTaskId: accepted.acceptedTaskId,
      logicalToolCallId: `logical:${id}`,
    },
    contract: { toolName, args },
    execution: { kind: 'provider_execution' },
    ...(result !== undefined ? { result: { payload: result } } : {}),
    outcome,
    recovery: { businessCall: true, mutating },
    observer: { lane: 'composio', turn: accepted.turn },
  }).status, 'committed');
}

test('a mutating platform-management uncertain_write still vetoes delivered business work', () => {
  const accepted = acceptedSource(
    'workflow:meta-plane-veto:scrape_and_analyze',
    'Scrape the listings and analyze them.',
  );

  // The real business work: a scrape that succeeded and was captured.
  settleCall(
    accepted,
    'scrape-ok',
    'apify_run_actor',
    { actorId: 'apify/google-maps-scraper' },
    outcomes.classifyAttemptOutcome({ envelopeSuccessful: true }),
    false,
    { successful: true, data: { items: [{ place: 'A' }] } },
  );

  // The desperate connection-plane poke: settled ambiguous, no resolution.
  settleCall(
    accepted,
    'connection-poke',
    'composio_manage_connections',
    { action: 'refresh', toolkit: 'apify' },
    outcomes.classifyAttemptOutcome({ mutating: true, acknowledged: false }),
    true,
  );
  eventlog.appendEvent({
    sessionId: accepted.sessionId,
    turn: accepted.turn,
    role: 'system',
    type: 'external_write',
    data: {
      shapeKey: 'COMPOSIO_MANAGE_CONNECTIONS',
      toolName: 'composio_manage_connections',
      preDispatch: true,
      canonicalCallId: 'logical:connection-poke',
    },
  });

  const audit = auditAcceptedSourceSettlementTruth({
    sessionId: accepted.sessionId,
    sourceUserSeq: accepted.sourceUserSeq,
    requiresBusinessEvidence: true,
  });
  assert.equal(audit.facts.unrecoveredBusinessFailures, 1,
    'a mutating connection/control operation is an unrecovered external effect');
  assert.equal(audit.facts.blockingUncertainWrites, 1,
    'provider-platform ambiguity still requires reconciliation');
  assert.equal(audit.status, 'uncertain_write',
    `the uncertain mutation must withhold a clean terminal: ${JSON.stringify(audit)}`);
  assert.equal(audit.facts.uncertainWrites, 1,
    'the ambiguity stays reported and continues to veto a clean terminal');
});

test('a composio-prefixed provider business write settling uncertain_write still vetoes delivery', () => {
  const accepted = acceptedSource(
    'workflow:business-write-veto:update_records',
    'Update the records sheet.',
  );

  settleCall(
    accepted,
    'sheet-write',
    'composio_airtable_update_records',
    { rows: [{ id: 1 }] },
    outcomes.classifyAttemptOutcome({ mutating: true, acknowledged: false }),
    true,
  );
  eventlog.appendEvent({
    sessionId: accepted.sessionId,
    turn: accepted.turn,
    role: 'system',
    type: 'external_write',
    data: {
      shapeKey: 'COMPOSIO_AIRTABLE_UPDATE_RECORDS',
      toolName: 'composio_airtable_update_records',
      preDispatch: true,
      canonicalCallId: 'logical:sheet-write',
    },
  });

  const audit = auditAcceptedSourceSettlementTruth({
    sessionId: accepted.sessionId,
    sourceUserSeq: accepted.sourceUserSeq,
  });
  assert.equal(audit.status, 'uncertain_write',
    `an unreconciled provider business write is exactly what this audit exists to catch: ${JSON.stringify(audit)}`);
});

test('a business write dispatched THROUGH the carrier still vetoes: classify by action, never carrier toolName', () => {
  const accepted = acceptedSource(
    'workflow:carrier-named-write-veto:update_rows',
    'Update the tracker rows.',
  );

  settleCall(
    accepted,
    'carrier-write',
    'alpha_records_update',
    { rows: [{ id: 2 }] },
    outcomes.classifyAttemptOutcome({ mutating: true, acknowledged: false }),
    true,
  );
  // The live event shape: ONE carrier fans out every provider action, so the
  // event's toolName is the carrier's — the business action lives in shapeKey.
  eventlog.appendEvent({
    sessionId: accepted.sessionId,
    turn: accepted.turn,
    role: 'system',
    type: 'external_write',
    data: {
      shapeKey: 'ALPHA_RECORDS_UPDATE',
      toolName: 'composio_execute_tool',
      preDispatch: true,
      canonicalCallId: 'logical:carrier-write',
    },
  });

  const audit = auditAcceptedSourceSettlementTruth({
    sessionId: accepted.sessionId,
    sourceUserSeq: accepted.sourceUserSeq,
  });
  assert.equal(audit.status, 'uncertain_write',
    `a carrier-dispatched business write must never inherit the platform-plane exemption: ${JSON.stringify(audit)}`);
});

test('an execute-wrapped uncertain write still vetoes: the wrapper is platform namespace, business effect', () => {
  const accepted = acceptedSource(
    'workflow:execute-wrapped-write-veto:send_update',
    'Send the update.',
  );

  // The dispatch ledger already refuses to ADMIT a physical dispatch under
  // the wrapper's own name (beginPhysicalDispatch conflicts), so the
  // settlement leg cannot carry it; the write-EVIDENCE leg still can, when an
  // unresolved external_write event names the wrapper as its shape. Ground
  // the source with real settled work, then leave that event unresolved.
  settleCall(
    accepted,
    'wrapped-context-read',
    'alpha_records_list',
    { limit: 5 },
    outcomes.classifyAttemptOutcome({ envelopeSuccessful: true }),
    false,
    { successful: true, data: { items: [] } },
  );
  eventlog.appendEvent({
    sessionId: accepted.sessionId,
    turn: accepted.turn,
    role: 'system',
    type: 'external_write',
    data: {
      shapeKey: 'COMPOSIO_EXECUTE_TOOL',
      toolName: 'composio_execute_tool',
      preDispatch: true,
      canonicalCallId: 'logical:wrapped-write',
    },
  });

  const audit = auditAcceptedSourceSettlementTruth({
    sessionId: accepted.sessionId,
    sourceUserSeq: accepted.sourceUserSeq,
  });
  assert.equal(audit.status, 'uncertain_write',
    `an execute-wrapped business write must never be plane-exempt: ${JSON.stringify(audit)}`);
});

test('a reversible logical uncertain write remains blocked until its exact reservation is reconciled', () => {
  const accepted = acceptedSource(
    'workflow:reversible-logical-veto:update_rows',
    'Update the tracker rows.',
  );
  settleCall(
    accepted,
    'reversible-ambiguous',
    'composio_google_sheets_update_rows',
    { rows: [{ id: 3 }] },
    outcomes.classifyAttemptOutcome({ mutating: true, acknowledged: false }),
    true,
  );
  eventlog.appendEvent({
    sessionId: accepted.sessionId,
    turn: accepted.turn,
    role: 'system',
    type: 'external_write',
    data: {
      shapeKey: 'GOOGLESHEETS_UPDATE_ROWS',
      toolName: 'composio_execute_tool',
      targets: ['sheet:tracker'],
      irreversible: false,
      preDispatch: true,
      canonicalCallId: 'logical:reversible-ambiguous',
    },
  });

  const audit = auditAcceptedSourceSettlementTruth({
    sessionId: accepted.sessionId,
    sourceUserSeq: accepted.sourceUserSeq,
  });
  assert.equal(audit.status, 'uncertain_write', JSON.stringify(audit));
  assert.equal(audit.facts.blockingUncertainWrites, 1);
  assert.equal(audit.facts.unrecoveredBusinessFailures, 1);
});

test('a later similar write does not reconcile an earlier ambiguous reservation', () => {
  const accepted = acceptedSource(
    'workflow:similar-write-is-not-reconcile:update_rows',
    'Update the tracker rows.',
  );
  settleCall(
    accepted,
    'first-ambiguous',
    'composio_google_sheets_update_rows',
    { rows: [{ id: 4 }] },
    outcomes.classifyAttemptOutcome({ mutating: true, acknowledged: false }),
    true,
  );
  eventlog.appendEvent({
    sessionId: accepted.sessionId,
    turn: accepted.turn,
    role: 'system',
    type: 'external_write',
    data: {
      shapeKey: 'GOOGLESHEETS_UPDATE_ROWS',
      targets: ['sheet:tracker'],
      irreversible: false,
      preDispatch: true,
      canonicalCallId: 'logical:first-ambiguous',
    },
  });
  settleCall(
    accepted,
    'second-success',
    'composio_google_sheets_update_rows',
    { rows: [{ id: 4 }] },
    outcomes.classifyAttemptOutcome({ mutating: true, acknowledged: true }),
    true,
    { successful: true, data: { updated: 1 } },
  );
  const secondReservation = eventlog.appendEvent({
    sessionId: accepted.sessionId,
    turn: accepted.turn,
    role: 'system',
    type: 'external_write',
    data: {
      shapeKey: 'GOOGLESHEETS_UPDATE_ROWS',
      targets: ['sheet:tracker'],
      irreversible: false,
      preDispatch: true,
      canonicalCallId: 'logical:second-success',
    },
  });
  eventlog.appendEvent({
    sessionId: accepted.sessionId,
    turn: accepted.turn,
    role: 'system',
    type: 'external_write_succeeded',
    parentEventId: secondReservation.id,
    data: {
      shapeKey: 'GOOGLESHEETS_UPDATE_ROWS',
      targets: ['sheet:tracker'],
      canonicalCallId: 'logical:second-success',
    },
  });

  const audit = auditAcceptedSourceSettlementTruth({
    sessionId: accepted.sessionId,
    sourceUserSeq: accepted.sourceUserSeq,
  });
  assert.equal(audit.status, 'uncertain_write', JSON.stringify(audit));
  assert.equal(audit.facts.blockingUncertainWrites, 1);
});

test('the exact reservation terminal clears logical uncertainty after readback reconciliation', () => {
  const accepted = acceptedSource(
    'workflow:exact-reconciliation:update_rows',
    'Update the tracker rows.',
  );
  settleCall(
    accepted,
    'reconciled-ambiguous',
    'composio_google_sheets_update_rows',
    { rows: [{ id: 5 }] },
    outcomes.classifyAttemptOutcome({ mutating: true, acknowledged: false }),
    true,
  );
  const reservation = eventlog.appendEvent({
    sessionId: accepted.sessionId,
    turn: accepted.turn,
    role: 'system',
    type: 'external_write',
    data: {
      shapeKey: 'GOOGLESHEETS_UPDATE_ROWS',
      targets: ['sheet:tracker'],
      irreversible: false,
      preDispatch: true,
      canonicalCallId: 'logical:reconciled-ambiguous',
    },
  });
  eventlog.appendEvent({
    sessionId: accepted.sessionId,
    turn: accepted.turn,
    role: 'system',
    type: 'external_write_orphaned',
    parentEventId: reservation.id,
    data: {
      shapeKey: 'GOOGLESHEETS_UPDATE_ROWS',
      targets: ['sheet:tracker'],
      canonicalCallId: 'logical:reconciled-ambiguous',
      reason: 'provider outcome unknown',
    },
  });
  eventlog.appendEvent({
    sessionId: accepted.sessionId,
    turn: accepted.turn,
    role: 'system',
    type: 'external_write_succeeded',
    parentEventId: reservation.id,
    data: {
      shapeKey: 'GOOGLESHEETS_UPDATE_ROWS',
      targets: ['sheet:tracker'],
      canonicalCallId: 'logical:reconciled-ambiguous',
      reason: 'reconciled_present',
      evidenceCallId: 'readback:tracker-row-5',
    },
  });

  const audit = auditAcceptedSourceSettlementTruth({
    sessionId: accepted.sessionId,
    sourceUserSeq: accepted.sourceUserSeq,
    requiresBusinessEvidence: true,
  });
  assert.equal(audit.status, 'clean', JSON.stringify(audit));
  assert.equal(audit.facts.blockingUncertainWrites, 0);
  assert.equal(audit.facts.unrecoveredBusinessFailures, 0);
  assert.equal(audit.facts.confirmedWrites, 1);
});

test('a parented reconciliation cannot settle a sibling reservation that reused its call id', () => {
  const accepted = acceptedSource(
    'workflow:reused-call-id-reconciliation:update_rows',
    'Update the tracker rows.',
  );
  settleCall(
    accepted,
    'reused-ambiguous',
    'composio_google_sheets_update_rows',
    { rows: [{ id: 6 }] },
    outcomes.classifyAttemptOutcome({ mutating: true, acknowledged: false }),
    true,
  );
  const reserve = () => eventlog.appendEvent({
    sessionId: accepted.sessionId,
    turn: accepted.turn,
    role: 'system',
    type: 'external_write',
    data: {
      shapeKey: 'GOOGLESHEETS_UPDATE_ROWS',
      targets: ['sheet:tracker'],
      irreversible: false,
      preDispatch: true,
      canonicalCallId: 'logical:reused-ambiguous',
    },
  });
  const first = reserve();
  const second = reserve();
  for (const reservation of [first, second]) {
    eventlog.appendEvent({
      sessionId: accepted.sessionId,
      turn: accepted.turn,
      role: 'system',
      type: 'external_write_orphaned',
      parentEventId: reservation.id,
      data: {
        shapeKey: 'GOOGLESHEETS_UPDATE_ROWS',
        targets: ['sheet:tracker'],
        canonicalCallId: 'logical:reused-ambiguous',
        reason: 'provider outcome unknown',
      },
    });
  }
  eventlog.appendEvent({
    sessionId: accepted.sessionId,
    turn: accepted.turn,
    role: 'system',
    type: 'external_write_succeeded',
    parentEventId: first.id,
    data: {
      shapeKey: 'GOOGLESHEETS_UPDATE_ROWS',
      targets: ['sheet:tracker'],
      canonicalCallId: 'logical:reused-ambiguous',
      reason: 'reconciled_present',
      evidenceCallId: 'readback:reused-first',
    },
  });

  const evidence = resolveWriteEvidence(eventlog.listEvents(accepted.sessionId, { limit: 500 }));
  assert.deepEqual(evidence.confirmed.map((event) => event.id), [first.id]);
  assert.deepEqual(evidence.uncertain.map((event) => event.id), [second.id]);
  const audit = auditAcceptedSourceSettlementTruth({
    sessionId: accepted.sessionId,
    sourceUserSeq: accepted.sourceUserSeq,
  });
  assert.equal(audit.status, 'uncertain_write', JSON.stringify(audit));
  assert.equal(audit.facts.blockingUncertainWrites, 1);
  assert.equal(
    audit.facts.unrecoveredBusinessFailures,
    1,
    'a reused call id cannot map one reservation terminal onto every logical ambiguity',
  );
});
