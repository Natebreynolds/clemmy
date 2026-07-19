/**
 * Run: npx tsx --test src/memory/focus.test.ts
 *
 * Storage invariants for current_focus:
 *   - single-active enforced (partial unique index + parkActiveIfPresent)
 *   - park / activate / touch / clear lifecycle is deterministic
 *   - needsConfirm flips when confirm_after has elapsed
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-focus-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { resetMemoryDb } = await import('./db.js');
const {
  createFocus,
  getActiveFocus,
  listFocuses,
  listParkedFocuses,
  touchFocus,
  parkFocus,
  activateFocus,
  clearFocus,
  getFocusSnapshot,
  checkResourceMatchesFocus,
  extractNamedResource,
} = await import('./focus.js');

test('createFocus: inserts an active row', () => {
  resetMemoryDb();
  const focus = createFocus({
    resourceRef: 'https://docs.google.com/spreadsheets/d/1JTq',
    title: 'Q2 2026 Priority Account Refresh',
    summary: 'Editing dropdowns in the Alexander - Legal tab',
    resourceKind: 'sheet',
  });
  assert.equal(focus.status, 'active');
  assert.equal(focus.title, 'Q2 2026 Priority Account Refresh');
  assert.ok(focus.confirm_after > focus.created_at, 'confirm_after must be in the future');
});

test('createFocus staleOnCreate is born needsConfirm (auto-pin must be verified)', () => {
  resetMemoryDb();
  createFocus({
    resourceRef: 'res-stale-pin',
    title: 'Auto-pinned guess',
    summary: 'Inferred from prior-session tool calls.',
    staleOnCreate: true,
  });
  assert.equal(getFocusSnapshot().needsConfirm, true, 'a born-stale auto-pin must render under verify-before-rely');
});

test('createFocus without staleOnCreate is authoritative (not needsConfirm) at birth', () => {
  resetMemoryDb();
  createFocus({ resourceRef: 'res-fresh-pin', title: 'Confirmed', summary: 'User named this resource.' });
  assert.equal(getFocusSnapshot().needsConfirm, false);
});

test('extractNamedResource: URL id, bare long id, and ignores ordinary text', () => {
  assert.equal(
    extractNamedResource('use https://docs.google.com/spreadsheets/d/fixture_google_sheet_0000000002/edit'),
    'fixture_google_sheet_0000000002',
  );
  assert.equal(
    extractNamedResource('sheet id 1A2B3C4D5E6F7G8H9I0J1K2L3M4N5O6P7Q8R9S0T'),
    '1A2B3C4D5E6F7G8H9I0J1K2L3M4N5O6P7Q8R9S0T',
  );
  assert.equal(extractNamedResource('send to the usual list'), null);
  assert.equal(extractNamedResource(undefined), null);
});

test('single-active invariant: creating a 2nd focus parks the 1st', () => {
  resetMemoryDb();
  const first = createFocus({
    resourceRef: 'https://docs.google.com/spreadsheets/d/1JTq',
    title: 'Q2 sheet',
    summary: 'tab work',
  });
  const second = createFocus({
    resourceRef: 'https://example.com/proposal-x',
    title: 'Proposal X',
    summary: 'drafting cover letter',
  });
  assert.equal(second.status, 'active');

  const all = listFocuses();
  assert.equal(all.length, 2);
  const refreshed = all.find((f) => f.id === first.id)!;
  assert.equal(refreshed.status, 'paused');
  assert.equal(refreshed.parked_reason, 'replaced by new focus');
});

test('touchFocus: extends confirm_after only when active', () => {
  resetMemoryDb();
  const focus = createFocus({
    resourceRef: 'sess-test',
    title: 'Test',
    summary: 'something',
  });
  const before = focus.confirm_after;
  // Force time forward by mutating env-driven confirm window
  process.env.CLEMMY_FOCUS_CONFIRM_MS = '999999999';
  try {
    const touched = touchFocus(focus.id)!;
    assert.ok(touched.confirm_after > before, 'confirm_after should extend on touch');
  } finally {
    delete process.env.CLEMMY_FOCUS_CONFIRM_MS;
  }
});

test('park + activate: round-trip preserves history', () => {
  resetMemoryDb();
  const a = createFocus({ resourceRef: 'a', title: 'A', summary: 'one' });
  const b = createFocus({ resourceRef: 'b', title: 'B', summary: 'two' });
  // a is now parked, b is active
  parkFocus(b.id, 'user paused');
  assert.equal(getActiveFocus(), null, 'no active after parking the only active');
  const activated = activateFocus(a.id)!;
  assert.equal(activated.status, 'active');
  assert.equal(activated.parked_at, null);
});

test('activateFocus: refuses completed/abandoned rows', () => {
  resetMemoryDb();
  const focus = createFocus({ resourceRef: 'a', title: 'A', summary: 'one' });
  clearFocus(focus.id, 'completed');
  const result = activateFocus(focus.id);
  assert.equal(result, null, 'completed rows cannot reactivate');
});

test('listParkedFocuses: only parked, newest first', () => {
  resetMemoryDb();
  const a = createFocus({ resourceRef: 'a', title: 'A', summary: 'one' });
  const b = createFocus({ resourceRef: 'b', title: 'B', summary: 'two' }); // a is now parked
  const c = createFocus({ resourceRef: 'c', title: 'C', summary: 'three' }); // a + b are parked
  const parked = listParkedFocuses();
  assert.equal(parked.length, 2);
  // b was parked AFTER a, so b comes first
  assert.equal(parked[0].id, b.id);
  assert.equal(parked[1].id, a.id);
  // c is active, not in parked list
  assert.ok(!parked.find((f) => f.id === c.id));
});

test('getFocusSnapshot: needsConfirm true when confirm_after elapsed', () => {
  resetMemoryDb();
  process.env.CLEMMY_FOCUS_CONFIRM_MS = '1'; // 1 ms — immediately stale
  try {
    createFocus({ resourceRef: 'a', title: 'A', summary: 'one' });
    // Tiny pause so confirm_after passes
    const start = Date.now();
    while (Date.now() - start < 5) { /* spin */ }
    const snap = getFocusSnapshot();
    assert.ok(snap.active, 'active focus should still be present');
    assert.equal(snap.needsConfirm, true);
  } finally {
    delete process.env.CLEMMY_FOCUS_CONFIRM_MS;
  }
});

test('getFocusSnapshot: needsConfirm false when fresh', () => {
  resetMemoryDb();
  createFocus({ resourceRef: 'a', title: 'A', summary: 'one' });
  const snap = getFocusSnapshot();
  assert.equal(snap.needsConfirm, false);
  assert.equal(snap.active?.title, 'A');
});

test('checkResourceMatchesFocus ignores stale focus that needs confirmation', () => {
  resetMemoryDb();
  process.env.CLEMMY_FOCUS_CONFIRM_MS = '1';
  try {
    createFocus({ resourceRef: 'sheet-a', title: 'A', summary: 'one' });
    const start = Date.now();
    while (Date.now() - start < 5) { /* spin */ }
    assert.deepEqual(checkResourceMatchesFocus('sheet-b'), { result: 'unknown' });
  } finally {
    delete process.env.CLEMMY_FOCUS_CONFIRM_MS;
  }
});

process.on('exit', () => {
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
});
