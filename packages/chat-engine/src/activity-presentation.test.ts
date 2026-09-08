/**
 * Run: node scripts/run-tests-isolated.mjs packages/chat-engine/src/activity-presentation.test.ts
 *
 * The ONE Working-Now presenter every surface renders from. The design law it
 * pins: a pulsing "Working" state is a CERTIFICATE — only renderable when the
 * server said liveness === 'live'. A non-live entry structurally cannot render
 * as Working, an awaiting_* entry lands in needs-you however old it is, and
 * elapsed time is the distance between two SERVER timestamps, never the
 * client clock.
 *
 * And the second law, pinned here from the owner's own machine: MEMBERSHIP is
 * as honest as the animation, in BOTH directions. "Not terminal" is not a
 * synonym for "happening now" — a run that stopped on Tuesday is stalled, not
 * running. And age is not death — a workflow whose class never stamps an
 * evidence timestamp may not be called "Stopped" for being nine hours old,
 * which is the lie with the sign flipped.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import {
  narrateActivity,
  presentWorkingNow,
  WORKING_NOW_STALL_MS,
  workingNowLifecycleLabel,
  workingNowStatusLabel,
  type WorkingNowEntryLike,
} from './activity-presentation.js';
import type { ActivityItem } from './types.js';

function entry(overrides: Partial<WorkingNowEntryLike> & { runKey: string }): WorkingNowEntryLike {
  return {
    lifecycle: 'reasoning',
    liveness: 'unknown',
    needsAttention: false,
    startedAt: '2026-08-25T08:00:00.000Z',
    ...overrides,
  };
}

const OBSERVED = '2026-08-25T08:05:00.000Z';

test('the certificate: a non-live entry can never present as Working', () => {
  const runningLifecycles = [
    'accepted', 'queued', 'reasoning', 'retrieving', 'using_tool',
    'fanout', 'reducing', 'verifying', 'retrying', 'completing',
  ];
  for (const lifecycle of runningLifecycles) {
    for (const liveness of ['stale', 'unknown']) {
      const view = presentWorkingNow([entry({ runKey: `r:${lifecycle}:${liveness}`, lifecycle, liveness })], OBSERVED);
      for (const presented of view.entries) {
        assert.notEqual(presented.presentation, 'working',
          `${lifecycle}/${liveness} presented as Working without the liveness certificate`);
        assert.equal(presented.pulse, false, `${lifecycle}/${liveness} pulsed while not live`);
      }
    }
  }
  // Only the server's own liveness === 'live' earns the pulse.
  const live = presentWorkingNow([entry({ runKey: 'r:live', liveness: 'live' })], OBSERVED);
  assert.equal(live.entries[0]?.presentation, 'working');
  assert.equal(live.entries[0]?.pulse, true);
});

test('an awaiting_input entry is needs-you with its age — never Working, at any age', () => {
  // Six hours old, and even (defensively) marked live: waiting on a person
  // outranks the certificate. It shows its age instead of pulsing forever.
  const view = presentWorkingNow([entry({
    runKey: 'r:input', lifecycle: 'awaiting_input', liveness: 'live',
    needsAttention: true, startedAt: '2026-08-25T02:05:00.000Z',
  })], OBSERVED);
  assert.equal(view.entries[0]?.presentation, 'needs_you');
  assert.equal(view.entries[0]?.pulse, false);
  assert.equal(view.entries[0]?.elapsed, '6h');
  assert.equal(view.needsYou, 1);
  assert.equal(view.running, 0);
});

test('a held catch-up decision counts as needs-you, not running', () => {
  const view = presentWorkingNow([
    entry({ runKey: 'r:held', lifecycle: 'awaiting_approval', needsAttention: true }),
    entry({ runKey: 'r:live', liveness: 'live' }),
  ], OBSERVED);
  assert.equal(view.running, 1);
  assert.equal(view.needsYou, 1);
  assert.equal(view.label, '1 running · 1 needs you');
});

test('elapsed is server-derived: two snapshots at the same wall clock agree', () => {
  const started = '2026-08-25T08:00:00.000Z';
  const early = presentWorkingNow([entry({ runKey: 'r', liveness: 'live', startedAt: started })], '2026-08-25T08:03:00.000Z');
  const late = presentWorkingNow([entry({ runKey: 'r', liveness: 'live', startedAt: started })], '2026-08-25T11:00:00.000Z');
  assert.equal(early.entries[0]?.elapsed, '3m');
  assert.equal(late.entries[0]?.elapsed, '3h');
});

test('settled and currently-watched rows never enter the counts', () => {
  const view = presentWorkingNow([
    entry({ runKey: 'r:done', lifecycle: 'completed', liveness: 'live', terminal: { status: 'completed' } }),
    entry({ runKey: 'r:mine', liveness: 'live', sessionId: 'sess-watching' }),
    entry({ runKey: 'r:other', liveness: 'live' }),
  ], OBSERVED, { omitSessionId: 'sess-watching' });
  assert.equal(view.total, 1);
  assert.equal(view.running, 1);
  assert.deepEqual(view.entries.map((p) => p.entry.runKey), ['r:other']);
});

test('a stale non-terminal row is a needs-you fact, never quiet running', () => {
  const view = presentWorkingNow([entry({ runKey: 'r:stale', liveness: 'stale' })], OBSERVED);
  assert.equal(view.entries[0]?.presentation, 'needs_you');
  assert.equal(view.needsYou, 1);
});

// ─── The single source, enforced structurally ────────────────────────────────
// Every Working-Now consumer renders from presentWorkingNow. No surface may
// re-derive counts from raw entries or turn the client clock into elapsed —
// that is exactly how five surfaces came to disagree about one question.
test('every Working-Now surface renders the shared presenter', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const consumers = [
    'apps/console-web/src/components/AppShell.tsx',
    'apps/console-web/src/components/chat/RunningTasksDrawer.tsx',
    'apps/mobile-web/src/components/RunningTasksSheet.tsx',
    'apps/mobile-web/src/screens/Home.tsx',
  ];
  for (const rel of consumers) {
    const source = readFileSync(path.join(repoRoot, rel), 'utf-8');
    assert.ok(source.includes('presentWorkingNow'), `${rel} does not render from the shared presenter`);
    assert.ok(!source.includes('.filter((entry) => entry.needsAttention'),
      `${rel} re-derives its own needs-you count from raw entries`);
    assert.ok(!source.includes('relativeTime(entry.startedAt'),
      `${rel} computes elapsed from the client clock`);
  }
  // TopBar renders counts handed to it by AppShell's presenter call only —
  // it never touches the projection or its entries itself.
  const topBar = readFileSync(path.join(repoRoot, 'apps/console-web/src/components/TopBar.tsx'), 'utf-8');
  for (const forbidden of ['needsAttention', 'listWorkingNow', 'ActivityEntry']) {
    assert.ok(!topBar.includes(forbidden), `TopBar reaches into raw activity data (${forbidden})`);
  }
});

test('live discovery stand-in names the current phase, not the first lookup forever', () => {
  const row = (over: Partial<ActivityItem> & { label: string }): ActivityItem => ({
    id: over.label + Math.random(),
    kind: 'tool',
    status: 'done',
    ...over,
  });
  const looking = narrateActivity([
    row({ label: 'tool_search', status: 'running', startedAt: 1 }),
  ], { live: true });
  assert.equal(looking[0]?.label, 'Finding the right tool…');
  assert.equal(looking[0]?.status, 'running');

  const waiting = narrateActivity([
    row({ label: 'tool_search', status: 'done', startedAt: 1 }),
  ], { live: true });
  assert.equal(waiting[0]?.label, 'Working on it…',
    'after lookup settles, the stand-in is the wait on the next step');
  assert.equal(waiting[0]?.status, 'running');

  const planned = narrateActivity([
    row({ label: 'tool_search', status: 'done' }),
    row({ label: 'plan task', status: 'running' }),
  ], { live: true });
  assert.equal(planned[0]?.label, 'plan task');
});

// ─── "Running" has to mean running ───────────────────────────────────────────
// Measured on the owner's live machine, 2026-09-06: 100 entries — 58 completed,
// 21 blocked (started 2026-09-04, two days before), 18 failed, 3 cancelled, and
// ZERO actually running. The phone led with six of those blocked rows under a
// heading that said Running. These fixtures are those exact proportions.

const NOW = '2026-09-06T13:00:00.000Z';
const TWO_DAYS_AGO = '2026-09-04T13:00:00.000Z';

function many(
  count: number,
  build: (index: number) => Partial<WorkingNowEntryLike> & { runKey: string },
): WorkingNowEntryLike[] {
  return Array.from({ length: count }, (_unused, index) => entry(build(index)));
}

/** The owner's projection, in the shape the PHONE receives it: the strict
 *  foreground DTO carries no `terminal` field at all, so a settled row is
 *  knowable only from its lifecycle. */
