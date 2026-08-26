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
 *
 * Second regression, same day, same mechanism, different starving outcome:
 * sess-desktop-970d457a6554134620236989 source 85009. The FIRST tool_search
 * of the turn was admitted (coerced onto `host:unscoped_role`), then hit a
 * host-owned deadline. That path settles the tool ATTEMPT (the model got a
 * `transient`/retry_with_backoff refusal) but never calls this governor's
 * settle() for the claim it opened — proven empirically: no
 * `discovery_governor_outcome` event exists anywhere in that session for
 * that call id. The claim stayed `pending` forever. Every one of the 55
 * distinct tool_search calls that followed collapsed onto the SAME
 * `host:unscoped_role` subject (none carried a `role_key`) and every one was
 * denied `new_call_requires_retry_epoch` for the rest of the turn — a
 * genuinely repairable turn (the model's very next act attempt only needed
 * one more read) starved to death by one orphaned claim. Contract under pin:
 *   3. A claim that SETTLED TIMED_OUT (the one outcome whose own recovery
 *      directive is "retry the same candidate") admits a new physical call as
 *      a continuation, the same as a settled-successful claim — `empty` and
 *      `failed` are unaffected and still require the evidence-epoch door.
 *   4. A claim that never settled at all and has sat pending past
 *      STALE_PENDING_CLAIM_MS is reclaimed the same way; a claim that is
 *      merely young (the ordinary in-flight case pinned above) is not.
 *   5. A genuine runaway of many DISTINCT physical calls against a claim that
 *      keeps re-settling unsuccessfully still cannot get past the
 *      turn-wide ceiling — reclaim only ever hands the ONE current slot to
 *      ONE new owner at a time.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-discovery-continuation-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

const eventlog = await import('./eventlog.js');
const {
  DiscoveryGovernor,
  HOST_UNSCOPED_DISCOVERY_SUBJECT,
  STALE_PENDING_CLAIM_MS,
  MAX_TURN_DISCOVERY_ADMISSIONS,
} = await import('./discovery-governor.js');

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

// THE LIVE SHAPE (2026-08-26, sess-desktop-970d457a6554134620236989 source
// 85009): a `transient` (timed-out) attempt's own recovery directive is
// "retry the same candidate" — the runtime already sanctioned this exact
// retry — yet a fresh physical call id had nowhere to land, because only
// `succeeded` opened the continuation door and `transient` deliberately never
// opens a fresh evidence epoch (nothing was learned). `empty`/`failed` are
// unaffected: those still cost something to say and keep the epoch-only door.
test('a follow-up of a settled-TIMED_OUT search admits as a bounded continuation, unlike empty/failed', () => {
  const key = acceptedTask('settled-timed-out-continuation');
  const governor = new DiscoveryGovernor();
  assert.equal(governor.initializeTask({ ...key, knownCapability: false }).status, 'initialized');

  const first = governor.admit({ ...key, category: 'broad_discovery', callId: 'call-1' });
  assert.equal(first.admitted, true, first.reason);

  const settled = governor.settle({
    ...key, category: 'broad_discovery', callId: 'call-1', outcome: 'timed_out', detail: 'provider_timeout',
  });
  assert.equal(settled.recorded, true, settled.reason);

  // THE PIN: the model's only real retry path — a fresh physical call id —
  // must be able to land once the timed-out attempt is known concluded.
  const retry = governor.admit({ ...key, category: 'broad_discovery', callId: 'call-2' });
  assert.equal(retry.admitted, true,
    `a retry of a timed-out search must admit — got ${retry.reason}`);
  assert.equal(retry.reason, 'settled_continuation_admitted');
  assert.equal(retry.consumedBudget, true);
  assert.equal(retry.claim?.callId, 'call-2');

  // empty/failed remain gated behind the evidence-epoch door, unaffected.
  for (const outcome of ['empty', 'failed'] as const) {
    const soleKey = acceptedTask(`settled-${outcome}-unaffected`);
    const soleGovernor = new DiscoveryGovernor();
    soleGovernor.initializeTask({ ...soleKey, knownCapability: false });
    soleGovernor.admit({ ...soleKey, category: 'broad_discovery', callId: 'a' });
    soleGovernor.settle({ ...soleKey, category: 'broad_discovery', callId: 'a', outcome });
    const denied = soleGovernor.admit({ ...soleKey, category: 'broad_discovery', callId: 'b' });
    assert.equal(denied.admitted, false, `${outcome} must still require the evidence-epoch door`);
    assert.equal(denied.reason, 'new_call_requires_retry_epoch');
  }
});

