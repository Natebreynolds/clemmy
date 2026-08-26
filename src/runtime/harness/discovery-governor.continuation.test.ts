/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/discovery-governor.continuation.test.ts
 *
 * Regression pins for the 2026-08-26 gauntlet break (B1 feeder b): the
 * governor denied 147 tool_search calls with `new_call_requires_retry_epoch`,
 * including follow-ups/pagination of already-admitted, already-SUCCESSFUL
 * searches — while plan admission simultaneously demanded the disclosure only
 * those reads could produce (the constraint-ordering "built but never
 * reached" class). Contract under pin:
 *   1. A new physical call on a subject whose claim has SETTLED SUCCESSFUL is
 *      a bounded continuation read and admits without a fresh epoch.
 *   2. The one-physical-owner rule is unchanged while a claim is pending, for
 *      exact same-call replays, and for settled-unsuccessful claims (those
 *      recover through the evidence-epoch door, never through continuation).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-discovery-continuation-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

const eventlog = await import('./eventlog.js');
const { DiscoveryGovernor, HOST_UNSCOPED_DISCOVERY_SUBJECT } = await import('./discovery-governor.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

function acceptedTask(label: string): { sessionId: string; sourceUserSeq: number } {
  const session = eventlog.createSession({ id: `governor-continuation-${label}`, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: label },
  });
  return { sessionId: session.id, sourceUserSeq: source.seq };
}

test('a follow-up of a settled-successful search admits as a bounded continuation', () => {
  const key = acceptedTask('settled-successful-continuation');
  const governor = new DiscoveryGovernor();
  assert.equal(governor.initializeTask({ ...key, knownCapability: false }).status, 'initialized');

  const first = governor.admit({ ...key, category: 'broad_discovery', callId: 'call-1' });
  assert.equal(first.admitted, true, first.reason);

  // While the first physical call is pending, a different call id is still a
  // concurrent second provider body and stays denied.
  const concurrent = governor.admit({ ...key, category: 'broad_discovery', callId: 'call-2' });
  assert.equal(concurrent.admitted, false);
  assert.equal(concurrent.reason, 'new_call_requires_retry_epoch');

  const settled = governor.settle({
    ...key, category: 'broad_discovery', callId: 'call-1', outcome: 'succeeded',
  });
  assert.equal(settled.recorded, true, settled.reason);

  // The exact spent physical id never re-enters provider code.
  const replay = governor.admit({ ...key, category: 'broad_discovery', callId: 'call-1' });
  assert.equal(replay.admitted, false);
  assert.equal(replay.reason, 'same_call_replay');

  // THE PIN: a successful-but-insufficient search must not starve the turn.
  // Pagination/refinement of the admitted intent is a continuation read.
  const continuation = governor.admit({ ...key, category: 'broad_discovery', callId: 'call-2' });
  assert.equal(continuation.admitted, true,
    `continuation of a settled-successful search must admit — got ${continuation.reason}`);
  assert.equal(continuation.reason, 'settled_continuation_admitted');
  assert.equal(continuation.consumedBudget, true,
    'continuations spend real admissions so the turn ceiling still bounds them');
  assert.equal(continuation.claim?.callId, 'call-2');
  assert.equal(continuation.claim?.outcome, 'pending');

  // The continuation owns settlement now; it settles normally.
  const settledContinuation = governor.settle({
    ...key, category: 'broad_discovery', callId: 'call-2', outcome: 'succeeded',
  });
  assert.equal(settledContinuation.recorded, true, settledContinuation.reason);

  // And a third page continues the same way.
  const thirdPage = governor.admit({ ...key, category: 'broad_discovery', callId: 'call-3' });
  assert.equal(thirdPage.admitted, true, thirdPage.reason);
  assert.equal(thirdPage.reason, 'settled_continuation_admitted');
});

test('the coerced host:unscoped_role subject admits continuations the same way (the measured 104-denial shape)', () => {
  const key = acceptedTask('unscoped-role-continuation');
  const governor = new DiscoveryGovernor();
  assert.equal(governor.initializeTask({ ...key, knownCapability: false }).status, 'initialized');
  governor.initializeRoles({
    ...key,
    requirements: [
      { roleKey: 'clause-1:destination', clauseIndex: 0, text: 'write the sheet', resolved: false },
    ],
    brokerCoverage: 'authorized_external_v1',
  });

  const first = governor.admit({
    ...key, category: 'broad_discovery', callId: 'search-1', subject: 'clause-1:unknown',
  });
  assert.equal(first.admitted, true, first.reason);
  assert.equal(first.subject, HOST_UNSCOPED_DISCOVERY_SUBJECT);

  const settled = governor.settle({
    ...key,
    category: 'broad_discovery',
    callId: 'search-1',
    subject: HOST_UNSCOPED_DISCOVERY_SUBJECT,
    outcome: 'succeeded',
  });
  assert.equal(settled.recorded, true, settled.reason);

  const followup = governor.admit({
    ...key, category: 'broad_discovery', callId: 'search-2', subject: 'clause-1:something-else',
  });
  assert.equal(followup.admitted, true,
    `a refined query on the settled coerced subject must admit — got ${followup.reason}`);
  assert.equal(followup.reason, 'settled_continuation_admitted');
});

test('settled-unsuccessful claims keep recovering through the evidence epoch, not continuation', () => {
  const key = acceptedTask('failed-claims-keep-epoch-door');
  const governor = new DiscoveryGovernor();
  assert.equal(governor.initializeTask({ ...key, knownCapability: false }).status, 'initialized');

  const first = governor.admit({ ...key, category: 'broad_discovery', callId: 'call-a' });
  assert.equal(first.admitted, true, first.reason);
  const settled = governor.settle({
    ...key, category: 'broad_discovery', callId: 'call-a', outcome: 'failed',
  });
  assert.equal(settled.recorded, true, settled.reason);

  const denied = governor.admit({ ...key, category: 'broad_discovery', callId: 'call-b' });
  assert.equal(denied.admitted, false,
    'a failed search recovers only through host-observed evidence opening a new epoch');
  assert.equal(denied.reason, 'new_call_requires_retry_epoch');

  const evidence = governor.recordEvidence({ ...key, kind: 'candidate_unsupported' });
  assert.equal(evidence.outcome, 'epoch_opened');
  const retried = governor.admit({ ...key, category: 'broad_discovery', callId: 'call-b' });
  assert.equal(retried.admitted, true, retried.reason);
  assert.equal(retried.reason, 'new_evidence_admitted');
});
