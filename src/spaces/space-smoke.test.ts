/**
 * Run: npx tsx --test src/spaces/space-smoke.test.ts
 *
 * The Space creation smoke (mirror of the workflow read-only creation test):
 * pure classifiers (looksEmpty, toolkitSlugForTool) + the runner-backed smoke
 * that catches a failed source and a zero-row source. No network/LLM (no
 * Composio actions declared → the toolkit check is skipped). Temp CLEMENTINE_HOME.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-space-smoke-test-'));

const smoke = await import('./space-smoke.js');
const store = await import('./store.js');
const runner = await import('./runner.js');
const { seedLegacySpaceTrustApproval } = await import('./legacy-space-trust.fixture.js');
const approvals = await import('../runtime/harness/approval-registry.js');
const eventlog = await import('../runtime/harness/eventlog.js');

function writeRunner(slug: string, file: string, body: string) {
  const dir = store.resolveInSpace(slug, 'data');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, file), body, 'utf-8');
}

async function approveInstalledRunnerFixture(
  slug: string,
  source: Parameters<typeof runner.runSpaceDataSource>[1],
): Promise<void> {
  const card = seedLegacySpaceTrustApproval(slug, source);
  eventlog.openEventLog().prepare(`
    UPDATE pending_approvals
       SET status = 'resolved', resolution = 'approved', resolver = ?, resolved_at = ?
     WHERE approval_id = ? AND status = 'pending'
  `).run('smoke-runner-fixture', new Date().toISOString(), card.approvalId);
}

test('looksEmpty: empties vs data', () => {
  assert.equal(smoke.looksEmpty(null), true);
  assert.equal(smoke.looksEmpty([]), true);
  assert.equal(smoke.looksEmpty({}), true);
  assert.equal(smoke.looksEmpty({ contacts: [] }), true);
  assert.equal(smoke.looksEmpty({ _meta: { x: 1 } }), true);
  assert.equal(smoke.looksEmpty([1, 2]), false);
  assert.equal(smoke.looksEmpty({ contacts: [{ a: 1 }] }), false);
  assert.equal(smoke.looksEmpty({ count: 5 }), false);
  // Command-line query output: status and paging scalars beside the records.
  assert.equal(smoke.looksEmpty({ status: 0, result: { done: true, totalSize: 0, records: [] }, warnings: [] }), true);
  assert.equal(smoke.looksEmpty({ status: 0, result: { done: true, totalSize: 1, records: [{ Id: 'a' }] }, warnings: [] }), false);
  assert.equal(smoke.looksEmpty({ complete: true, result: { records: [] } }), true);
  assert.equal(smoke.looksEmpty({ summary: { total: 5 }, warnings: [] }), false, 'an empty side list is not an empty source');
});

test('toolkitSlugForTool derives the toolkit', () => {
  assert.equal(smoke.toolkitSlugForTool('OUTLOOK_OUTLOOK_SEND_EMAIL'), 'outlook');
  assert.equal(smoke.toolkitSlugForTool('SALESFORCE_QUERY'), 'salesforce');
});

test('smoke: an approved local source is a contained failure before its rows execute', async () => {
  const slug = 'smoke-ok';
  const source = { id: 'pull', runner: 'pull.mjs' };
  store.spaceStore.save({ id: slug, title: 'OK', dataSources: [source] });
  writeRunner(slug, source.runner, `process.stdout.write(JSON.stringify({rows:[{a:1}]}));`);
  await approveInstalledRunnerFixture(slug, source);
  const res = await smoke.runSpaceCreationSmoke(slug);
  assert.equal(res.failed.length, 0);
  assert.equal(res.awaitingApproval.length, 1);
  assert.equal(approvals.get(res.awaitingApproval[0].approvalId)?.tool, 'workspace_source_script_consent');
  assert.equal(res.empty.length, 0);
});

test('smoke: an installed legacy runner reports unavailable execution without a futile approval', async () => {
  const slug = 'smoke-fail';
  store.spaceStore.save({ id: slug, title: 'Fail', dataSources: [{ id: 'pull', runner: 'bad.mjs' }] });
  writeRunner(slug, 'bad.mjs', 'process.exit(3)');
  const res = await smoke.runSpaceCreationSmoke(slug);
  assert.equal(res.failed.length, 0);
  assert.equal(res.awaitingApproval.length, 1);
  assert.equal(approvals.get(res.awaitingApproval[0].approvalId)?.tool, 'workspace_source_script_consent');
});

test('smoke: contained local source cannot be classified from fabricated empty output', async () => {
  const slug = 'smoke-empty';
  const source = { id: 'pull', runner: 'pull.mjs' };
  store.spaceStore.save({ id: slug, title: 'Empty', dataSources: [source] });
  writeRunner(slug, source.runner, `process.stdout.write(JSON.stringify({rows:[]}));`);
  await approveInstalledRunnerFixture(slug, source);
  const res = await smoke.runSpaceCreationSmoke(slug);
  assert.equal(res.failed.length, 0);
  assert.equal(res.awaitingApproval.length, 1);
  assert.equal(approvals.get(res.awaitingApproval[0].approvalId)?.tool, 'workspace_source_script_consent');
  assert.deepEqual(res.empty, []);
});

test('smoke: allowEmpty cannot waive local execution authority', async () => {
  const slug = 'smoke-expected-empty';
  const source = { id: 'drafts', runner: 'drafts.mjs', allowEmpty: true };
  store.spaceStore.save({
    id: slug,
    title: 'New content calendar',
    dataSources: [source],
  });
  writeRunner(slug, source.runner, `process.stdout.write(JSON.stringify({rows:[]}));`);
  await approveInstalledRunnerFixture(slug, source);
  const first = await smoke.runSpaceCreationSmoke(slug);
  const second = await smoke.runSpaceCreationSmoke(slug);
  assert.equal(first.failed.length, 0);
  assert.equal(first.awaitingApproval.length, 1);
  assert.deepEqual(first.empty, []);
  assert.equal(second.failed.length, 0);
  assert.equal(second.awaitingApproval.length, 1);
  assert.deepEqual(second.empty, []);
  assert.equal(second.awaitingApproval[0].approvalId, first.awaitingApproval[0].approvalId);
  assert.equal(approvals.get(second.awaitingApproval[0].approvalId)?.status, 'pending');
});