// THE LIVE SHAPE, second half: the settlement above never actually happened
// for the real incident — the claim sat `pending` forever because a
// host-owned deadline settled the tool ATTEMPT without ever calling this
// governor's settle(). That is a fact of a lane this governor cannot see
// inside; the fix is a bounded self-heal, not a dependency on that lane.
test('a claim that never settled and has gone stale is reclaimed by a new physical call; a young pending claim is not', () => {
  const key = acceptedTask('stale-pending-reclaim');
  const governor = new DiscoveryGovernor();
  assert.equal(governor.initializeTask({ ...key, knownCapability: false }).status, 'initialized');

  const first = governor.admit({ ...key, category: 'broad_discovery', callId: 'call-1' });
  assert.equal(first.admitted, true, first.reason);
  assert.equal(first.claim?.outcome, 'pending');

  // DIRECTION (pin 2 of the earlier gauntlet, reconfirmed): a claim that is
  // merely young — the ordinary in-flight case — still protects its one
  // physical owner. No settlement, no time elapsed.
  const tooSoon = governor.admit({ ...key, category: 'broad_discovery', callId: 'call-2' });
  assert.equal(tooSoon.admitted, false,
    'a young pending claim must still deny a concurrent second physical call');
  assert.equal(tooSoon.reason, 'new_call_requires_retry_epoch');

  // Backdate the claim's admission past the staleness bound. No lane ever
  // called settle() for it — this models the orphaned claim exactly as the
  // live incident produced it, never guessing at another file's timeout.
  const db = eventlog.openEventLog();
  const backdated = new Date(Date.now() - STALE_PENDING_CLAIM_MS - 1_000).toISOString();
  const rewritten = db.prepare(`
    UPDATE discovery_governor_claims
       SET admitted_at = ?
     WHERE session_id = ? AND source_user_seq = ? AND call_id = ?
  `).run(backdated, key.sessionId, key.sourceUserSeq, 'call-1');
  assert.equal(rewritten.changes, 1);

  // THE PIN: past the bound, the orphaned claim no longer starves the turn.
  const reclaimed = governor.admit({ ...key, category: 'broad_discovery', callId: 'call-2' });
  assert.equal(reclaimed.admitted, true,
    `a stale never-settled claim must be reclaimed — got ${reclaimed.reason}`);
  assert.equal(reclaimed.reason, 'stale_pending_claim_reclaimed');
  assert.equal(reclaimed.consumedBudget, true);
  assert.equal(reclaimed.claim?.callId, 'call-2');
  assert.equal(reclaimed.claim?.outcome, 'pending');

  // The original callId is no longer this claim's owner: a late settlement
  // for it (the orphaned lane finally reporting in) is a mismatch, not a
  // corruption of the reclaimed claim.
  const lateSettle = governor.settle({
    ...key, category: 'broad_discovery', callId: 'call-1', outcome: 'timed_out',
  });
  assert.equal(lateSettle.recorded, false);
  assert.equal(lateSettle.reason, 'claim_call_mismatch');
});

// DIRECTION: reclaim hands the ONE current slot to ONE new owner at a time —
// it is not a second budget. A genuine runaway that keeps re-settling
// unsuccessfully (or timing out) still cannot get past the turn-wide ceiling.
test('a genuine runaway of distinct physical calls against a repeatedly timed-out claim still hits the turn ceiling', () => {
  const key = acceptedTask('runaway-still-bounded');
  const governor = new DiscoveryGovernor();
  assert.equal(governor.initializeTask({ ...key, knownCapability: false }).status, 'initialized');

  let ceilingHit = false;
  for (let i = 0; i < MAX_TURN_DISCOVERY_ADMISSIONS + 5; i += 1) {
    const callId = `runaway-${i}`;
    const decision = governor.admit({ ...key, category: 'broad_discovery', callId });
    // The turn-wide backstop counts durable `discovery_governor_decision`
    // events, not in-memory calls (discovery-governor.ts:1229 queries the
    // event log directly so the ceiling survives a restart). Real callers go
    // through discovery-boundary.ts's emitDecisionTelemetry; reproduce that
    // one integration seam here so the ceiling this pin exercises is the
    // actual production one, not a bypassed no-op.
    eventlog.appendEvent({
      sessionId: key.sessionId,
      turn: 1,
      role: 'system',
      type: decision.telemetry.eventName,
      data: decision.telemetry.eventData,
    });
    if (!decision.admitted) {
      assert.equal(decision.reason, 'turn_discovery_ceiling',
        `every admission before the ceiling must succeed as a continuation — denied at i=${i} with ${decision.reason}`);
      ceilingHit = true;
      break;
    }
    governor.settle({ ...key, category: 'broad_discovery', callId, outcome: 'timed_out' });
  }
  assert.equal(ceilingHit, true, 'the turn-wide backstop must still stop a runaway of distinct calls');
});
