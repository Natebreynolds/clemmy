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
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
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

test('buildSpaceHealthSnapshot surfaces view, runners, freshness, and issues', () => {
  const slug = 'health-demo';
  const rec = store.spaceStore.save({
    id: slug,
    title: 'Health Demo',
    dataSources: [{ id: 'pull', runner: 'refresh.mjs' }],
    actions: [{ id: 'act', runner: 'act.mjs' }],
  });
  const viewFile = store.resolveInSpace(slug, 'view/index.html');
  mkdirSync(path.dirname(viewFile), { recursive: true });
  writeFileSync(viewFile, '<html>healthy</html>', 'utf-8');
  const scriptDir = store.resolveInSpace(slug, 'data');
  mkdirSync(scriptDir, { recursive: true });
  writeFileSync(path.join(scriptDir, 'refresh.mjs'), 'process.stdout.write("{}")', 'utf-8');

  const health = store.buildSpaceHealthSnapshot(rec, { now: Date.parse('2026-06-09T00:00:00.000Z') });
  assert.equal(health.view.exists, true);
  assert.equal(health.counts.dataSources, 1);
  assert.equal(health.counts.actions, 1);
  assert.equal(health.counts.runners, 2);
  assert.equal(health.runners.find((r) => r.runner === 'refresh.mjs')?.present, true);
  assert.equal(health.runners.find((r) => r.runner === 'act.mjs')?.present, false);
  assert.equal(health.freshness.state, 'never_refreshed');
  assert.ok(health.issues.some((issue) => /data\/act\.mjs/.test(issue)));
  assert.ok(health.issues.some((issue) => /never refreshed/.test(issue)));
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

test('hand-written manifest keeps invalid JSON diagnostics instead of silently dropping args', () => {
  const slug = 'bad-manifest';
  const dir = store.resolveSpaceDir(slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'space.json'), JSON.stringify({
    id: slug,
    title: 'Bad Manifest',
    dataSources: [{ id: 'pull', composio_slug: 'GOOGLECALENDAR_LIST_EVENTS', composio_args_json: '{not json' }],
    actions: [{ id: 'send', runner: 'act.mjs', args_template_json: '[1,2]' }],
  }), 'utf-8');

  const rec = store.spaceStore.get(slug);
  assert.equal(rec?.dataSources[0].composioSlug, 'GOOGLECALENDAR_LIST_EVENTS');
  assert.equal(rec?.dataSources[0].composioArgs, undefined);
  assert.equal(rec?.actions[0].argsTemplate, undefined);
  assert.ok(rec?.manifestErrors?.some((e) => /composio_args_json is not valid JSON/.test(e)));
  assert.ok(rec?.manifestErrors?.some((e) => /args_template_json must be a JSON object/.test(e)));

  assert.throws(
    () => store.spaceStore.save({ id: slug, title: 'Still Bad' }),
    /existing space manifest has invalid fields/,
  );
  store.spaceStore.save({
    id: slug,
    title: 'Fixed Manifest',
    dataSources: [{ id: 'pull', composioSlug: 'GOOGLECALENDAR_LIST_EVENTS', composioArgs: { max: 10 } }],
    actions: [{ id: 'send', runner: 'act.mjs', argsTemplate: { to: 'lead@example.com' } }],
  });
  const fixed = store.spaceStore.get(slug);
  assert.equal(fixed?.manifestErrors, undefined);
  assert.deepEqual(fixed?.dataSources[0].composioArgs, { max: 10 });
});

test('hand-written manifest flags runner paths as invalid manifest diagnostics', () => {
  const slug = 'bad-runner-manifest';
  const dir = store.resolveSpaceDir(slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'space.json'), JSON.stringify({
    id: slug,
    title: 'Bad Runner Manifest',
    dataSources: [{ id: 'pull', runner: '../view/evil.mjs' }],
    actions: [{ id: 'act', runner: 'nested/act.mjs' }],
  }), 'utf-8');

  const rec = store.spaceStore.get(slug);
  assert.equal(rec?.dataSources[0].runner, '../view/evil.mjs');
  assert.equal(rec?.actions[0].runner, 'nested/act.mjs');
  assert.ok(rec?.manifestErrors?.some((e) => /Data source "pull".*not a path/.test(e)));
  assert.ok(rec?.manifestErrors?.some((e) => /Action "act".*not a path/.test(e)));
  assert.throws(
    () => store.spaceStore.save({ id: slug, title: 'Still Bad' }),
    /existing space manifest has invalid fields/,
  );
});

test('save rejects new runner paths but allows bare filenames before runner files exist', () => {
  const ok = store.spaceStore.save({
    id: 'runner-filename-ok',
    title: 'Runner Filename OK',
    dataSources: [{ id: 'pull', runner: 'refresh.mjs' }],
    actions: [{ id: 'act', runner: 'act.mjs' }],
  });
  assert.equal(ok.dataSources[0].runner, 'refresh.mjs');
  assert.equal(ok.actions[0].runner, 'act.mjs');

  assert.throws(
    () => store.spaceStore.save({
      id: 'runner-save-bad-source',
      title: 'Bad Source Runner',
      dataSources: [{ id: 'pull', runner: '../view/evil.mjs' }],
    }),
    /invalid workspace runner declarations:[\s\S]*Data source "pull"[\s\S]*not a path/,
  );
  assert.throws(
    () => store.spaceStore.save({
      id: 'runner-save-bad-action',
      title: 'Bad Action Runner',
      actions: [{ id: 'act', runner: 'nested/act.mjs' }],
    }),
    /invalid workspace runner declarations:[\s\S]*Action "act"[\s\S]*not a path/,
  );
});

test('update rejects runner path patches without changing the manifest', () => {
  const slug = 'runner-update-guard';
  store.spaceStore.save({
    id: slug,
    title: 'Runner Update Guard',
    actions: [{ id: 'act', runner: 'act.mjs' }],
  });

  assert.throws(
    () => store.spaceStore.update(slug, {
      actions: [{ id: 'act', runner: '../view/evil.mjs' }],
    }),
    /invalid workspace runner declarations:[\s\S]*Action "act"[\s\S]*not a path/,
  );

  const after = store.spaceStore.get(slug);
  assert.equal(after?.actions[0].runner, 'act.mjs');
});

test('archive preserves malformed manifest fields instead of normalizing them away', () => {
  const slug = 'bad-archive';
  const dir = store.resolveSpaceDir(slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'space.json'), JSON.stringify({
    id: slug,
    title: 'Bad Archive',
    dataSources: [{ id: 'pull', composio_slug: 'GOOGLECALENDAR_LIST_EVENTS', composio_args_json: '{not json' }],
    actions: [{ id: 'send', runner: 'act.mjs', args_template_json: '[1,2]' }],
  }), 'utf-8');

  const archived = store.spaceStore.archive(slug);
  assert.equal(archived?.status, 'archived');
  assert.ok(archived?.manifestErrors?.length);
  assert.equal(store.spaceStore.list().some((s) => s.id === slug), false);
  assert.equal(store.spaceStore.list(true).some((s) => s.id === slug), true);

  const raw = JSON.parse(readFileSync(path.join(dir, 'space.json'), 'utf-8')) as {
    dataSources: Array<{ composio_args_json?: string }>;
    actions: Array<{ args_template_json?: string }>;
  };
  assert.equal(raw.dataSources[0].composio_args_json, '{not json');
  assert.equal(raw.actions[0].args_template_json, '[1,2]');
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
