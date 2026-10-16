/**
 * Run: node scripts/run-tests-isolated.mjs src/spaces/workspace-deliverables-check.test.ts
 *
 * A created or redesigned Workspace is read against the owner's request; what
 * it does not deliver yet comes back to Clem in the save result.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const {
  _setWorkspaceDeliverablesReaderForTests,
  readWorkspaceDeliverables,
  renderWorkspaceDeliverables,
  workspaceDeliverablesUser,
} = await import('./workspace-deliverables-check.js');

const record = {
  id: 'site-ops',
  title: 'Site Operations',
  status: 'active',
  contract: { objective: 'Manage the site and its backend, with daily blog drafts for review.', successCriteria: [], invariants: ['Never auto-publish.'] },
  viewEntry: 'view/index.html',
  dataSources: [],
  actions: [{ id: 'approve', label: 'Approve', workflow: 'Publish Blog Draft' }],
  version: 1,
  revisions: [],
  createdAt: '2026-10-16T00:00:00.000Z',
  updatedAt: '2026-10-16T00:00:00.000Z',
  contentMode: 'static_snapshot',
} as never;

const input = {
  request: 'Build a Space to manage the site and its backend, with blog approvals and previews.',
  record,
  viewHtml: '<h1>Site Operations</h1><a href="https://example.test">Open site</a><script>render()</script>',
  feeds: [{ workflow: 'Daily Blog Draft', collections: ['drafts'] }],
};

afterEach(() => _setWorkspaceDeliverablesReaderForTests(null));

test('the checker sees the request beside the saved sources, feeds, buttons and view text', () => {
  const user = JSON.parse(workspaceDeliverablesUser(input));
  assert.equal(user.request, input.request);
  assert.deepEqual(user.workspace.buttons, [{ id: 'approve', label: 'Approve', runs: 'workflow Publish Blog Draft' }]);
  assert.deepEqual(user.workspace.feedWorkflows, [{ workflow: 'Daily Blog Draft', writes: ['drafts'] }]);
  assert.match(user.workspace.viewText, /Site Operations/);
  assert.doesNotMatch(user.workspace.viewText, /render\(\)/, 'scripts are not read as page text');
});

test('what the Workspace does not deliver comes back as what to build next', async () => {
  _setWorkspaceDeliverablesReaderForTests(async () => ({ deliverables: [
    { deliverable: 'Site and deploy status', covered: false, gap: 'Add a feed workflow that reads deploys and pull requests.' },
    { deliverable: 'Blog approvals with previews', covered: true, gap: '' },
  ] }));
  const note = renderWorkspaceDeliverables(await readWorkspaceDeliverables(input));
  assert.match(note, /Not built yet \(1 of 2/);
  assert.match(note, /Site and deploy status — Add a feed workflow/);
  assert.doesNotMatch(note, /Blog approvals/);
});

test('a fully covered Workspace, or a check that cannot run, adds nothing', async () => {
  _setWorkspaceDeliverablesReaderForTests(async () => ({ deliverables: [
    { deliverable: 'Blog approvals with previews', covered: true, gap: '' },
  ] }));
  assert.equal(renderWorkspaceDeliverables(await readWorkspaceDeliverables(input)), '');
  _setWorkspaceDeliverablesReaderForTests(async () => { throw new Error('model unavailable'); });
  assert.equal(await readWorkspaceDeliverables(input), null);
  assert.equal(renderWorkspaceDeliverables(null), '');
});
