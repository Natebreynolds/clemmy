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
 *   5. A genuine runaway of many DISTINCT physical calls/subjects still
 *      cannot get past the turn-wide ceiling.
 *
 * Third regression, same day: a reviewer correctly rejected the original fix
 * for the never-settled half of the incident above (a claim reclaimed once it
 * had merely sat PENDING past a fixed wall-clock bound). Elapsed time cannot
 * prove the original provider body actually stopped — a wall-clock takeover
 * can hand the slot to a second caller while the first is still genuinely in
 * flight (a guess wearing a timer, the same family as this codebase's "a
 * lexical guess is not a proof" rule). The real fix is settlement-driven:
 * host-tool-invocation.ts's one terminal-owner state machine now settles this
 * exact claim by call id at the moment ANY path — deadline, cancellation, or
 * normal return — actually ends the call, so a claim can only be `pending`
 * here while its call is genuinely open. Contract under pin:
 *   4. No wall-clock path may reclaim a still-pending claim, ever — the door
 *      out is settlement, not elapsed time.
 *   6. A TIMED_OUT reclaim is CAS-bound to ONE per (epoch, category,
 *      subject): a second consecutive timeout on the same subject must earn
 *      a new epoch through host-observed evidence, not another free retry.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

// THE LIVE SHAPE, second half, CORRECTED: the settlement above never actually
// happened for the real incident — the claim sat `pending` forever because a
// host-owned deadline settled the tool ATTEMPT without ever calling this
// governor's settle(). The FIRST fix reclaimed a claim once it had merely sat
// PENDING past a fixed wall-clock bound; a reviewer correctly rejected that —
// elapsed time cannot prove the original provider body actually stopped, and
// a wall-clock takeover can hand the slot to a second caller while the first
// is still genuinely in flight (a guess wearing a timer). The real fix moved
// upstream: host-tool-invocation.ts's one terminal-owner state machine now
// settles this exact claim by call id at the moment ANY path — deadline,
// cancellation, or normal return — actually ends the call (see
// host-tool-invocation.test.ts for that settlement-driven integration pin).
// This governor's own admission path must therefore never again authorize a
// reclaim from elapsed time alone.
test('a claim whose body is genuinely still in flight is never reclaimable by elapsed time', () => {
  // DIRECTION, source-structure form: assert the wall-clock branch stays
  // gone rather than merely unused — a future edit that reintroduces "claim
  // is old enough, hand it to a new caller" would defeat the exact guarantee
  // this incident needed.
  const source = readFileSync(new URL('./discovery-governor.ts', import.meta.url), 'utf8');
  assert.ok(!/STALE_PENDING_CLAIM_MS/.test(source),
    'no elapsed-time constant may govern claim reclaim any more');
  assert.ok(!/Date\.now\(\)\s*-\s*Date\.parse\(\s*existing\.admittedAt\s*\)/.test(source),
    "no wall-clock comparison against a claim's admission time may authorize a reclaim");

  const key = acceptedTask('pending-never-reclaimed-by-time');
  const governor = new DiscoveryGovernor();
  assert.equal(governor.initializeTask({ ...key, knownCapability: false }).status, 'initialized');

  const first = governor.admit({ ...key, category: 'broad_discovery', callId: 'call-1' });
  assert.equal(first.admitted, true, first.reason);
  assert.equal(first.claim?.outcome, 'pending');

  // A young pending claim still protects its one physical owner (unchanged).
  const tooSoon = governor.admit({ ...key, category: 'broad_discovery', callId: 'call-2' });
  assert.equal(tooSoon.admitted, false,
    'a young pending claim must still deny a concurrent second physical call');
  assert.equal(tooSoon.reason, 'new_call_requires_retry_epoch');

  // Backdate the claim's admission far past the OLD (now-deleted) staleness
  // bound — this models a claim whose body really is still running a slow
  // provider call, which no elapsed time could ever distinguish from an
  // orphan. No lane ever called settle() for it.
  const db = eventlog.openEventLog();
  const backdated = new Date(Date.now() - 60 * 60_000).toISOString();
  const rewritten = db.prepare(`
    UPDATE discovery_governor_claims
       SET admitted_at = ?
     WHERE session_id = ? AND source_user_seq = ? AND call_id = ?
  `).run(backdated, key.sessionId, key.sourceUserSeq, 'call-1');
  assert.equal(rewritten.changes, 1);

  // THE PIN: no amount of elapsed time hands this still-pending claim to a
  // second caller.
  const stillDenied = governor.admit({ ...key, category: 'broad_discovery', callId: 'call-2' });
  assert.equal(stillDenied.admitted, false,
    'elapsed time alone must never authorize a reclaim');
  assert.equal(stillDenied.reason, 'new_call_requires_retry_epoch');

  // The only real door out is settlement — exactly what the host's own
  // call-ending boundary now performs the moment the call actually concludes.
  const settled = governor.settle({
    ...key, category: 'broad_discovery', callId: 'call-1', outcome: 'timed_out',
  });
  assert.equal(settled.recorded, true, settled.reason);
  const nowAdmits = governor.admit({ ...key, category: 'broad_discovery', callId: 'call-2' });
  assert.equal(nowAdmits.admitted, true,
    `settlement — never elapsed time — must open the door — got ${nowAdmits.reason}`);
  assert.equal(nowAdmits.reason, 'settled_continuation_admitted');
});

// THE REVIEWER'S SECOND ASK: at most one CAS-bound retry per claim, not
// unlimited continuation. `timeout_continuation_used` flips 0 -> 1 atomically
// with the transfer UPDATE — a compare-and-swap on the claim row itself, not
// a counter in memory — so a subject that keeps timing out on its own retry
// cannot loop forever; it must earn a new epoch through host-observed
// evidence, same as any other unsuccessful outcome. A SUCCEEDED claim (the
// gauntlet-fix pagination case above) carries no such cap.
test('a TIMED_OUT claim gets exactly one CAS-bound continuation; a second consecutive timeout needs the evidence door', () => {
  const key = acceptedTask('timeout-continuation-cas-bound');
  const governor = new DiscoveryGovernor();
  assert.equal(governor.initializeTask({ ...key, knownCapability: false }).status, 'initialized');

  const first = governor.admit({ ...key, category: 'broad_discovery', callId: 'call-1' });
  assert.equal(first.admitted, true, first.reason);
  assert.equal(first.claim?.timeoutContinuationUsed, false);
  const settledFirst = governor.settle({
    ...key, category: 'broad_discovery', callId: 'call-1', outcome: 'timed_out',
  });
  assert.equal(settledFirst.recorded, true, settledFirst.reason);

  // First timeout: the one grace continuation is available and is spent here.
  const retry1 = governor.admit({ ...key, category: 'broad_discovery', callId: 'call-2' });
  assert.equal(retry1.admitted, true, retry1.reason);
  assert.equal(retry1.reason, 'settled_continuation_admitted');
  assert.equal(retry1.claim?.timeoutContinuationUsed, true,
    'the CAS flag must flip atomically with the transfer that spent it');
  const settledSecond = governor.settle({
    ...key, category: 'broad_discovery', callId: 'call-2', outcome: 'timed_out',
  });
  assert.equal(settledSecond.recorded, true, settledSecond.reason);

  // THE PIN: a second CONSECUTIVE timeout on the exact same subject must NOT
  // get another free continuation — the CAS flag is already spent.
  const retry2 = governor.admit({ ...key, category: 'broad_discovery', callId: 'call-3' });
  assert.equal(retry2.admitted, false,
    `a claim that already used its one timeout continuation must not get a second — got ${retry2.reason}`);
  assert.equal(retry2.reason, 'new_call_requires_retry_epoch');

  // The evidence door still works exactly as it does for any other
  // unsuccessful outcome.
  const evidence = governor.recordEvidence({ ...key, kind: 'candidate_unsupported' });
  assert.equal(evidence.outcome, 'epoch_opened');
  const retried = governor.admit({ ...key, category: 'broad_discovery', callId: 'call-3' });
  assert.equal(retried.admitted, true, retried.reason);
  assert.equal(retried.reason, 'new_evidence_admitted');
});

// DIRECTION: the turn-wide ceiling remains the runaway backstop independent
// of the per-subject CAS bound above. A genuine runaway realistically looks
// like many DISTINCT subjects (schema refreshes on different tools, or
// distinct requirement roles), each spending its own admission — not one
// subject looping on the same claim forever, which the CAS bound above now
// stops after a single free retry.
test('a genuine runaway of distinct physical calls against distinct subjects still hits the turn ceiling', () => {
  const key = acceptedTask('runaway-still-bounded');
  const governor = new DiscoveryGovernor();
  assert.equal(governor.initializeTask({ ...key, knownCapability: false }).status, 'initialized');

  let ceilingHit = false;
  for (let i = 0; i < MAX_TURN_DISCOVERY_ADMISSIONS + 5; i += 1) {
    const callId = `runaway-${i}`;
    // exact_schema_refresh subjects are caller-named and per-tool, so N
    // distinct subjects mint N distinct claims without needing role-scoping
    // or evidence-epoch reopens — the cleanest way to exercise the raw
    // turn-wide ceiling in isolation from the per-subject CAS bound.
    const decision = governor.admit({
      ...key, category: 'exact_schema_refresh', callId, subject: `tool-${i}`,
    });
    // The turn-wide backstop counts durable `discovery_governor_decision`
    // events, not in-memory calls (discovery-governor.ts queries the event
    // log directly so the ceiling survives a restart). Real callers go
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
        `every admission before the ceiling must succeed — denied at i=${i} with ${decision.reason}`);
      ceilingHit = true;
      break;
    }
    governor.settle({
      ...key, category: 'exact_schema_refresh', callId, subject: `tool-${i}`, outcome: 'timed_out',
    });
  }
  assert.equal(ceilingHit, true, 'the turn-wide backstop must still stop a runaway of distinct calls');
});
