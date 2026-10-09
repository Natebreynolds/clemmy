/**
 * Run: node scripts/run-tests-isolated.mjs src/spaces/workflow-feeds.test.ts
 *
 * Which workflows feed which Spaces is read from what the workflows do: a
 * call step writing a Space dataset with a literal Space binds them; prose
 * never does. The bindings follow every workflow change, and each Space
 * learns its feed's last and next run.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-workflow-feeds-test-'));
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';

const store = await import('./store.js');
const workflowStore = await import('../memory/workflow-store.js');
const feeds = await import('./workflow-feeds.js');
const bindings = await import('./workflow-surface-binding-store.js');

/** Stands in for the registry test: in production this is the reviewed local
 *  tool whose execution commits a Space dataset. */
const isSpaceWrite = (tool: string) => tool === 'space_set_data';

type Step = Parameters<typeof workflowStore.writeWorkflow>[1]['steps'][number];
const fetchStep: Step = { id: 'fetch', prompt: '', call: { tool: 'EXAMPLE_LIST_ITEMS', args: {} }, sideEffect: 'read' } as Step;
const writeStep = (slug: string, source = 'items', id = 'publish'): Step => ({
  id,
  prompt: '',
  dependsOn: ['fetch'],
  call: { tool: 'space_set_data', args: { slug, source_id: source, data_json: '{{steps.fetch.output}}' } },
  sideEffect: 'write',
} as Step);

function saveWorkflow(name: string, steps: Step[], extra: Record<string, unknown> = {}) {
  workflowStore.writeWorkflow(name, {
    name,
    description: `Feeds a test Space (${name}).`,
    enabled: true,
    trigger: { manual: true, schedule: '0 7 * * 1-5', timezone: 'America/Los_Angeles' },
    steps,
    ...extra,
  } as Parameters<typeof workflowStore.writeWorkflow>[1]);
}

const feedRows = (slug: string) => bindings.listWorkflowSurfaceBindingsForWorkspace(slug)
  .filter((b) => b.bindingId.startsWith(feeds.FEED_BINDING_PREFIX))
  .map((b) => ({ workflow: b.workflowId, role: b.role, state: b.state }));

test('a call step writing a literal Space binds; a run-time Space, another tool or prose does not', () => {
  const { writes, chosenAtRun } = feeds.workflowSpaceWrites({
    steps: [
      fetchStep,
      writeStep('post-queue', 'drafts'),
      { id: 'dynamic', prompt: '', call: { tool: 'space_set_data', args: { slug: '{{input.space}}', source_id: 'x', data_json: '{}' } } } as Step,
      { id: 'prose', prompt: 'When done, call space_refresh for post-queue.' } as Step,
    ],
  }, isSpaceWrite);
  assert.deepEqual(writes, [{ workspaceId: 'post-queue', collection: 'drafts', stepId: 'publish' }]);
  assert.deepEqual(chosenAtRun, ['dynamic']);
});

test('feed bindings follow the workflows: primary, supporting, paused, retired, promoted', async () => {
  store.spaceStore.save({ id: 'post-queue', title: 'Post queue', viewContent: '<p>queue</p>' });

  saveWorkflow('queue-feed', [fetchStep, writeStep('post-queue', 'drafts')]);
  let result = await feeds.reconcileWorkflowFeeds({ isSpaceWrite });
  assert.deepEqual(result.bound, ['feed:queue-feed:post-queue']);
  assert.deepEqual(feedRows('post-queue'), [{ workflow: 'queue-feed', role: 'primary', state: 'active' }]);

  // Unchanged workflows: nothing to do.
  result = await feeds.reconcileWorkflowFeeds({ isSpaceWrite });
  assert.deepEqual([result.bound, result.changed, result.retired], [[], [], []]);

  saveWorkflow('queue-metrics', [fetchStep, writeStep('post-queue', 'metrics')]);
  await feeds.reconcileWorkflowFeeds({ isSpaceWrite });
  assert.deepEqual(
    feedRows('post-queue').sort((a, b) => a.workflow.localeCompare(b.workflow)),
    [
      { workflow: 'queue-feed', role: 'primary', state: 'active' },
      { workflow: 'queue-metrics', role: 'supporting', state: 'active' },
    ],
  );

  saveWorkflow('queue-metrics', [fetchStep, writeStep('post-queue', 'metrics')], { enabled: false });
  await feeds.reconcileWorkflowFeeds({ isSpaceWrite });
  assert.equal(feedRows('post-queue').find((r) => r.workflow === 'queue-metrics')!.state, 'paused', 'a disabled feed is paused, not gone');

  // The primary stops writing this Space: it retires and the other feed leads.
  saveWorkflow('queue-feed', [fetchStep]);
  result = await feeds.reconcileWorkflowFeeds({ isSpaceWrite });
  assert.deepEqual(result.retired, ['feed:queue-feed:post-queue']);
  const rows = feedRows('post-queue');
  assert.equal(rows.find((r) => r.workflow === 'queue-feed')!.state, 'retired');
  assert.equal(rows.find((r) => r.workflow === 'queue-metrics')!.role, 'primary');
});

