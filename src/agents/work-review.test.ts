/**
 * Run: npx tsx --test src/agents/work-review.test.ts
 *
 * The work-review heartbeat's contract:
 *   - a failed run is raised once; a fresh wait is not, a long wait is
 *   - a one-step try never counts as work
 *   - the owner's rules, applied by Jev, skip an item; the judge budget holds the rest
 *   - quiet mode keeps items in the app; push mode lets them travel
 *   - an item retires when what it points at resolves; a quiet tick costs no model call
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_WORK_REVIEW_CONFIG,
  buildWorkReviewNotification,
  deriveWorkReviewCandidates,
  emptyWorkReviewState,
  runWorkReviewTick,
  type WorkObservation,
  type WorkReviewCandidate,
  type WorkReviewJudgeVerdict,
  type WorkReviewState,
} from './work-review.js';
import type { NotificationRecord } from '../runtime/notifications.js';

const NOW = Date.parse('2026-09-26T17:00:00.000Z');
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
const H = 60 * 60 * 1000;

const observation: WorkObservation = {
  runs: [
    { runId: 'r-fail', workflow: 'friday-dashboard-daily-refresh', status: 'failed', createdAt: iso(-3 * H), finishedAt: iso(-3 * H + 60_000), error: 'Salesforce query timed out after 3 retries' },
    { runId: 'r-ok', workflow: 'end-of-day', status: 'completed', createdAt: iso(-10 * H), finishedAt: iso(-10 * H + 45_000) },
    { runId: 'r-try', workflow: 'FRAMEWORK-TEST fixture', status: 'failed', createdAt: iso(-1 * H), finishedAt: iso(-1 * H), targetStepId: 'collect', error: 'try failed' },
    { runId: 'r-wait-old', workflow: 'weekly-review', status: 'parked', createdAt: iso(-5 * H) },
    { runId: 'r-wait-old-2', workflow: 'weekly-review', status: 'blocked', createdAt: iso(-3 * H) },
    { runId: 'r-wait-new', workflow: 'morning-briefing', status: 'parked', createdAt: iso(-20 * 60_000) },
    { runId: 'r-ancient', workflow: 'quarter-close', status: 'blocked', createdAt: iso(-30 * 24 * H) },
    { runId: 'r-error', workflow: 'inbox-sweep', status: 'error', createdAt: iso(-2 * H), finishedAt: iso(-2 * H + 30_000), error: 'IMAP login refused' },
    { runId: 'r-test', workflow: 'inbox-sweep', status: 'creation_test', createdAt: iso(-1 * H) },
  ],
  chats: [
    { runId: 'c-old', sessionId: 's1', title: 'Send the leadership email', status: 'awaiting_approval', updatedAt: iso(-26 * H), waitingOn: 'approval' },
    { runId: 'c-new', sessionId: 's2', title: 'Which account?', status: 'awaiting_input', updatedAt: iso(-10 * 60_000), waitingOn: 'input' },
    { runId: 'c-standup-1', sessionId: 's3', title: 'Workflow: daily-standup-email', status: 'awaiting_input', updatedAt: iso(-48 * H), waitingOn: 'input' },
    { runId: 'c-standup-2', sessionId: 's4', title: 'Workflow: daily-standup-email', status: 'awaiting_input', updatedAt: iso(-72 * H), waitingOn: 'input' },
  ],
  drafts: [
    { name: 'weekly-workflow-priorities-2026-09-28.md', dir: 'drafts', modifiedAt: iso(-9 * H), bytes: 715 },
    { name: 'just-now.md', dir: 'drafts', modifiedAt: iso(-5 * 60_000), bytes: 12 },
  ],
};

test('candidates: failures and long waits are raised, grouped by what they are about; fresh waits, clean runs, tests, one-step tries and ancient waits are not', () => {
  const c = deriveWorkReviewCandidates(observation, DEFAULT_WORK_REVIEW_CONFIG, NOW, null);
  assert.deepEqual(c.map((x) => x.key).sort(), [
    'chat_waiting:send the leadership email',
    'chat_waiting:workflow: daily-standup-email',
    'draft_unsent:drafts/weekly-workflow-priorities-2026-09-28.md',
    'run_failed:r-error',
    'run_failed:r-fail',
    'run_waiting:weekly-review',
  ]);
  const failed = c.find((x) => x.key === 'run_failed:r-fail')!;
  assert.match(failed.detail, /friday-dashboard-daily-refresh failed 3 h ago: Salesforce query timed out/);
  assert.match(failed.offer, /look at what went wrong/);
  assert.match(c.find((x) => x.key === 'run_failed:r-error')!.detail, /inbox-sweep failed 2 h ago: IMAP login refused/, 'a record stored as error is a failure');
  const wait = c.find((x) => x.kind === 'run_waiting')!;
  assert.match(wait.detail, /2 runs of weekly-review are waiting on you, the oldest since 5 h ago/);
  assert.deepEqual(wait.refs, ['r-wait-old', 'r-wait-old-2']);
  const standup = c.find((x) => x.key === 'chat_waiting:workflow: daily-standup-email')!;
  assert.equal(standup.count, 2);
  assert.match(standup.detail, /2 conversations about "Workflow: daily-standup-email" are waiting for your answer, the oldest since 3 days ago/);
  // A failure older than the last tick is not raised again on the next tick.
  const later = deriveWorkReviewCandidates(observation, DEFAULT_WORK_REVIEW_CONFIG, NOW, NOW - 60 * 60_000);
  assert.equal(later.some((x) => x.kind === 'run_failed'), false);
});

function harness(opts: {
  state?: WorkReviewState;
  rules?: string[];
  notify?: 'quiet' | 'push';
  judge?: (c: WorkReviewCandidate) => Promise<WorkReviewJudgeVerdict | null>;
  obs?: WorkObservation;
  readIds?: Set<string>;
  now?: number;
}) {
  const published: NotificationRecord[] = [];
  const markedRead: string[] = [];
  let state = opts.state ?? emptyWorkReviewState();
  let judgeCalls = 0;
  const deps = {
    now: () => opts.now ?? NOW,
    tickId: 't1',
    source: 'test',
    config: DEFAULT_WORK_REVIEW_CONFIG,
    rules: opts.rules ?? [],
    notify: opts.notify ?? ('quiet' as const),
    observe: async () => ({ observation: opts.obs ?? observation, readFailures: 0 }),
    judge: opts.judge ? async (c: WorkReviewCandidate) => { judgeCalls += 1; return opts.judge!(c); } : undefined,
    publish: (n: NotificationRecord) => { published.push(n); },
    isNotificationRead: (id: string) => opts.readIds?.has(id) ?? false,
    markNotificationRead: (id: string) => { markedRead.push(id); },
    loadState: () => state,
    saveState: (s: WorkReviewState) => { state = s; },
  };
  return { deps, published, markedRead, get state() { return state; }, get judgeCalls() { return judgeCalls; } };
}

test('a tick raises each new item once, quietly by default, and a second tick is quiet', async () => {
  const h = harness({});
  const first = await runWorkReviewTick(h.deps);
  assert.equal(first.produced, 6);
  assert.equal(first.quiet, false);
  assert.equal(h.published.length, 6);
  for (const n of h.published) {
    assert.equal(n.metadata?.needsAttention, true);
    assert.equal(n.metadata?.inboxOnly, true, 'quiet mode stays in the app');
    assert.equal(n.metadata?.heartbeatId, 'work-review');
  }
  assert.match(h.published[0].title, /^Run failed: /, 'failures first');
  assert.match(h.published[0].body, /I can look at what went wrong/);
  assert.equal(h.judgeCalls, 0, 'no rules, no model call');

  // Half an hour later nothing new has aged into view (the fresh draft needs an hour).
  const second = await runWorkReviewTick({ ...h.deps, tickId: 't2', now: () => NOW + 30 * 60_000 });
  assert.equal(second.produced, 0);
  assert.equal(second.quiet, true);
  assert.equal(h.published.length, 6);
  assert.equal(h.state.metrics.quietTicks, 1);
  assert.equal(h.state.metrics.duplicatesSuppressed, 4, 'the waits and the draft were seen again; the failures aged out of the window');
});

test("the owner's rules skip an item through Jev, and the judge budget holds what it cannot judge", async () => {
  const h = harness({
    rules: ['Skip anything about drafts; I file those myself on Fridays.'],
    judge: async (c) => (c.kind === 'draft_unsent' ? { surface: false, confidence: 0.9, model: 'jev', durationMs: 5 } : { surface: true, confidence: 0.9, model: 'jev', durationMs: 5 }),
  });
  const tick = await runWorkReviewTick(h.deps);
  assert.equal(tick.vetoed, 1);
  assert.equal(tick.produced, 5);
  assert.equal(h.judgeCalls, 6);
  const skipped = h.state.items['draft_unsent:drafts/weekly-workflow-priorities-2026-09-28.md'];
  assert.equal(skipped.retiredReason, 'jev_skip');
  assert.equal(h.published.some((n) => /Unsent draft/.test(n.title)), false);

  // Budget: two judge calls per tick → the rest wait, unjudged and unraised.
  const tight = harness({ rules: ['any rule'], judge: async () => ({ surface: true, confidence: 0.9, model: 'jev', durationMs: 1 }) });
  tight.deps.config = { ...DEFAULT_WORK_REVIEW_CONFIG, maxJudgeCallsPerTick: 2 };
  const t = await runWorkReviewTick(tight.deps);
  assert.equal(t.produced, 2);
  assert.equal(t.held, 4);
  assert.ok(t.items.every((i) => i.kind === 'run_failed'), 'the budget goes to failures first');
  assert.equal(tight.state.metrics.heldForBudget, 4);
  // Jev unavailable: the item is kept, not dropped.
  const dark = harness({ rules: ['any rule'], judge: async () => null });
  const d = await runWorkReviewTick(dark.deps);
  assert.equal(d.produced, 6);
});

test('a rule added later quiets the open items it covers; removing it brings them back; nothing is judged twice against the same rules', async () => {
  const h = harness({});
  const first = await runWorkReviewTick(h.deps);
  assert.equal(first.produced, 6);
  const draftKey = 'draft_unsent:drafts/weekly-workflow-priorities-2026-09-28.md';
  const draftCard = h.state.items[draftKey].notificationId!;

  // The owner says, in chat, to stop raising drafts. Next tick: the open draft item goes quiet.
  let calls = 0;
  const judge = async (c: WorkReviewCandidate): Promise<WorkReviewJudgeVerdict> => { calls += 1; return { surface: c.kind !== 'draft_unsent', confidence: 0.9, model: 'jev', durationMs: 3 }; };
  const withRule = { ...h.deps, tickId: 't2', now: () => NOW + 20 * 60_000, rules: ['Stop telling me about unsent drafts; I file those myself.'], rulesUpdatedAt: iso(10 * 60_000), judge };
  const second = await runWorkReviewTick(withRule);
  // Failures are raised once and are not live afterwards; the four waits and drafts are.
  assert.equal(second.reconsidered, 4, 'every live item is judged once against the new rules');
  assert.equal(calls, 4);
  assert.equal(h.state.items[draftKey].retiredReason, 'jev_skip');
  assert.ok(h.markedRead.includes(draftCard), 'the quieted card leaves Needs you');
  assert.match(second.summary, /1 now skipped by your rules/);
  assert.equal(h.state.items['run_failed:r-fail'].retiredAt, undefined);
  assert.equal(h.state.items['run_failed:r-fail'].judgedAt, undefined, 'a failure already shown is not re-judged');
  assert.equal(h.state.items['run_waiting:weekly-review'].judgedAt, iso(20 * 60_000));

  // Same rules, another tick: nothing is judged again.
  const third = await runWorkReviewTick({ ...withRule, tickId: 't3', now: () => NOW + 30 * 60_000 });
  assert.equal(third.reconsidered, 0);
  assert.equal(calls, 4);
  assert.equal(third.quiet, true);

  // The owner removes the rule. No rules means nothing to ask Jev: the draft item comes back on its own.
  const before = h.published.length;
  const fourth = await runWorkReviewTick({ ...withRule, tickId: 't4', now: () => NOW + 50 * 60_000, rules: [], rulesUpdatedAt: iso(40 * 60_000) });
  assert.equal(calls, 4);
  assert.equal(h.state.items[draftKey].retiredAt, undefined);
  assert.notEqual(h.state.items[draftKey].notificationId, draftCard, 'a fresh card, the old one was read');
  assert.equal(h.published.length, before + 1);
  assert.match(fourth.summary, /1 back after a rule change/);
  assert.equal(fourth.reconsidered, 4);
});

test('push mode lets an item travel; an item retires when what it points at resolves; a read card is acknowledged', async () => {
  const h = harness({ notify: 'push' });
  await runWorkReviewTick(h.deps);
  assert.equal(h.published[0].metadata?.inboxOnly, undefined);
  const waitId = h.state.items['run_waiting:weekly-review'].notificationId!;
  // Both parked weekly-review runs resumed and the old chat was answered.
  const resolved: WorkObservation = {
    ...observation,
    runs: observation.runs.filter((r) => r.workflow !== 'weekly-review'),
    chats: observation.chats.filter((c) => c.runId !== 'c-old'),
  };
  const second = await runWorkReviewTick({ ...h.deps, tickId: 't2', now: () => NOW + 30 * 60_000, observe: async () => ({ observation: resolved, readFailures: 0 }), isNotificationRead: (id) => id === waitId });
  assert.equal(second.retired, 2);
  assert.equal(h.state.items['run_waiting:weekly-review'].retiredReason, 'resolved');
  assert.equal(h.state.items['chat_waiting:send the leadership email'].retiredReason, 'resolved');
  assert.ok(h.markedRead.includes(h.state.items['chat_waiting:send the leadership email'].notificationId!), 'a resolved item leaves Needs you');
  assert.equal(h.state.items['run_waiting:weekly-review'].acknowledgedAt !== undefined, true);
  assert.equal(h.state.metrics.itemsAcknowledged, 1);
  // A failure never retires by absence: the record stays failed, and the owner saw it.
  assert.equal(h.state.items['run_failed:r-fail'].retiredAt, undefined);
});

test('the notification reads as the item, and a read failure is a recorded error, not an exception', async () => {
  const c = deriveWorkReviewCandidates(observation, DEFAULT_WORK_REVIEW_CONFIG, NOW, null).find((x) => x.kind === 'chat_waiting')!;
  const n = buildWorkReviewNotification(c, iso(0), 'quiet');
  assert.equal(n.title, 'Still waiting: Send the leadership email');
  assert.match(n.body, /waiting for your approval since 26 h ago/);
  assert.equal(n.kind, 'execution');
  const h = harness({});
  h.deps.observe = async () => { throw new Error('disk gone'); };
  const tick = await runWorkReviewTick(h.deps);
  assert.equal(tick.quiet, true);
  assert.match(tick.summary, /read failed \(disk gone\)/);
  assert.equal(h.state.lastError?.reason, 'disk gone');
});
