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
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-spaces-test-'));

const store = await import('./store.js');
const data = await import('./data-store.js');
const workspaceDb = await import('./workspace-db.js');
const memoryDb = await import('../memory/db.js');
const temporalMemory = await import('../memory/temporal-memory.js');

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
  const created = store.spaceStore.save({
    id: 'demo',
    title: 'Demo Board',
    originSessionId: 'sess-1',
    contract: {
      objective: 'Keep the team focused on deals that need action.',
      successCriteria: ['Every risky deal has an owner and next step.'],
      invariants: ['Never mutate the CRM without approval.'],
    },
  });
  assert.equal(created.id, 'demo');
  assert.equal(created.status, 'active');
  assert.equal(created.viewEntry, 'view/index.html');
  assert.equal(created.version, 1);

  const got = store.spaceStore.get('demo');
  assert.equal(got?.title, 'Demo Board');
  assert.equal(got?.originSessionId, 'sess-1');
  assert.deepEqual(got?.contract, created.contract);

  // Update preserves id/createdAt, bumps updatedAt, keeps it a single record.
  const updated = store.spaceStore.save({ id: 'demo', title: 'Demo Board v2' });
  assert.equal(updated.title, 'Demo Board v2');
  assert.equal(updated.createdAt, created.createdAt);
  assert.deepEqual(updated.contract, created.contract, 'metadata-only saves preserve the operating contract');

  const list = store.spaceStore.list();
  assert.equal(list.filter((s) => s.id === 'demo').length, 1);
});

test('mergeSpaceContract is bounded, deduplicated, and supports explicit list clearing', () => {
  const initial = store.mergeSpaceContract(undefined, {
    objective: '  Keep   the content calendar ready for approval.  ',
    successCriteria: ['Drafts have sources', 'drafts have sources', 'Approved posts are scheduled'],
    invariants: ['Never publish without approval'],
  });
  assert.deepEqual(initial, {
    objective: 'Keep the content calendar ready for approval.',
    successCriteria: ['Drafts have sources', 'Approved posts are scheduled'],
    invariants: ['Never publish without approval'],
  });
  const revised = store.mergeSpaceContract(initial, {
    successCriteria: [],
    invariants: undefined,
  });
  assert.deepEqual(revised?.successCriteria, []);
  assert.deepEqual(revised?.invariants, ['Never publish without approval']);
  assert.equal(revised?.objective, initial?.objective);
});

test('mergeSpaceContract: a blank objective edits lists without erasing or silently aborting', () => {
  const current = {
    objective: 'Keep the pipeline decision-ready.',
    successCriteria: ['Old criterion'],
    invariants: ['Never send automatically'],
  };
  // Blank objective on an existing contract means "objective unchanged", not
  // "discard the rest of my patch".
  const revised = store.mergeSpaceContract(current, {
    objective: '   ',
    successCriteria: ['Every row is sourced', 'Board ready before standup'],
  });
  assert.deepEqual(revised, {
    objective: 'Keep the pipeline decision-ready.',
    successCriteria: ['Every row is sourced', 'Board ready before standup'],
    invariants: ['Never send automatically'],
  });
  // Without any objective a contract still cannot come into existence.
  assert.equal(store.mergeSpaceContract(undefined, { objective: '', successCriteria: ['x'] }), undefined);
  assert.equal(store.mergeSpaceContract(undefined, { successCriteria: ['x'] }), undefined);
});

