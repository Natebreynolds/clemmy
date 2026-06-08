/**
 * Run: npx tsx --test src/spaces/store.test.ts
 *
 * Covers the Space store + data-store: path-safety (traversal rejected),
 * create/update/list/get (manifest is source of truth, scan-based index),
 * versioned revisions, archive/remove, and the data plane (data.json size cap,
 * notes/audit append + tail). Uses a temp CLEMENTINE_HOME so the real home is
 * never touched. Imports are dynamic AFTER the env is set (BASE_DIR is resolved
 * at module load from CLEMENTINE_HOME).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-spaces-test-'));

const store = await import('./store.js');
const data = await import('./data-store.js');

test('isValidSpaceSlug accepts kebab, rejects traversal/space/caps', () => {
  assert.equal(store.isValidSpaceSlug('sf-daily-report'), true);
  assert.equal(store.isValidSpaceSlug('a1'), true);
  assert.equal(store.isValidSpaceSlug('../etc'), false);
  assert.equal(store.isValidSpaceSlug('Has Space'), false);
  assert.equal(store.isValidSpaceSlug('UPPER'), false);
  assert.equal(store.isValidSpaceSlug('-leading'), false);
  assert.equal(store.isValidSpaceSlug('a'), false); // too short
});

test('resolveInSpace rejects traversal out of the space dir', () => {
  assert.throws(() => store.resolveInSpace('demo', '../../../etc/passwd'));
  assert.throws(() => store.resolveInSpace('demo', '/etc/passwd'));
  const ok = store.resolveInSpace('demo', 'view/index.html');
  assert.ok(ok.endsWith(path.join('demo', 'view', 'index.html')));
});

test('save creates a manifest; get + list read it back; idempotent update', () => {
  const created = store.spaceStore.save({ id: 'demo', title: 'Demo Board', originSessionId: 'sess-1' });
  assert.equal(created.id, 'demo');
  assert.equal(created.status, 'active');
  assert.equal(created.viewEntry, 'view/index.html');
  assert.equal(created.version, 1);

  const got = store.spaceStore.get('demo');
  assert.equal(got?.title, 'Demo Board');
  assert.equal(got?.originSessionId, 'sess-1');

  // Update preserves id/createdAt, bumps updatedAt, keeps it a single record.
  const updated = store.spaceStore.save({ id: 'demo', title: 'Demo Board v2' });
  assert.equal(updated.title, 'Demo Board v2');
  assert.equal(updated.createdAt, created.createdAt);

  const list = store.spaceStore.list();
  assert.equal(list.filter((s) => s.id === 'demo').length, 1);
});

test('recordRevision snapshots the view + bumps version', () => {
  store.spaceStore.save({ id: 'rev', title: 'Rev' });
  const viewFile = store.resolveInSpace('rev', 'view/index.html');
  // write a first view
  const dir = path.dirname(viewFile);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(viewFile, '<html>v1</html>', 'utf-8');
  const after = store.spaceStore.recordRevision('rev');
  assert.equal(after?.version, 2);
  assert.equal(after?.revisions.length, 1);
  const snap = store.resolveInSpace('rev', after!.revisions[0].file);
  assert.ok(existsSync(snap));
});

test('archive hides from default list; includeArchived shows it; remove deletes dir', () => {
  store.spaceStore.save({ id: 'gone', title: 'Gone' });
  store.spaceStore.archive('gone');
  assert.equal(store.spaceStore.list().some((s) => s.id === 'gone'), false);
  assert.equal(store.spaceStore.list(true).some((s) => s.id === 'gone'), true);
  assert.equal(store.spaceStore.remove('gone'), true);
  assert.equal(store.spaceStore.get('gone'), undefined);
});

test('list ignores non-slug dirs and dirs without a manifest', () => {
  // A stray dir under spaces/ with no manifest must not crash or appear.
  const stray = path.join(store.SPACES_DIR, 'no-manifest');
  mkdirSync(stray, { recursive: true });
  const ids = store.spaceStore.list().map((s) => s.id);
  assert.equal(ids.includes('no-manifest'), false);
});

test('data.json round-trips and enforces the size cap', () => {
  store.spaceStore.save({ id: 'data1', title: 'Data' });
  const w = data.writeData('data1', { rows: [{ name: 'Acme', amount: 1000 }] });
  assert.equal(w.ok, true);
  assert.deepEqual(data.readData('data1'), { rows: [{ name: 'Acme', amount: 1000 }] });

  const huge = { blob: 'x'.repeat(data.MAX_DATA_BYTES + 1) };
  const rej = data.writeData('data1', huge);
  assert.equal(rej.ok, false);
  // The prior good data is untouched after a rejected oversize write.
  assert.deepEqual(data.readData('data1'), { rows: [{ name: 'Acme', amount: 1000 }] });
});

test('readData returns {} for an absent dataset', () => {
  store.spaceStore.save({ id: 'empty', title: 'Empty' });
  assert.deepEqual(data.readData('empty'), {});
});

test('notes append + tail; audit append + tail', () => {
  store.spaceStore.save({ id: 'notes1', title: 'Notes' });
  const n = data.appendNote('notes1', { text: 'called Acme', kind: 'call', meta: { to: '+1555' } });
  assert.equal(n.kind, 'call');
  data.appendNote('notes1', { text: 'left a voicemail' });
  const notes = data.listNotes('notes1');
  assert.equal(notes.length, 2);
  assert.equal(notes[0].text, 'called Acme');

  data.appendAudit('notes1', { method: 'PUT', path: '/data', outcome: 'ok', bytes: 42 });
  const audit = data.listAudit('notes1');
  assert.equal(audit.length, 1);
  assert.equal(audit[0].method, 'PUT');
});

test('data-plane path-safety: a bad slug cannot escape', () => {
  assert.throws(() => data.writeData('../evil', { x: 1 }));
  assert.throws(() => data.appendNote('../evil', { text: 'nope' }));
});