test('a workflow saved before its Space waits, then binds once the Space exists', async () => {
  saveWorkflow('calendar-feed', [fetchStep, writeStep('content-calendar', 'posts')]);
  const before = await feeds.reconcileWorkflowFeeds({ isSpaceWrite });
  assert.ok(before.waiting.includes('feed:calendar-feed:content-calendar'));
  store.spaceStore.save({ id: 'content-calendar', title: 'Content calendar', viewContent: '<p>cal</p>' });
  const after = await feeds.reconcileWorkflowFeeds({ isSpaceWrite });
  assert.ok(after.bound.includes('feed:calendar-feed:content-calendar'));
});

test('a binding another writer owns is never re-roled or retired', async () => {
  store.spaceStore.save({ id: 'ads-watch', title: 'Ads watch', viewContent: '<p>ads</p>' });
  const now = new Date().toISOString();
  const foreign = bindings.putWorkflowSurfaceBinding({
    binding: {
      version: 1, bindingId: 'pilot-binding-1', workflowId: 'ads-pilot', workspaceId: 'ads-watch', revision: 1,
      role: 'primary', projectionVersion: 1, scheduleAuthority: 'workflow', state: 'active', createdAt: now, updatedAt: now,
    },
  });
  assert.equal(foreign.ok, true);
  saveWorkflow('ads-feed', [fetchStep, writeStep('ads-watch', 'spend')]);
  await feeds.reconcileWorkflowFeeds({ isSpaceWrite });
  const all = bindings.listWorkflowSurfaceBindingsForWorkspace('ads-watch');
  assert.equal(all.find((b) => b.bindingId === 'pilot-binding-1')!.role, 'primary');
  assert.equal(all.find((b) => b.bindingId === 'feed:ads-feed:ads-watch')!.role, 'supporting');
});

test('a Space learns what feeds it: what it fills, its last run and its next one', async () => {
  const runsDir = path.join(process.env.CLEMENTINE_HOME!, 'workflows', 'runs');
  mkdirSync(runsDir, { recursive: true });
  const record = (id: string, workflow: string, status: string, startedAt: string, extra: Record<string, unknown> = {}) => {
    const file = path.join(runsDir, `${id}.json`);
    writeFileSync(file, JSON.stringify({ id, workflow, status, startedAt, finishedAt: startedAt, ...extra }));
    const t = new Date(startedAt);
    utimesSync(file, t, t);
  };
  record('run-old', 'calendar-feed', 'completed', '2026-10-07T14:00:00.000Z');
  record('run-new', 'calendar-feed', 'error', '2026-10-08T14:00:00.000Z', { error: 'The calendar account needs reconnecting.' });
  record('run-other', 'something-else', 'completed', '2026-10-08T15:00:00.000Z');

  const [feed] = await feeds.spaceFeedSummaries('content-calendar', {
    isSpaceWrite, runsDir, now: new Date('2026-10-09T08:00:00.000Z'),
  });
  assert.equal(feed!.workflow, 'calendar-feed');
  assert.equal(feed!.role, 'primary');
  assert.deepEqual(feed!.collections, ['posts']);
  assert.deepEqual(feed!.lastRun, {
    id: 'run-new', state: 'failed', at: '2026-10-08T14:00:00.000Z', finishedAt: '2026-10-08T14:00:00.000Z',
    problem: 'The calendar account needs reconnecting.',
  });
  // Weekdays at 7:00 in Los Angeles: Friday 2026-10-09 14:00 UTC.
  assert.equal(feed!.nextRunAt, '2026-10-09T14:00:00.000Z');
});

test('the registered test recognises the Space dataset write by its execution contract', async () => {
  const registered = await feeds.spaceDatasetWriteTest();
  assert.equal(registered('space_set_data'), true);
  assert.equal(registered('write_file'), false, 'a local file write is not a Space feed');
  assert.equal(registered('space_save'), false);
  assert.equal(registered('GMAIL_SEND_EMAIL'), false);
});
