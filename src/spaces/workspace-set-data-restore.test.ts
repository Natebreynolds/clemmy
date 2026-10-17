/**
 * Run: node scripts/run-tests-isolated.mjs src/spaces/workspace-set-data-restore.test.ts
 *
 * A reviewed (content-addressed) Space write that puts back content the
 * source held before must land. Live 2026-10-16: a publish workflow's
 * "clear pending" wrote [] to drafts a second time, the earlier [] observation
 * was taken for a replay, and the published draft stayed pending.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-set-data-restore-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';

const spaces = await import('./store.js');
const carrier = await import('./workspace-set-data-carrier.js');

const SLUG = 'restore-fixture';

function source(): unknown {
  const document = JSON.parse(readFileSync(spaces.resolveInSpace(SLUG, 'data.json'), 'utf8')) as Record<string, unknown>;
  return document.drafts;
}

function write(rows: unknown[]) {
  return carrier.executeReviewedWorkspaceSetData({ slug: SLUG, source_id: 'drafts', data_json: JSON.stringify(rows) });
}

test('putting back content a source held before lands, and recovery still finds it', async () => {
  spaces.spaceStore.save({
    id: SLUG,
    title: 'Restore fixture',
    status: 'active',
    viewEntry: 'view/index.html',
    viewContent: '<!doctype html><title>Restore fixture</title>',
    dataSources: [],
    actions: [],
  });
  const first = await write([]);
  assert.equal(first.created, true);
  const draft = await write([{ id: 'homepage-welcome', body: 'A pending draft.' }]);
  assert.equal(draft.created, true);
  assert.deepEqual(source(), [{ id: 'homepage-welcome', body: 'A pending draft.' }]);

  const cleared = await write([]);
  assert.deepEqual(source(), [], 'the clear lands even though [] was written once before');
  assert.equal(cleared.created, true, 'it is a real write, not a replay');
  assert.equal(cleared.artifactId, first.artifactId, 'the content-addressed artifact identity is unchanged');
  assert.ok(cleared.hostFileCommit, 'the current file proof is minted for the restored content');
  assert.equal(carrier.reconcileWorkspaceDatasetArtifact(cleared.artifactId).exists, true);

  const replay = await write([]);
  assert.equal(replay.created, false, 'writing the current content again is still a no-op');
  assert.deepEqual(source(), []);
});
