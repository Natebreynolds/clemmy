/**
 * Run: npx tsx --test src/runtime/notifications-bulk-read.test.ts
 *
 * THE DEFECT. On the owner's live machine, 2026-09-06: 200 of 200
 * notifications unread. Nothing had ever marked one read and the only verb
 * that existed worked one row at a time, so the count could only ever grow.
 *
 * THE RULE THIS FILE PINS. Clearing is not deciding. A bulk clear marks rows
 * read; it must be structurally incapable of approving, rejecting, or
 * answering anything, whatever set of ids a caller hands it. So the guard
 * lives in the daemon, not only in the phone's filter — and it REPORTS what it
 * held back rather than silently dropping it.
 *
 * Per-test temp CLEMENTINE_HOME so the real store is never touched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-bulk-read-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const {
  addNotification,
  listNotifications,
  markNotificationsRead,
} = await import('./notifications.js');

type NewNotification = Parameters<typeof addNotification>[0];

function add(id: string, metadata: Record<string, unknown> = {}, kind: NewNotification['kind'] = 'execution'): void {
  addNotification({
    id,
    kind,
    title: `test-${id}`,
    body: 'body',
    createdAt: new Date().toISOString(),
    read: false,
    metadata,
  } as NewNotification);
}

function readState(id: string): boolean {
  return listNotifications(500).find((row) => row.id === id)?.read === true;
}

test('a bulk clear reads the finished history and holds back every open decision', () => {
  // The mass of the owner's store: reports of work that already ended. These
  // are exactly rule (2) — tell him once, then they are history.
  add('done-1', { status: 'done', needsAttention: true });
  add('failed-1', { status: 'failed', needsAttention: true });
  add('blocked-1', { status: 'blocked' });
  // ...and the things that genuinely still need an answer.
  add('checkin-1', { checkInId: 'ci-1', status: 'open' });
  add('question-1', { status: 'awaiting_input', questionId: 'q-1' }, 'workflow');
  add('gate-1', {
    status: 'blocked_capability',
    provenNoDispatch: true,
    workflow: 'daily-brief',
    runId: 'run-1',
    stepId: 'step-1',
  }, 'workflow');

  const result = markNotificationsRead([
    'done-1', 'failed-1', 'blocked-1', 'checkin-1', 'question-1', 'gate-1', 'never-existed',
  ]);

  assert.deepEqual(result.cleared.sort(), ['blocked-1', 'done-1', 'failed-1']);
  assert.deepEqual(
    [...result.held].sort((a, b) => a.id.localeCompare(b.id)),
    [
      { id: 'checkin-1', reason: 'awaiting_you' },
      { id: 'gate-1', reason: 'capability_gate' },
      { id: 'never-existed', reason: 'not_found' },
      { id: 'question-1', reason: 'awaiting_you' },
    ],
  );
  // And the store agrees — the held rows are still unread and still there.
  assert.equal(readState('done-1'), true);
  assert.equal(readState('blocked-1'), true);
  assert.equal(readState('checkin-1'), false, 'an open check-in cannot be cleared away');
  assert.equal(readState('question-1'), false, 'an unanswered question cannot be cleared away');
  assert.equal(readState('gate-1'), false, 'a parked run keeps its only chooser');
});

test('clearing is idempotent, deduped, and bounded by nothing the caller says', () => {
  add('twice-1', { status: 'completed' });
  const first = markNotificationsRead(['twice-1', 'twice-1', '  twice-1  ']);
  assert.deepEqual(first.cleared, ['twice-1'], 'the same id asked three times is one row');
  const second = markNotificationsRead(['twice-1']);
  assert.deepEqual(second.cleared, ['twice-1'], 'clearing an already-read row is a success, not an error');
  assert.deepEqual(second.held, []);
  assert.deepEqual(markNotificationsRead([]), { cleared: [], held: [] });
  assert.deepEqual(markNotificationsRead(['', '   ']), { cleared: [], held: [] });
});

test('a settled gate stops being held back — the marker is the later fact', () => {
  add('gate-2', {
    status: 'blocked_capability',
    provenNoDispatch: true,
    capabilitySettledAt: new Date().toISOString(),
  }, 'workflow');
  const result = markNotificationsRead(['gate-2']);
  assert.deepEqual(result.cleared, ['gate-2']);
  assert.equal(readState('gate-2'), true);
});

// ─── THE FLOOR IS THE DAEMON, not the client's pre-filter ────────────────────

test('a live proposal is held back by the daemon, not by whoever happens to call it', () => {
  // The carrier for a genuinely pending approval, plan, or trust proposal, with
  // no awaiting-shaped status of its own. Before this, classifyNotification was
  // called with no live referents, so hasPendingProposal always answered false
  // and these three cleared — hidden by any caller that asked. The phone
  // stripped them first, which made the app safe and the ROUTE not.
  add('approval-live', { approvalId: 'ap-live' });
  add('plan-live', { planProposalId: 'pl-live' });
  add('trust-live', { trustProposalId: 'tr-live' });

  const live = markNotificationsRead(['approval-live', 'plan-live', 'trust-live'], {
    approvalPending: (id) => id === 'ap-live',
    planPending: (id) => id === 'pl-live',
    trustPending: (id) => id === 'tr-live',
  });
  assert.deepEqual(live.cleared, []);
  assert.deepEqual(
    [...live.held].sort((a, b) => a.id.localeCompare(b.id)),
    [
      { id: 'approval-live', reason: 'awaiting_you' },
      { id: 'plan-live', reason: 'awaiting_you' },
      { id: 'trust-live', reason: 'awaiting_you' },
    ],
  );
  assert.equal(readState('approval-live'), false, 'the carrier for a live decision stays on screen');
  assert.equal(readState('plan-live'), false);
  assert.equal(readState('trust-live'), false);
});

test('a settled proposal clears normally once the caller can say it is settled', () => {
  add('approval-settled', { approvalId: 'ap-old' });
  add('plan-settled', { planProposalId: 'pl-old' });
  add('trust-settled', { trustProposalId: 'tr-old' });
  const result = markNotificationsRead(
    ['approval-settled', 'plan-settled', 'trust-settled'],
    { approvalPending: () => false, planPending: () => false, trustPending: () => false },
  );
  assert.deepEqual(result.cleared.sort(), ['approval-settled', 'plan-settled', 'trust-settled']);
  assert.deepEqual(result.held, []);
  assert.equal(readState('approval-settled'), true, 'history does not become permanently unclearable');
});

test('a caller that cannot check liveness gets a hold, not a silent clear', () => {
  // The future client the review is really about: it calls the route with an
  // id list and no pending sets. Unknown liveness is not a licence to hide the
  // only carrier for a decision — and marking read decides nothing either way,
  // so holding is the reversible direction.
  add('approval-unknown', { approvalId: 'ap-?' });
  add('plan-unknown', { planProposalId: 'pl-?' });
  add('trust-unknown', { trustProposalId: 'tr-?' });
  const blind = markNotificationsRead(['approval-unknown', 'plan-unknown', 'trust-unknown']);
  assert.deepEqual(blind.cleared, []);
  assert.deepEqual(blind.held.map((row) => row.reason), ['awaiting_you', 'awaiting_you', 'awaiting_you']);

  // A partially informed caller fails closed on exactly the referent it cannot
  // answer for, and no further.
  add('approval-half', { approvalId: 'ap-half' });
  add('plan-half', { planProposalId: 'pl-half' });
  const half = markNotificationsRead(['approval-half', 'plan-half'], { approvalPending: () => false });
  assert.deepEqual(half.cleared, ['approval-half']);
  assert.deepEqual(half.held, [{ id: 'plan-half', reason: 'awaiting_you' }]);
});

test('a plain finished report still clears with no referents at all', () => {
  // The fail-closed rule must not swallow the 111 restart notices the bulk bar
  // exists for: it fires only on a row that NAMES a proposal.
  add('interrupted-1', { status: 'error' }, 'system');
  add('finished-1', { status: 'completed' });
  const result = markNotificationsRead(['interrupted-1', 'finished-1']);
  assert.deepEqual(result.cleared.sort(), ['finished-1', 'interrupted-1']);
  assert.deepEqual(result.held, []);
});

test('the bulk-read ROUTE is the caller that supplies the pending sets', () => {
  // The floor can only tell live from settled if the route says so, and the
  // route is the only door to it. Pin the wiring, not just the capability:
  // the last round shipped a correct function nothing called.
  const routes = readFileSync(
    new URL('../channels/mobile-routes.ts', import.meta.url),
    'utf8',
  );
  const start = routes.indexOf("router.post('/api/inbox/notifications/read'");
  assert.ok(start > 0, 'the bulk-read route must still exist');
  const after = routes.indexOf('router.', start + 20);
  const call = routes.slice(start, after > start ? after : routes.length);
  assert.match(call, /markNotificationsRead\(ids, \{/);
  assert.match(call, /approvalPending: \(id\) => pendingApprovalIds\.has\(id\)/);
  assert.match(call, /planPending: \(id\) => pendingPlanIds\.has\(id\)/);
  assert.match(call, /trustPending: \(id\) => pendingTrustIds\.has\(id\)/);
  // The same three sets /api/inbox/summary passes, resolved the same way.
  assert.match(call, /approvalRegistry\.isFormalApprovalSurface/);
  assert.match(call, /listPlanProposals\(\{ status: 'pending', limit: 100 \}\)/);
  assert.match(call, /listTrustProposals\('pending'\)/);
});