const OWNERS_PROJECTION: WorkingNowEntryLike[] = [
  ...many(58, (i) => ({ runKey: `done:${i}`, lifecycle: 'completed', startedAt: TWO_DAYS_AGO, lastEvidenceAt: TWO_DAYS_AGO })),
  ...many(21, (i) => ({
    runKey: `blocked:${i}`,
    // "Pre-tag Sonnet batch verifier V24…V30" — dead test runs, labelled
    // "Needs review", filling the phone's Running list.
    lifecycle: 'blocked',
    needsAttention: true,
    startedAt: TWO_DAYS_AGO,
    lastEvidenceAt: TWO_DAYS_AGO,
  })),
  ...many(18, (i) => ({ runKey: `failed:${i}`, lifecycle: 'failed', startedAt: TWO_DAYS_AGO, lastEvidenceAt: TWO_DAYS_AGO })),
  ...many(3, (i) => ({ runKey: `cancelled:${i}`, lifecycle: 'cancelled', startedAt: TWO_DAYS_AGO, lastEvidenceAt: TWO_DAYS_AGO })),
];

test('the owner’s own projection reports ZERO running', () => {
  const view = presentWorkingNow(OWNERS_PROJECTION, NOW);
  assert.equal(view.running, 0, 'nothing was running; nothing may be counted as running');
  assert.equal(view.stalled, 21, 'the twenty-one two-day-old blocked runs are stalled');
  assert.equal(view.needsYou, 0, 'a two-day-old blocked run is not a decision waiting on you');
  assert.equal(view.settled, 79, '58 completed + 18 failed + 3 cancelled leave "current" entirely');
  assert.equal(view.total, 21, 'only the non-terminal rows stay on screen');
  assert.equal(view.label, '21 stalled');
  // Every surviving row says so about itself, and none of them pulses.
  for (const presented of view.entries) {
    assert.equal(presented.membership, 'stalled');
    assert.equal(presented.stalled, true);
    assert.equal(presented.pulse, false);
    assert.equal(presented.silence, '2d', 'the row states how long it has been quiet');
  }
});

