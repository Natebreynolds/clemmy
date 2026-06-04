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

test('deliverOutcome: no origin session → false, no throw', () => {
  assert.equal(deliverOutcome({ status: 'done', detail: 'x' }, ctx({ originSessionId: undefined })), false);
});
