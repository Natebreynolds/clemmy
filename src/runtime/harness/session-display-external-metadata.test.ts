/** Real SQLite connections in the disposable outer runner home. No models. */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

const home = process.env.CLEMENTINE_HOME;
const isolatedRoot = process.env.CLEMMY_TEST_HOME_ROOT;
assert.ok(process.env.CLEMMY_TEST_ISOLATED_HOME === '1' && home && isolatedRoot
  && path.resolve(home).startsWith(path.resolve(isolatedRoot) + path.sep), 'disposable outer runner home required');
const eventlog = await import('./eventlog.js');
test.after(() => eventlog.closeEventLog());

test('an external equal-byte metadata replacement is visible without changing updated_at', () => {
  const row = eventlog.createSession({ kind: 'chat', metadata: { tags: ['moved'] } });
  const held = eventlog.listSessionRowsForDisplay()!.find(item => item.id === row.id)!;
  assert.deepEqual(held.metadata.tags, ['moved']);
  const db = new Database(eventlog.HARNESS_DB_PATH);
  try {
    const read = () => db.prepare('SELECT metadata_json, updated_at FROM sessions WHERE id = ?').get(row.id) as {
      metadata_json: string; updated_at: string;
    };
    const before = read();
    db.prepare("UPDATE sessions SET metadata_json = json_set(metadata_json, '$.tags', json('[\"other\"]')) WHERE id = ?").run(row.id);
    const after = read();
    assert.notEqual(after.metadata_json, before.metadata_json);
    assert.equal(Buffer.byteLength(after.metadata_json), Buffer.byteLength(before.metadata_json));
    assert.equal(after.updated_at, before.updated_at);
    const current = eventlog.listSessionRowsForDisplay()!.find(item => item.id === row.id)!;
    assert.deepEqual(current.metadata.tags, ['other']);
    assert.notEqual(current, held);
  } finally { db.close(); }
});

test('a foreign change refreshes just its row and subsequent local changes still use the fast path', () => {
  const changed = eventlog.createSession({ kind: 'chat', metadata: { pinned: false } });
  const unchanged = eventlog.createSession({ kind: 'chat', metadata: { tags: ['keep'] } });
  const before = eventlog.listSessionRowsForDisplay()!;
  const held = before.find(item => item.id === unchanged.id)!;
  const db = new Database(eventlog.HARNESS_DB_PATH);
  try {
    db.prepare("UPDATE sessions SET metadata_json = json_set(metadata_json, '$.pinned', json('true')) WHERE id = ?").run(changed.id);
    const refreshed = eventlog.listSessionRowsForDisplay()!;
    const current = refreshed.find(item => item.id === changed.id)!;
    assert.equal(current.metadata.pinned, true);
    assert.equal(refreshed.find(item => item.id === unchanged.id), held, 'unchanged metadata is not parsed into another row');
    assert.equal(eventlog.listSessionRowsForDisplay()!.find(item => item.id === changed.id), current);
    eventlog.updateSession(changed.id, { metadata: { pinned: false } });
    assert.equal(eventlog.listSessionRowsForDisplay()!.find(item => item.id === changed.id)!.metadata.pinned, false);
    assert.equal(eventlog.listSessionRowsForDisplay()!.find(item => item.id === unchanged.id), held);
  } finally { db.close(); }
});

test('an unrelated foreign commit preserves every cached session object', () => {
  eventlog.createSession({ kind: 'chat', title: 'Unrelated foreign commit', metadata: { tags: ['stable'] } });
  const before = eventlog.listSessionRowsForDisplay()!;
  const db = new Database(eventlog.HARNESS_DB_PATH);
  try {
    db.exec('CREATE TABLE display_external_control (n INTEGER); INSERT INTO display_external_control VALUES (1)');
    const after = eventlog.listSessionRowsForDisplay()!;
    assert.equal(after.length, before.length);
    for (const row of before) assert.equal(after.find(item => item.id === row.id), row);
  } finally { db.close(); }
});
