/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/settlement-audit-platform-plane.test.ts
 *
 * PLATFORM-PLANE AMBIGUITY IS NOT A BUSINESS HAZARD (live 2026-08-25,
 * workflow scrape_and_analyze): the model's composio_manage_connections poke
 * settled uncertain_write, and the settlement audit counted that harness-meta
 * operation as an unrecovered BUSINESS failure — the step blocked AFTER the
 * real scrape had succeeded and been captured, so notify was skipped. The
 * audit already exempts refused_pre_dispatch for the same reason ("Clementine's
 * own guardrails" must not be the reason she cannot report); these pin the
 * matching exemption for the uncertain_write leg, and pin its boundary: a real
 * provider business write settling uncertain_write MUST keep vetoing.
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
  eventlog.createSession({ id: sessionId, kind: 'workflow' });
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

test('a platform-plane uncertain_write does not veto a source whose business work succeeded', () => {
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
  assert.equal(audit.facts.unrecoveredBusinessFailures, 0,
    'a harness-plane poke is not an unrecovered BUSINESS failure');
  assert.equal(audit.facts.blockingUncertainWrites, 0,
    'ambiguity about Clementine\'s own tool plumbing does not demand human reconciliation');
  assert.equal(audit.status, 'clean',
    `the platform-plane poke must not withhold delivered business work: ${JSON.stringify(audit)}`);
  assert.equal(audit.facts.uncertainWrites, 1,
    'the ambiguity stays REPORTED even though it no longer vetoes');
});

test('a provider business write settling uncertain_write still vetoes delivery', () => {
  const accepted = acceptedSource(
    'workflow:business-write-veto:update_records',
    'Update the records sheet.',
  );

  settleCall(
    accepted,
    'sheet-write',
    'alpha_records_update',
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
      shapeKey: 'ALPHA_RECORDS_UPDATE',
      toolName: 'alpha_records_update',
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
