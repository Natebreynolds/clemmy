/** Run with scripts/run-tests-isolated.mjs. No provider or live-home access. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-conversation-state-v94-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
const schema = await import('./eventlog-schema.js');
const eventlog = await import('./eventlog.js');
const { HarnessSession } = await import('./session.js');
test.after(() => { eventlog.closeEventLog(); rmSync(TEST_HOME, { recursive: true, force: true }); });
const NOW = '2026-10-15T04:00:00.000Z';

test('v94 moves each conversation out of the session row byte for byte and leaves every other key and the update time', () => {
  const db = new Database(path.join(TEST_HOME, 'historical.db'));
  try {
    db.pragma('foreign_keys=ON');
    schema.applyHarnessMigrationsThroughVersionForTests(db, 93);
    const conversation = { items: [{ role: 'user', content: 'Find the ORCHARD fixture' }, { role: 'assistant', content: [{ type: 'output_text', text: 'Found it.' }] }],
      lastResponseId: 'resp_1', updatedAt: '2026-10-01T00:00:00.000Z' };
    const insert = db.prepare("INSERT INTO sessions (id,kind,created_at,updated_at,status,metadata_json) VALUES (?,'chat',?,?,'completed',?)");
    insert.run('with-state', NOW, NOW, JSON.stringify({ pinned: true, __conversation: conversation, __interrupt_state: 'parked' }));
    insert.run('without-state', NOW, NOW, JSON.stringify({ tags: ['kept'] }));
    insert.run('malformed-state', NOW, NOW, JSON.stringify({ __conversation: 'not an object' }));
    const before = db.prepare("SELECT json_extract(metadata_json, '$.__conversation') AS c FROM sessions WHERE id = 'with-state'").get() as { c: string };
    schema.applyHarnessMigrations(db);
    const moved = db.prepare("SELECT * FROM session_conversation_state WHERE session_id = 'with-state'").get() as Record<string, unknown>;
    assert.equal(moved.state_json, before.c, 'the stored text is the text the row held');
    assert.equal(moved.fidelity, 'full');
    assert.equal(moved.updated_at, conversation.updatedAt);
    const rows = db.prepare('SELECT id, updated_at, metadata_json FROM sessions ORDER BY id').all() as Array<{ id: string; updated_at: string; metadata_json: string }>;
    assert.deepEqual(rows.map((row) => [row.id, row.updated_at, JSON.parse(row.metadata_json)]), [
      ['malformed-state', NOW, {}],
      ['with-state', NOW, { pinned: true, __interrupt_state: 'parked' }],
      ['without-state', NOW, { tags: ['kept'] }],
    ]);
    assert.equal((db.prepare('SELECT COUNT(*) n FROM session_conversation_state').get() as { n: number }).n, 1);
    db.prepare("DELETE FROM sessions WHERE id = 'with-state'").run();
    assert.equal((db.prepare('SELECT COUNT(*) n FROM session_conversation_state').get() as { n: number }).n, 0, 'the state goes with its session');
  } finally { db.close(); }
});

test('a session resumes from its stored state, the row never carries it, and a legacy metadata write is routed', () => {
  const session = HarnessSession.create({ kind: 'chat', channel: 'desktop', title: 'State lives apart' });
  session.updateConversationSnapshot([{ role: 'user', content: 'hello' }] as never);
  assert.equal('__conversation' in eventlog.getSession(session.id)!.metadata, false);
  assert.deepEqual(HarnessSession.load(session.id)!.toInputItems(), [{ role: 'user', content: 'hello' }]);
  session.updateConversationSnapshot([{ role: 'user', content: 'hello' }, { role: 'user', content: 'again' }] as never);
  assert.deepEqual(session.toInputItems(), [{ role: 'user', content: 'hello' }, { role: 'user', content: 'again' }],
    'the writing instance reads its own write');
  const legacy = eventlog.createSession({ kind: 'chat', metadata: { pinned: true, __conversation: { items: [{ role: 'user', content: 'legacy' }], updatedAt: NOW } } });
  assert.equal('__conversation' in eventlog.getSession(legacy.id)!.metadata, false, 'the row never carries conversation state');
  assert.equal(eventlog.getSession(legacy.id)!.metadata.pinned, true);
  assert.deepEqual((eventlog.getSessionConversationState(legacy.id)!.state as { items: unknown[] }).items, [{ role: 'user', content: 'legacy' }]);
  assert.deepEqual(HarnessSession.load(legacy.id)!.toInputItems(), [{ role: 'user', content: 'legacy' }]);
  eventlog.updateSession(legacy.id, { metadata: { pinned: false, __conversation: { items: [{ role: 'user', content: 'patched' }], updatedAt: NOW } } });
  assert.equal(eventlog.getSession(legacy.id)!.metadata.pinned, false);
  assert.deepEqual(HarnessSession.load(legacy.id)!.toInputItems(), [{ role: 'user', content: 'patched' }]);
  eventlog.updateSession(legacy.id, { title: 'renamed' });
  assert.deepEqual(HarnessSession.load(legacy.id)!.toInputItems(), [{ role: 'user', content: 'patched' }], 'a row patch never drops the state');
});
