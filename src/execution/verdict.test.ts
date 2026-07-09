/**
 * Run: npx tsx --test src/execution/verdict.test.ts
 *
 * Verdict door (T3-B4): the canonical verdict_recorded audit row, plus the
 * per-door FAIL-POLICY pins the plan requires before any migration — each door
 * fails in a deliberately different direction, and these tests make that
 * contract explicit and unmovable.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CLEMENTINE_HOME = '/tmp/clemmy-test-verdict-door';

const { recordVerdictEvent } = await import('./verdict.js');
const { HarnessSession } = await import('../runtime/harness/session.js');
const { listEvents, resetEventLog } = await import('../runtime/harness/eventlog.js');
const { validateGoal } = await import('./goal-validate.js');
const { judgeWorkflowTarget } = await import('./workflow-objective-judge.js');
const { verifyDelivered } = await import('../runtime/harness/verify-delivered.js');

test('recordVerdictEvent: canonical row lands with only the defined fields', () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  recordVerdictEvent(sess.id, 3, {
    door: 'completion',
    pass: false,
    reason: 'no artifact produced',
    selfJudge: true,
  });
  const rows = listEvents(sess.id, { types: ['verdict_recorded'] });
  assert.equal(rows.length, 1);
  const data = rows[0].data as Record<string, unknown>;
  assert.equal(data.door, 'completion');
  assert.equal(data.pass, false);
  assert.equal(data.reason, 'no artifact produced');
  assert.equal(data.selfJudge, true);
  assert.ok(!('failedOpen' in data), 'undefined fields are omitted, not null-stuffed');
});

test('recordVerdictEvent: NEVER throws — a bad session id is swallowed', () => {
  assert.doesNotThrow(() => recordVerdictEvent('', -1, { door: 'delivery', pass: true }));
});

// ─── Fail-policy pins (per-door, deliberately OPPOSITE directions) ───────────

test('POLICY PIN — goal validation fails STRICT: a dead judge resolves to NOT passed + judgeFailedOpen', async () => {
  const result = await validateGoal(
    { objective: 'do the thing', successCriteria: ['a verifiable thing happened'], evidenceText: 'evidence' },
    { judge: async () => { throw new Error('judge down'); }, fileExists: () => false },
  );
  assert.equal(result.pass, false, 'a dead judge must never auto-satisfy a parked goal');
  assert.equal(result.judgeFailedOpen, true);
});

test('POLICY PIN — workflow target judge fails OPEN: a dead judge resolves to reached (never flips a good 5am run)', async () => {
  const verdict = await judgeWorkflowTarget({
    workflow: { name: 'w', description: 'deliver a report' },
    inputs: {},
    finalOutput: 'the report body',
    judgeFn: async () => { throw new Error('judge down'); },
  });
  assert.equal(verdict.reached, true);
  assert.equal(verdict.judged, false);
});

test('POLICY PIN — delivery verification fails OPEN: a judge hiccup on a promise-shaped reply still delivers, tagged', async () => {
  const verdict = await verifyDelivered(
    'send the summary email',
    "I'll prep that email next.",
    { judgeFn: async () => ({ done: true, reason: 'judge unavailable — accepting completion', failedOpen: true }) },
  );
  assert.equal(verdict.delivered, true, 'fail-open: completion is never blocked by a judge hiccup');
  assert.equal(verdict.verification?.failedOpen, true, 'but the degraded verification is VISIBLE');
});

test('POLICY PIN — delivery verification is deterministic-first: explicit blocked text overrides without any judge call', async () => {
  let judgeCalled = false;
  const verdict = await verifyDelivered(
    'send the summary email',
    'I am blocked on missing credentials for the mail account.',
    { judgeFn: async () => { judgeCalled = true; return { done: true, reason: 'should not run' }; } },
  );
  assert.equal(verdict.delivered, false);
  assert.equal(verdict.blockerType, 'permission');
  assert.equal(judgeCalled, false, 'blocked-text check resolves before any model call');
});