test('a genuinely live turn IS running, in the same projection', () => {
  const live = entry({
    runKey: 'chat:live',
    lifecycle: 'reasoning',
    liveness: 'live',
    // Ninety seconds of thinking is a normal turn, not a stall.
    startedAt: '2026-09-06T12:58:30.000Z',
    lastEvidenceAt: '2026-09-06T12:58:30.000Z',
  });
  const view = presentWorkingNow([...OWNERS_PROJECTION, live], NOW);
  assert.equal(view.running, 1);
  assert.equal(view.stalled, 21);
  assert.equal(view.label, '1 running · 21 stalled');
  const presented = view.entries.find((row) => row.entry.runKey === 'chat:live');
  assert.equal(presented?.membership, 'running');
  assert.equal(presented?.presentation, 'working');
  assert.equal(presented?.pulse, true, 'a live turn keeps its certificate');
});

test('the stall threshold is a named constant, and a stopped run clears it', () => {
  // The harness clamps its heartbeat check-in to 240 minutes, so four hours of
  // silence is configuration, not death. Eight hours is two missed beats.
  assert.equal(WORKING_NOW_STALL_MS, 8 * 60 * 60 * 1_000);
  const at = (msBefore: number): string => new Date(Date.parse(NOW) - msBefore).toISOString();
  // A blocked run — one that is NOT executing — ages out on either side of the
  // line, because its age is a fact about how long it has been stopped.
  const justInside = presentWorkingNow([entry({
    runKey: 'r:blocked', lifecycle: 'blocked', needsAttention: true,
    startedAt: at(WORKING_NOW_STALL_MS - 60_000), lastEvidenceAt: at(WORKING_NOW_STALL_MS - 60_000),
  })], NOW);
  assert.equal(justInside.needsYou, 1, 'a run that stopped within the window is still your decision');
  assert.equal(justInside.stalled, 0);
  const justOutside = presentWorkingNow([entry({
    runKey: 'r:blocked', lifecycle: 'blocked', needsAttention: true,
    startedAt: at(WORKING_NOW_STALL_MS + 60_000), lastEvidenceAt: at(WORKING_NOW_STALL_MS + 60_000),
  })], NOW);
  assert.equal(justOutside.needsYou, 0);
  assert.equal(justOutside.stalled, 1);
});

