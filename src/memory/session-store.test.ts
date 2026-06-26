/**
 * Run: npx tsx --test src/memory/session-store.test.ts
 *
 * Contracts the desktop chat SessionStore must keep for the
 * Conversations feature:
 *   - first user turn auto-titles the session (once, never overwritten)
 *   - setMeta updates organize fields and never creates a phantom record
 *   - delete removes a session
 *   - listAll returns everything newest-first
 *   - records written without the new optional fields still load
 *
 * Isolated via per-test CLEMENTINE_HOME so the user's real
 * ~/.clementine-next/state/sessions.json is never touched.
 */
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-session-store-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Dynamic import AFTER CLEMENTINE_HOME is set so BASE_DIR is correct.
const { SessionStore } = await import('./session-store.js');

const turn = (role: 'user' | 'assistant', text: string) => ({
  role,
  text,
  createdAt: new Date().toISOString(),
});

test('first user turn auto-titles the session, then never overwrites', () => {
  const store = new SessionStore();
  store.appendTurn('sess-auto', turn('user', 'Can you draft a follow-up email to the Revill firm?'));
  let rec = store.get('sess-auto');
  assert.equal(rec.title, 'draft a follow-up email to the Revill firm?');

  // A second user turn must NOT change the title.
  store.appendTurn('sess-auto', turn('user', 'Actually make it shorter'));
  rec = store.get('sess-auto');
  assert.equal(rec.title, 'draft a follow-up email to the Revill firm?');
});

test('setMeta updates organize fields and bumps updatedAt', () => {
  const store = new SessionStore();
  const before = '2020-01-01T00:00:00.000Z';
  store.upsert({ id: 'sess-meta', createdAt: before, updatedAt: before, turns: [] });

  const updated = store.setMeta('sess-meta', {
    title: 'Custom title',
    pinned: true,
    tags: ['work', 'work', 'Work', '  spaced  '],
    archived: true,
  });
  assert.ok(updated);
  assert.equal(updated!.title, 'Custom title');
  assert.equal(updated!.pinned, true);
  assert.equal(updated!.archived, true);
  // De-duped (case-insensitive) and trimmed.
  assert.deepEqual(updated!.tags, ['work', 'spaced']);
  assert.ok(updated!.updatedAt > before);
});

test('setMeta returns null for an unknown id and creates no phantom record', () => {
  const store = new SessionStore();
  const result = store.setMeta('sess-does-not-exist', { pinned: true });
  assert.equal(result, null);
  assert.equal(store.exists('sess-does-not-exist'), false);
});

test('delete removes a session', () => {
  const store = new SessionStore();
  store.appendTurn('sess-del', turn('user', 'temp'));
  assert.equal(store.exists('sess-del'), true);
  assert.equal(store.delete('sess-del'), true);
  assert.equal(store.exists('sess-del'), false);
  assert.equal(store.delete('sess-del'), false);
});

test('listAll returns every session newest-first', () => {
  const store = new SessionStore();
  // Explicit, distinct timestamps so ordering is deterministic.
  store.upsert({ id: 'sess-a', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', turns: [] });
  store.upsert({ id: 'sess-b', createdAt: '2026-01-02T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z', turns: [] });
  const ids = store.listAll().map((s) => s.id);
  assert.ok(ids.includes('sess-a'));
  assert.ok(ids.includes('sess-b'));
  // b is newer, so it sorts first.
  assert.equal(ids.indexOf('sess-b') < ids.indexOf('sess-a'), true);
});

// Self-contained: writes its own corrupt file and asserts recovery, so it
// neither depends on nor (durably) disturbs the other tests' state.
test('a corrupt sessions.json is quarantined, not clobbered, and the store recovers', () => {
  const stateDir = path.join(TMP_HOME, 'state');
  const file = path.join(stateDir, 'sessions.json');
  // Simulate a torn write — half a JSON object that JSON.parse can't read.
  writeFileSync(file, '{ "sess-x": { "id": "sess-x", "turns": [');

  const store = new SessionStore();
  // Load must not throw and must start fresh rather than crashing the turn.
  assert.deepEqual(store.listAll(), []);

  // The unreadable bytes were preserved aside (recoverable), not overwritten.
  const quarantined = readdirSync(stateDir).filter((f) => f.startsWith('sessions.json.corrupt-'));
  assert.equal(quarantined.length >= 1, true);

  // A subsequent write succeeds, leaves valid JSON, and litters no temp file.
  store.upsert({
    id: 'sess-y',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    turns: [],
  });
  assert.equal(store.exists('sess-y'), true);
  assert.equal(readdirSync(stateDir).some((f) => f.includes('sessions.json.tmp.')), false);
});

test('records without the new optional fields still load', () => {
  // Simulate a pre-feature sessions.json record (no title/pinned/tags/archived).
  const file = path.join(TMP_HOME, 'state', 'sessions.json');
  const now = new Date().toISOString();
  writeFileSync(
    file,
    JSON.stringify({
      'legacy-1': { id: 'legacy-1', createdAt: now, updatedAt: now, turns: [] },
    }),
  );
  const store = new SessionStore();
  const rec = store.get('legacy-1');
  assert.equal(rec.id, 'legacy-1');
  assert.equal(rec.title, undefined);
  // setMeta works on a legacy record.
  const updated = store.setMeta('legacy-1', { pinned: true });
  assert.equal(updated!.pinned, true);
});