test('hand-written manifests accept canonical and snake-case contract fields', () => {
  const slug = 'contract-manifest';
  const dir = store.resolveSpaceDir(slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'space.json'), JSON.stringify({
    id: slug,
    title: 'Contract Manifest',
    contract: {
      objective: 'Keep the weekly report decision-ready.',
      success_criteria: ['All figures cite the refreshed source'],
      guardrails: ['Never replace a real value with a placeholder'],
    },
  }), 'utf-8');
  assert.deepEqual(store.spaceStore.get(slug)?.contract, {
    objective: 'Keep the weekly report decision-ready.',
    successCriteria: ['All figures cite the refreshed source'],
    invariants: ['Never replace a real value with a placeholder'],
  });
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

test('buildSpaceHealthSnapshot surfaces failed data-source refresh metadata', () => {
  const slug = 'health-failed-refresh';
  store.spaceStore.save({
    id: slug,
    title: 'Health Failed Refresh',
    dataSources: [{ id: 'pull', runner: 'refresh.mjs' }],
  });
  const viewFile = store.resolveInSpace(slug, 'view/index.html');
  mkdirSync(path.dirname(viewFile), { recursive: true });
  writeFileSync(viewFile, '<html>failed refresh</html>', 'utf-8');
  const scriptDir = store.resolveInSpace(slug, 'data');
  mkdirSync(scriptDir, { recursive: true });
  writeFileSync(path.join(scriptDir, 'refresh.mjs'), 'process.stdout.write("{}")', 'utf-8');
  data.writeData(slug, {
    _meta: {
      pull: {
        refreshedAt: '2026-06-09T00:00:00.000Z',
        ok: false,
        error: 'runner produced no output',
      },
    },
  });
  const rec = store.spaceStore.update(slug, { lastRefreshedAt: '2026-06-09T00:00:00.000Z' })!;

  const health = store.buildSpaceHealthSnapshot(rec, { now: Date.parse('2026-06-09T00:01:00.000Z') });

  assert.equal(health.freshness.state, 'fresh');
  assert.ok(health.issues.some((issue) => /data source "pull" last refresh failed/.test(issue)));
  assert.ok(health.issues.some((issue) => /runner produced no output/.test(issue)));
});

test('buildSpaceHealthSnapshot surfaces pending pinned-entrypoint approval without calling it a refresh failure', () => {
  const slug = 'health-awaiting-runner-approval';
  store.spaceStore.save({
    id: slug,
    title: 'Health Awaiting Runner Approval',
    dataSources: [{ id: 'pull', runner: 'refresh.mjs' }],
  });
  const viewFile = store.resolveInSpace(slug, 'view/index.html');
  mkdirSync(path.dirname(viewFile), { recursive: true });
  writeFileSync(viewFile, '<html>awaiting approval</html>', 'utf-8');
  const scriptDir = store.resolveInSpace(slug, 'data');
  mkdirSync(scriptDir, { recursive: true });
  writeFileSync(path.join(scriptDir, 'refresh.mjs'), 'process.stdout.write("{}")', 'utf-8');
  data.writeData(slug, {
    pull: [{ id: 'last-known-good' }],
    _meta: {
      pull: {
        refreshedAt: '2026-06-09T00:01:00.000Z',
        ok: null,
        status: 'awaiting_approval',
        approvalId: 'apr-exact-runner',
      },
    },
  });
  const rec = store.spaceStore.update(slug, { lastRefreshedAt: '2026-06-09T00:00:00.000Z' })!;

  const health = store.buildSpaceHealthSnapshot(rec, { now: Date.parse('2026-06-09T00:02:00.000Z') });

  assert.equal(health.freshness.state, 'fresh');
  assert.ok(health.issues.some((issue) =>
    /data source "pull" is awaiting pinned-entrypoint approval.*apr-exact-runner/.test(issue)));
  assert.equal(health.issues.some((issue) => /last refresh failed/.test(issue)), false);
});

test('temporal awaiting-approval projection and restart heal remain pending, never failed', () => {
  const slug = 'temporal-awaiting-health';
  const rec = store.spaceStore.save({
    id: slug,
    title: 'Awaiting Health',
    dataSources: [{ id: 'pull', composioSlug: 'GOOGLEADS_SEARCH' }],
  });
  workspaceDb.commitWorkspaceObservationBatch({
    workspaceId: slug,
    rootDir: store.resolveSpaceDir(slug),
    observations: [{
      sourceKey: 'pull',
      refreshId: 'awaiting-health-1',
      cause: 'manual',
      status: 'awaiting_approval',
      error: 'Pinned entrypoint approval required',
      provenance: { approvalId: 'apr-temporal-health' },
    }],
  });

  const assertPendingHealth = (): void => {
    const projected = data.readData(slug) as {
      _meta: Record<string, Record<string, unknown>>;
    };
    assert.equal(projected._meta.pull.ok, null);
    assert.equal(projected._meta.pull.status, 'awaiting_approval');
    assert.equal(projected._meta.pull.approvalId, 'apr-temporal-health');
    const health = store.buildSpaceHealthSnapshot(rec);
    assert.ok(health.issues.some((issue) =>
      /data source "pull" is awaiting pinned-entrypoint approval.*apr-temporal-health/.test(issue)));
    assert.equal(health.issues.some((issue) => /last refresh failed/.test(issue)), false);
  };
  assertPendingHealth();

  writeFileSync(store.resolveInSpace(slug, 'data.json'), '{}', 'utf-8');
  workspaceDb.healWorkspaceDataProjection(slug, {
    rootDir: store.resolveSpaceDir(slug),
  });
  assertPendingHealth();
});

test('archive hides from default list; includeArchived shows it; remove deletes dir', () => {
  store.spaceStore.save({ id: 'gone', title: 'Gone' });
  store.spaceStore.archive('gone');
  assert.equal(store.spaceStore.list().some((s) => s.id === 'gone'), false);
  assert.equal(store.spaceStore.list(true).some((s) => s.id === 'gone'), true);
  assert.equal(store.spaceStore.remove('gone'), true);
  assert.equal(store.spaceStore.get('gone'), undefined);
});

test('hard delete restores the Workspace and history when the durable DB cascade fails', () => {
  const slug = 'delete-fail-closed';
  store.spaceStore.save({ id: slug, title: 'Keep Until Durable' });
  workspaceDb.commitWorkspaceObservationBatch({
    workspaceId: slug,
    rootDir: store.resolveSpaceDir(slug),
    observations: [{
      sourceKey: 'metrics',
      refreshId: 'before-delete',
      cause: 'manual',
      status: 'ok',
      data: { value: 'must-not-reattach' },
    }],
  });
  const db = workspaceDb.openWorkspaceDb();
  db.exec(`
    CREATE TRIGGER fail_workspace_delete
    BEFORE DELETE ON workspaces
    WHEN OLD.id = 'delete-fail-closed'
    BEGIN
      SELECT RAISE(ABORT, 'injected durable delete failure');
    END;
  `);
  try {
    assert.equal(store.spaceStore.remove(slug), false);
    assert.ok(existsSync(store.resolveSpaceDir(slug)));
    assert.equal(store.spaceStore.get(slug)?.title, 'Keep Until Durable');
    assert.equal(
      workspaceDb.getCurrentWorkspaceDatasetObservation(slug, 'metrics')?.refreshId,
      'before-delete',
    );
    assert.equal(
      existsSync(store.WORKSPACE_DELETE_QUARANTINE_DIR)
        ? store.spaceStore.list(true).some((entry) => entry.id.startsWith('.delete'))
        : false,
      false,
      'hidden quarantine markers never enter normal list/reindex',
    );
  } finally {
    db.exec('DROP TRIGGER fail_workspace_delete');
  }

  assert.equal(store.spaceStore.remove(slug), true);
  assert.equal(store.spaceStore.get(slug), undefined);
  assert.equal(
    workspaceDb.getCurrentWorkspaceDatasetObservation(slug, 'metrics'),
    null,
  );
  const recreated = store.spaceStore.save({ id: slug, title: 'Clean Generation' });
  assert.equal(recreated.title, 'Clean Generation');
  assert.equal(
    workspaceDb.listWorkspaceDatasetObservations(slug, { limit: 100 }).length,
    0,
    'a reused slug cannot inherit temporal observations from the deleted generation',
  );
});

test('restart/recreate completes quarantined deletes before and after the DB cascade', () => {
  const beforeSlug = 'delete-crash-before-db';
  store.spaceStore.save({ id: beforeSlug, title: 'Old Before DB' });
  workspaceDb.commitWorkspaceObservationBatch({
    workspaceId: beforeSlug,
    rootDir: store.resolveSpaceDir(beforeSlug),
    observations: [{
      sourceKey: 'metrics',
      refreshId: 'old-before-db',
      cause: 'manual',
      status: 'ok',
      data: { generation: 'old' },
    }],
  });
  const beforeQuarantine = store.workspaceDeletionQuarantinePath(
    beforeSlug,
    '00000000-0000-4000-8000-000000000001',
  );
  mkdirSync(store.WORKSPACE_DELETE_QUARANTINE_DIR, { recursive: true });
  renameSync(store.resolveSpaceDir(beforeSlug), beforeQuarantine);
  workspaceDb.closeWorkspaceDb();

  const blockedDb = workspaceDb.openWorkspaceDb();
  blockedDb.exec(`
    CREATE TRIGGER fail_recovery_delete
    BEFORE DELETE ON workspaces
    WHEN OLD.id = 'delete-crash-before-db'
    BEGIN
      SELECT RAISE(ABORT, 'injected recovery delete failure');
    END;
  `);
  assert.throws(
    () => store.spaceStore.save({ id: beforeSlug, title: 'Must Stay Blocked' }),
    /injected recovery delete failure/,
  );
  assert.equal(existsSync(store.resolveSpaceDir(beforeSlug)), false);
  assert.equal(existsSync(beforeQuarantine), true);
  assert.equal(
    workspaceDb.getCurrentWorkspaceDatasetObservation(beforeSlug, 'metrics')?.refreshId,
    'old-before-db',
  );
  blockedDb.exec('DROP TRIGGER fail_recovery_delete');

  const cleanBefore = store.spaceStore.save({
    id: beforeSlug,
    title: 'New After Recovery',
  });
  assert.equal(cleanBefore.title, 'New After Recovery');
  assert.equal(existsSync(beforeQuarantine), false);
  assert.equal(
    workspaceDb.listWorkspaceDatasetObservations(beforeSlug, { limit: 100 }).length,
    0,
  );

  const afterSlug = 'delete-crash-after-db';
  store.spaceStore.save({ id: afterSlug, title: 'Old After DB' });
  workspaceDb.commitWorkspaceObservationBatch({
    workspaceId: afterSlug,
    rootDir: store.resolveSpaceDir(afterSlug),
    observations: [{
      sourceKey: 'metrics',
      refreshId: 'old-after-db',
      cause: 'manual',
      status: 'ok',
      data: { generation: 'old' },
    }],
  });
  const afterQuarantine = store.workspaceDeletionQuarantinePath(
    afterSlug,
    '00000000-0000-4000-8000-000000000002',
  );
  mkdirSync(store.WORKSPACE_DELETE_QUARANTINE_DIR, { recursive: true });
  renameSync(store.resolveSpaceDir(afterSlug), afterQuarantine);
  assert.equal(workspaceDb.deleteWorkspaceIndex(afterSlug, {
    actor: 'delete-crash-test',
    emitOperational: false,
  }), true);
  workspaceDb.closeWorkspaceDb();

  const cleanAfter = store.spaceStore.save({
    id: afterSlug,
    title: 'New After Cleanup',
  });
  assert.equal(cleanAfter.title, 'New After Cleanup');
  assert.equal(existsSync(afterQuarantine), false);
  assert.equal(
    workspaceDb.listWorkspaceDatasetObservations(afterSlug, { limit: 100 }).length,
    0,
  );
});

test('memory purge failure keeps hard delete quarantined and blocks same-slug recall inheritance', () => {
  const slug = 'delete-memory-fail';
  store.spaceStore.save({ id: slug, title: 'Old Memory Generation' });
  workspaceDb.commitWorkspaceObservationBatch({
    workspaceId: slug,
    rootDir: store.resolveSpaceDir(slug),
    observations: [{
      sourceKey: 'metrics',
      refreshId: 'old-memory-generation',
      cause: 'manual',
      status: 'ok',
      data: { generation: 'old' },
    }],
  });
  temporalMemory.recordMemoryEpisode({
    kind: 'tool_result',
    sourceApp: 'workspace',
    sessionId: `workspace:${slug}`,
    callId: 'old-observation',
    sourceUri: `workspace://${slug}/sources/metrics`,
    occurredAt: '2026-07-28T12:00:00.000Z',
    content: 'Old generation evidence must never reach a recreated slug.',
  });
  const db = memoryDb.openMemoryDb();
  db.exec(`
    CREATE TRIGGER fail_workspace_memory_purge
    BEFORE DELETE ON memory_episodes
    WHEN OLD.source_app = 'workspace'
      AND OLD.session_id = 'workspace:delete-memory-fail'
    BEGIN
      SELECT RAISE(ABORT, 'injected Workspace memory purge failure');
    END;
  `);

  assert.equal(store.spaceStore.remove(slug), false);
  assert.equal(existsSync(store.resolveSpaceDir(slug)), false);
  assert.equal(
    workspaceDb.listWorkspaceDatasetObservations(slug, { limit: 100 }).length,
    0,
    'the first durable cascade committed before the memory seam failed',
  );
  assert.ok(
    readdirSync(store.WORKSPACE_DELETE_QUARANTINE_DIR)
      .some((entry) => entry.startsWith(`${slug}--`)),
    'the marker remains durable after the second-store failure',
  );
  assert.equal(
    (db.prepare(`
      SELECT COUNT(*) AS count
      FROM memory_episodes
      WHERE source_app = 'workspace' AND session_id = ?
    `).get(`workspace:${slug}`) as { count: number }).count,
    1,
  );

  workspaceDb.closeWorkspaceDb();
  memoryDb.closeMemoryDb();
  assert.throws(
    () => store.spaceStore.save({ id: slug, title: 'Must Stay Blocked' }),
    /injected Workspace memory purge failure/i,
  );
  assert.equal(existsSync(store.resolveSpaceDir(slug)), false);

  memoryDb.openMemoryDb().exec('DROP TRIGGER fail_workspace_memory_purge');
  const recreated = store.spaceStore.save({
    id: slug,
    title: 'Clean Memory Generation',
  });
  assert.equal(recreated.title, 'Clean Memory Generation');
  assert.equal(
    (memoryDb.openMemoryDb().prepare(`
      SELECT COUNT(*) AS count
      FROM memory_episodes
      WHERE source_app = 'workspace' AND session_id = ?
    `).get(`workspace:${slug}`) as { count: number }).count,
    0,
    'recreate cannot inherit episodic recall from the deleted generation',
  );
  assert.equal(
    workspaceDb.listWorkspaceDatasetObservations(slug, { limit: 100 }).length,
    0,
  );
  assert.equal(
    readdirSync(store.WORKSPACE_DELETE_QUARANTINE_DIR)
      .some((entry) => entry.startsWith(`${slug}--`)),
    false,
  );
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

test('hand-written manifest reports non-canonical and duplicate identities while preserving safe prototype-shaped ids', () => {
  const slug = 'identity-handwritten';
  const dir = store.resolveSpaceDir(slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'space.json'), JSON.stringify({
    id: slug,
    title: 'Identity Handwritten',
    dataSources: [
      { id: '   ', composioSlug: 'SALESFORCE_GET_CONTACTS' },
      { id: ' pull', composioSlug: 'SALESFORCE_GET_CONTACTS' },
      { id: 'pull', composioSlug: 'SALESFORCE_GET_CONTACTS' },
      { id: 'pull', composioSlug: 'SALESFORCE_GET_CONTACTS' },
      { id: '_meta', composioSlug: 'SALESFORCE_GET_CONTACTS' },
      { id: 'x'.repeat(121), composioSlug: 'SALESFORCE_GET_CONTACTS' },
      { id: 'control\u0001source', composioSlug: 'SALESFORCE_GET_CONTACTS' },
      { id: '__proto__', composioSlug: 'SALESFORCE_GET_CONTACTS' },
      { id: 'constructor', composioSlug: 'SALESFORCE_GET_CONTACTS' },
      { id: 'prototype', composioSlug: 'SALESFORCE_GET_CONTACTS' },
    ],
    actions: [
      { id: '', composioSlug: 'OUTLOOK_SEND_EMAIL' },
      { id: 'send ', composioSlug: 'OUTLOOK_SEND_EMAIL' },
      { id: 'send', composioSlug: 'OUTLOOK_SEND_EMAIL' },
      { id: 'send', composioSlug: 'OUTLOOK_SEND_EMAIL' },
      { id: 'y'.repeat(121), composioSlug: 'OUTLOOK_SEND_EMAIL' },
      { id: 'control\u0001action', composioSlug: 'OUTLOOK_SEND_EMAIL' },
    ],
  }), 'utf-8');

  const record = store.spaceStore.get(slug)!;
  const errors = record.manifestErrors?.join('\n') ?? '';
  assert.match(errors, /Data source .*non-whitespace/i);
  assert.match(errors, /Data source .*leading or trailing whitespace/i);
  assert.match(errors, /Duplicate data source id "pull"/i);
  assert.match(errors, /reserved id "_meta"/i);
  assert.match(errors, /Data source .*120 character/i);
  assert.match(errors, /Data source .*control character/i);
  assert.match(errors, /Action .*non-whitespace/i);
  assert.match(errors, /Action .*leading or trailing whitespace/i);
  assert.match(errors, /Duplicate action id "send"/i);
  assert.match(errors, /Action .*120 character/i);
  assert.match(errors, /Action .*control character/i);
  assert.doesNotMatch(errors, /__proto__|constructor|prototype/);
});

test('identity diagnostics stay bounded and printable for hostile handwritten ids', () => {
  const canonical = `control\u0001${'x'.repeat(100_000)}`;
  const errors = store.workspaceIdentityErrors([
    { id: ` ${canonical} ` },
    { id: canonical },
  ], []);
  const rendered = errors.join('\n');

  assert.match(rendered, /leading or trailing whitespace/i);
  assert.match(rendered, /120 character/i);
  assert.match(rendered, /control character/i);
  assert.match(rendered, /Duplicate data source id/i);
  assert.ok(
    Buffer.byteLength(rendered, 'utf-8') < 1_000,
    `diagnostics unexpectedly expanded to ${Buffer.byteLength(rendered, 'utf-8')} bytes`,
  );
  assert.ok(
    errors.every((error) => !/[\u0000-\u001f\u007f-\u009f]/.test(error)),
    'individual diagnostics must not retain control characters',
  );
  assert.doesNotMatch(rendered, /x{100}/);
});

test('save and update reject invalid identities before persisting, but allow prototype-shaped ids', () => {
  const invalidSlug = 'identity-save-invalid';
  assert.throws(
    () => store.spaceStore.save({
      id: invalidSlug,
      title: 'Invalid',
      dataSources: [
        { id: 'same', composioSlug: 'SALESFORCE_GET_CONTACTS' },
        { id: 'same', composioSlug: 'SALESFORCE_GET_CONTACTS' },
      ],
    }),
    /Duplicate data source id "same"/i,
  );
  assert.equal(store.spaceStore.get(invalidSlug), undefined);
  assert.equal(existsSync(store.resolveSpaceDir(invalidSlug)), false);

  const updateSlug = 'identity-update-invalid';
  store.spaceStore.save({
    id: updateSlug,
    title: 'Original',
    actions: [{ id: 'send', composioSlug: 'OUTLOOK_SEND_EMAIL' }],
  });
  const before = readFileSync(
    path.join(store.resolveSpaceDir(updateSlug), 'space.json'),
    'utf-8',
  );
  assert.throws(
    () => store.spaceStore.update(updateSlug, {
      actions: [
        { id: 'send', composioSlug: 'OUTLOOK_SEND_EMAIL' },
        { id: ' send ', composioSlug: 'OUTLOOK_SEND_EMAIL' },
      ],
    }),
    /leading or trailing whitespace|Duplicate action id/i,
  );
  assert.equal(
    readFileSync(path.join(store.resolveSpaceDir(updateSlug), 'space.json'), 'utf-8'),
    before,
  );

  const valid = store.spaceStore.save({
    id: 'identity-prototype-valid',
    title: 'Valid Prototype Identities',
    dataSources: [
      { id: '__proto__', composioSlug: 'SALESFORCE_GET_CONTACTS' },
      { id: 'constructor', composioSlug: 'SALESFORCE_GET_CONTACTS' },
      { id: 'prototype', composioSlug: 'SALESFORCE_GET_CONTACTS' },
    ],
    actions: [
      { id: '__proto__', composioSlug: 'OUTLOOK_SEND_EMAIL' },
      { id: 'constructor', composioSlug: 'OUTLOOK_SEND_EMAIL' },
      { id: 'prototype', composioSlug: 'OUTLOOK_SEND_EMAIL' },
    ],
  });
  assert.deepEqual(
    valid.dataSources.map((source) => source.id),
    ['__proto__', 'constructor', 'prototype'],
  );
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