test('a long-running WORKFLOW is never called stopped on age alone', () => {
  // THE ONE THAT MUST NOT REGRESS. A workflow's projection pins
  // lastEvidenceAt = finishedAt ?? startedAt ?? createdAt
  // (src/dashboard/activity-projection.ts:217) and stamps mid-run progress as
  // currentStepId / stepsCompleted with NO timestamp
  // (src/execution/workflow-events.ts, stampRunStepProgress). So a workflow
  // that is executing right now, nine hours in, arrives here looking exactly
  // like this — and calling it "Stopped" would be the same lie as "Running"
  // with the sign flipped. It stays running, and says it has been quiet.
  const nineHours = 9 * 60 * 60 * 1_000;
  const startedAt = new Date(Date.parse(NOW) - nineHours).toISOString();
  const view = presentWorkingNow([entry({
    runKey: 'workflow:live', lifecycle: 'reasoning', liveness: 'unknown',
    startedAt, lastEvidenceAt: startedAt,
  })], NOW);
  assert.equal(view.stalled, 0, 'a live long run may not be reported as stopped');
  assert.equal(view.running, 1);
  assert.equal(view.label, '1 running');
  assert.equal(view.entries[0]?.quiet, true, 'but the silence is still declared');
  assert.equal(view.entries[0]?.silence, '9h');
  assert.equal(view.entries[0]?.pulse, false, 'and it still claims no heartbeat nobody took');
});

test('durable evidence outranks start time: a long run still producing evidence is running', () => {
  // Started eleven days ago — the run page that read "Running · 273h 48m" —
  // but evidence landed a minute ago. Age is not silence.
  const view = presentWorkingNow([entry({
    runKey: 'r:long', liveness: 'live',
    startedAt: '2026-08-26T13:00:00.000Z',
    lastEvidenceAt: '2026-09-06T12:59:30.000Z',
  })], NOW);
  assert.equal(view.running, 1);
  assert.equal(view.entries[0]?.elapsed, '11d', 'its age is still reported honestly');
  assert.equal(view.entries[0]?.silence, '<1m');
  assert.equal(view.entries[0]?.quiet, false);

  // A row whose clock DOES tick and then stopped ticking three days ago is
  // stalled — and a held-lease certificate does not rescue it. (A fan-out
  // reducer lease with no expiry is exactly this shape: it stamps the plan's
  // updatedAt, so its silence is a measurement.)
  const zombie = presentWorkingNow([entry({
    runKey: 'r:zombie', liveness: 'live',
    startedAt: '2026-08-26T13:00:00.000Z', lastEvidenceAt: '2026-09-03T13:00:00.000Z',
  })], NOW);
  assert.equal(zombie.running, 0);
  assert.equal(zombie.stalled, 1);
  assert.equal(zombie.entries[0]?.silence, '3d');
  assert.equal(zombie.entries[0]?.pulse, false, 'a lease with no evidence behind it may not pulse');
});

test('a question never ages out into "stalled"', () => {
  // Eleven days unanswered. It is still a decision a person can make, and
  // quietly demoting it is how a decision gets lost.
  const view = presentWorkingNow([
    entry({
      runKey: 'r:ask', lifecycle: 'awaiting_input', needsAttention: true,
      startedAt: '2026-08-26T13:00:00.000Z', lastEvidenceAt: '2026-08-26T13:00:00.000Z',
    }),
    entry({
      runKey: 'r:approve', lifecycle: 'awaiting_approval', needsAttention: true,
      startedAt: '2026-08-26T13:00:00.000Z', lastEvidenceAt: '2026-08-26T13:00:00.000Z',
    }),
  ], NOW);
  assert.equal(view.needsYou, 2);
  assert.equal(view.stalled, 0);
  assert.equal(view.running, 0);
  assert.equal(view.label, '2 need you');
});

