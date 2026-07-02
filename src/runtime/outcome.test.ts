/**
 * Run: npx tsx --test src/runtime/outcome.test.ts
 *
 * The unified report-back contract (Move 4). Verifies the canonical render
 * (head word + prefix per status, body assembly), the per-lane head-word
 * override (workflow soft-block → "needs attention"), and that deliverOutcome
 * appends ONE structured turn to the origin session, is idempotent, and no-ops
 * with no origin session.
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-outcome-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { renderOutcomeText, deliverOutcome, outcomePrefix } = await import('./outcome.js');
const { SessionStore } = await import('../memory/session-store.js');
const { appendEvent, createSession, listEvents } = await import('./harness/eventlog.js');
const { reconstructHarnessTranscript } = await import('./harness/transcript.js');
const { renderSessionHistoryForModel } = await import('./harness/session-transcript.js');

test.after(() => rmSync(TMP_HOME, { recursive: true, force: true }));

const ctx = (over = {}) => ({
  originSessionId: 'sess-oc',
  sourceLabel: 'background task',
  sourceId: 'bg-1',
  title: 'My Task',
  statusHint: "background_task_status('bg-1')",
  ...over,
});

test('renderOutcomeText: head word + prefix + guidance per status', () => {
  const done = renderOutcomeText({ status: 'done', detail: 'all set' }, ctx());
  assert.ok(done.startsWith('[background task bg-1 completed] My Task'), 'done → completed] head');
  assert.match(done, /just finished/, 'done guidance');
  assert.match(done, /background_task_status\('bg-1'\)/, 'references the status hint');

  assert.ok(renderOutcomeText({ status: 'failed', detail: 'x' }, ctx()).startsWith('[background task bg-1 FAILED]'), 'failed head');
  assert.ok(renderOutcomeText({ status: 'blocked', detail: 'x' }, ctx()).startsWith('[background task bg-1 BLOCKED]'), 'blocked head');
  assert.ok(renderOutcomeText({ status: 'needs_input' }, ctx()).startsWith('[background task bg-1 NEEDS INPUT]'), 'needs_input head');
});

test('renderOutcomeText: assembles summary + truncated detail + guidance', () => {
  const big = 'Z'.repeat(5000);
  const text = renderOutcomeText(
    { status: 'done', summary: 'Sent the email', detail: big },
    ctx({ maxDetailChars: 100 }),
  );
  assert.match(text, /Sent the email/, 'summary present');
  assert.match(text, /…\[truncated\]/, 'long detail truncated to cap');
  assert.ok(!text.includes('Z'.repeat(200)), 'detail actually cut');
  assert.match(text, /\(.+\)\s*$/, 'ends with the guidance parenthetical');
});

test('renderOutcomeText: per-lane head-word override (workflow soft-block → needs attention)', () => {
  const text = renderOutcomeText(
    { status: 'blocked', detail: 'a step flagged a gap' },
    ctx({ sourceLabel: 'workflow run', sourceId: 'wf-9', title: 'My WF', headWord: { blocked: 'needs attention' } }),
  );
  assert.ok(text.startsWith('[workflow run wf-9 needs attention] My WF'), 'uses the override word, keeps the prefix');
});

test('outcomePrefix matches the idempotency/UI-detect prefix exactly', () => {
  assert.equal(outcomePrefix(ctx()), '[background task bg-1 ');
});

test('deliverOutcome: appends ONE role:user turn to the origin session', () => {
  const ok = deliverOutcome({ status: 'done', detail: 'the deliverable' }, ctx({ originSessionId: 'sess-oc-1', sourceId: 'bg-d1' }));
  assert.equal(ok, true);
  const turns = new SessionStore().get('sess-oc-1').turns.filter((t) => typeof t.text === 'string' && t.text.startsWith('[background task bg-d1 '));
  assert.equal(turns.length, 1);
  assert.equal(turns[0].role, 'user');
  assert.match(turns[0].text, /completed]/);
});

test('deliverOutcome: idempotent — a second call does not double-post', () => {
  const c = ctx({ originSessionId: 'sess-oc-2', sourceId: 'bg-d2' });
  assert.equal(deliverOutcome({ status: 'done', detail: 'r' }, c), true, 'first writes');
  assert.equal(deliverOutcome({ status: 'failed', detail: 'r2' }, c), false, 'second (even different status) is a no-op');
  const turns = new SessionStore().get('sess-oc-2').turns.filter((t) => typeof t.text === 'string' && t.text.startsWith('[background task bg-d2 '));
  assert.equal(turns.length, 1, 'exactly one outcome turn for a single source id');
});

test('deliverOutcome: needs_input does not suppress the later terminal report', () => {
  const c = ctx({ originSessionId: 'sess-oc-needs-then-done', sourceId: 'bg-needs-done' });
  assert.equal(deliverOutcome({ status: 'needs_input', detail: 'Which segment?' }, c), true, 'question writes');
  assert.equal(deliverOutcome({ status: 'done', detail: 'Finished after the answer.' }, c), true, 'terminal result still writes');
  assert.equal(deliverOutcome({ status: 'failed', detail: 'late duplicate' }, c), false, 'terminal remains idempotent');

  const turns = new SessionStore().get('sess-oc-needs-then-done').turns
    .filter((t) => typeof t.text === 'string' && t.text.startsWith('[background task bg-needs-done '));
  assert.equal(turns.length, 2);
  assert.match(turns[0].text, /NEEDS INPUT/);
  assert.match(turns[1].text, /completed/);
});

test('deliverOutcome: repeated needs_input dedupes exact replay but allows a later distinct question', () => {
  const c = ctx({ originSessionId: 'sess-oc-two-questions', sourceId: 'bg-two-questions' });
  assert.equal(deliverOutcome({ status: 'needs_input', detail: 'Which segment?' }, c), true, 'first question writes');
  assert.equal(deliverOutcome({ status: 'needs_input', detail: 'Which segment?' }, c), false, 'exact replay dedupes');
  assert.equal(deliverOutcome({ status: 'needs_input', detail: 'Which region?' }, c), true, 'distinct later question writes');

  const turns = new SessionStore().get('sess-oc-two-questions').turns
    .filter((t) => typeof t.text === 'string' && t.text.startsWith('[background task bg-two-questions '));
  assert.equal(turns.length, 2);
  assert.match(turns[0].text, /Which segment/);
  assert.match(turns[1].text, /Which region/);
});

test('deliverOutcome: harness origins receive report-back in eventlog, not a desktop ghost', () => {
  const sessionId = 'sess-oc-harness';
  createSession({ id: sessionId, kind: 'chat', channel: 'desktop', title: 'Harness chat' });

  assert.equal(deliverOutcome(
    { status: 'done', summary: 'counted 9 files' },
    ctx({ originSessionId: sessionId, sourceId: 'bg-h1' }),
  ), true);
  assert.equal(new SessionStore().exists(sessionId), false, 'must not create a sessions.json ghost for a harness chat');

  const reports = listEvents(sessionId, { types: ['user_input_received'] })
    .filter((event) => typeof event.data?.text === 'string' && event.data.text.startsWith('[background task bg-h1 '));
  assert.equal(reports.length, 1);
  assert.match(String(reports[0].data.text), /completed]/);
  assert.equal(reports[0].data.synthetic, true, 'the report-back is flagged synthetic (machine input)');

  // The report-back reaches the MODEL via the eventlog (asserted above), but is
  // HIDDEN from the USER-facing transcript — a synthetic turn is not a user bubble.
  const transcript = reconstructHarnessTranscript(sessionId).map((t) => t.text);
  assert.ok(!transcript.some((text) => text.startsWith('[background task bg-h1 completed]')), 'synthetic report-back is not rendered as a user turn');

  assert.equal(deliverOutcome(
    { status: 'done', summary: 'counted 9 files again' },
    ctx({ originSessionId: sessionId, sourceId: 'bg-h1' }),
  ), false, 'second report-back is idempotent');
});

test('incident replay: failed background report-back survives reopen/model-switch history without legacy ghost shadowing', () => {
  const sessionId = 'sess-oc-incident-replay';
  createSession({ id: sessionId, kind: 'chat', channel: 'desktop', userId: 'user-incident', title: 'Incident replay' });
  appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Run the Sonnet background job using CLIENT-CONTEXT-991.' },
  });
  appendEvent({
    sessionId,
    turn: 1,
    role: 'system',
    type: 'conversation_completed',
    data: { reply: 'Queued the background job for CLIENT-CONTEXT-991.' },
  });

  assert.equal(deliverOutcome(
    { status: 'failed', detail: 'Sonnet 5 background worker failed before producing a verified result.' },
    ctx({ originSessionId: sessionId, sourceId: 'bg-sonnet-failed', title: 'Sonnet background job' }),
  ), true);
  assert.equal(new SessionStore().exists(sessionId), false, 'failed report-back must not create a same-id desktop ghost');

  new SessionStore().appendTurn(sessionId, {
    role: 'user',
    text: '[background task bg-sonnet-failed completed] stale desktop ghost GHOST-SUCCESS-991',
    createdAt: new Date().toISOString(),
  }, 'user-incident', 'desktop');

  const history = renderSessionHistoryForModel(sessionId, 12, 12_000);

  assert.match(history, /CLIENT-CONTEXT-991/);
  assert.match(history, /FAILED/);
  assert.match(history, /Sonnet 5 background worker failed/);
  assert.doesNotMatch(history, /GHOST-SUCCESS-991/);
});

test('deliverOutcome: no origin session → false, no throw', () => {
  assert.equal(deliverOutcome({ status: 'done', detail: 'x' }, ctx({ originSessionId: undefined })), false);
});

test('deliverOutcome: an active goal on the origin session gets a ledger line', async () => {
  const {
    surfacePlan, approvePlanProposal, getPlanProposal, getActiveGoalForSession,
  } = await import('../agents/plan-proposals.js');
  const sessionId = 'sess-oc-goal';
  const p = surfacePlan({
    plan: {
      objective: 'Ship the brief',
      steps: [{ n: 1, action: 'do it', rationale: 'r', verification: null }],
      successCriteria: ['A brief exists.'],
      risks: [], estimatedComplexity: 'moderate', recommendsTrackedExecution: false,
      needsUserInput: [], appliedInstructions: [],
    },
    originatingRequest: 'ship it',
    sessionId,
  });
  approvePlanProposal(p.id, { allowedTools: [] });
  const goalId = getActiveGoalForSession(sessionId)!.id;

  const ok = deliverOutcome(
    { status: 'done', summary: 'scraped 14 rows' },
    ctx({ originSessionId: sessionId, sourceLabel: 'workflow run', sourceId: 'wf-7', title: 'Scrape' }),
  );
  assert.equal(ok, true);
  const ledger = getPlanProposal(goalId)!.progressLedger ?? [];
  assert.ok(
    ledger.some((l) => l.includes('workflow run "Scrape" done') && l.includes('scraped 14 rows')),
    `expected a workflow-outcome ledger line, got ${JSON.stringify(ledger)}`,
  );
});