test('a run that just stopped needs you; the same run on Tuesday is stalled', () => {
  const fresh = presentWorkingNow([entry({
    runKey: 'r:blocked', lifecycle: 'blocked', needsAttention: true,
    startedAt: '2026-09-06T12:55:00.000Z', lastEvidenceAt: '2026-09-06T12:55:00.000Z',
  })], NOW);
  assert.equal(fresh.needsYou, 1);
  assert.equal(fresh.stalled, 0);
  assert.equal(fresh.label, '1 needs you');

  const old = presentWorkingNow([entry({
    runKey: 'r:blocked', lifecycle: 'blocked', needsAttention: true,
    startedAt: TWO_DAYS_AGO, lastEvidenceAt: TWO_DAYS_AGO,
  })], NOW);
  assert.equal(old.needsYou, 0);
  assert.equal(old.stalled, 1);
});

test('a feed with no evidence clock is never ACCUSED of stalling', () => {
  // The board projects cards with no timestamps at all (boardStartedAt() is
  // ''). Silence cannot be known there, so it is not claimed either way — the
  // row keeps the membership it had before this rule existed.
  const view = presentWorkingNow([
    entry({ runKey: 'card:live', liveness: 'unknown', startedAt: '' }),
    entry({ runKey: 'card:waiting', liveness: 'unknown', startedAt: '', needsAttention: true }),
  ], '');
  assert.equal(view.stalled, 0);
  assert.equal(view.running, 1);
  assert.equal(view.needsYou, 1);
  assert.equal(view.entries[0]?.silence, '', 'an unknowable silence is reported as unknown');
});

test('a typed terminal still settles a row, even with a non-terminal lifecycle', () => {
  const view = presentWorkingNow([
    entry({ runKey: 'r:typed', lifecycle: 'reasoning', terminal: { status: 'failed' } }),
  ], NOW);
  assert.equal(view.total, 0);
  assert.equal(view.settled, 1);
  assert.equal(view.label, '1 finished');
});

// ─── one vocabulary for the chip and the rows under it ───────────────────────

test('the row says the same word the pill says', () => {
  // The regression this pins: the chip read "21 stalled" over a list whose
  // every row read "Needs review". One function words both now.
  const view = presentWorkingNow(OWNERS_PROJECTION, NOW);
  assert.equal(view.label, '21 stalled');
  const row = view.entries[0]!;
  assert.equal(
    workingNowStatusLabel({
      membership: row.membership,
      silence: row.silence,
      quiet: row.quiet,
      lifecycle: row.entry.lifecycle,
    }),
    'Stalled · nothing for 2d',
    'a two-day-dead row may not present its lifecycle word as if it were now',
  );
});

test('the status line, membership by membership', () => {
  assert.equal(workingNowStatusLabel({
    membership: 'running', silence: '2m', lifecycle: 'using_tool', phase: 'Calling 2 tools',
  }), 'Calling 2 tools', 'a live row keeps the server’s own phase text');
  assert.equal(workingNowStatusLabel({
    membership: 'running', silence: '2m', lifecycle: 'using_tool',
  }), 'Running', 'without a phase, the lifecycle word');
  assert.equal(workingNowStatusLabel({
    membership: 'needs_you', silence: '2m', lifecycle: 'awaiting_input',
  }), 'Waiting for input', 'the ask IS the status');
  assert.equal(workingNowStatusLabel({
    membership: 'stalled', silence: '2d', lifecycle: 'blocked',
  }), 'Stalled · nothing for 2d');
  // The quiet case: still running, and honest about the silence rather than
  // printing a bare "Running" over eleven days of nothing.
  assert.equal(workingNowStatusLabel({
    membership: 'running', silence: '11d', quiet: true, lifecycle: 'reasoning',
    phase: 'Working through step 4',
  }), 'Working through step 4 · no update in 11d');
});

test('an unknown lifecycle fails closed instead of leaking an internal spelling', () => {
  assert.equal(workingNowLifecycleLabel('new_runtime_state'), 'Status unavailable');
  assert.equal(workingNowLifecycleLabel('blocked'), 'Needs review');
});
