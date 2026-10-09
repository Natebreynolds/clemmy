/**
 * Run: node scripts/run-tests-isolated.mjs src/spaces/workflow-feeds.test.ts
 *
 * Which workflows feed which Spaces is read from what the workflows do: a
 * call step writing a Space dataset with an exact, admissible literal Space
 * and collection links them; prose, run-time targets and identities the write
 * itself would refuse never do. The links are derived and kept apart from the
 * formal binding store, and each Space learns its feed's last and next run.
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

test('only an exact, admissible literal target links; run-time, trimmed, reserved targets and prose do not', () => {
  const { writes, notFixed } = feeds.workflowSpaceWrites({
    steps: [
      fetchStep,
      writeStep('post-queue', 'drafts'),
      writeStep('post-queue ', 'drafts', 'padded-slug'),
      writeStep('post-queue', ' drafts', 'padded-source'),
      writeStep('post-queue', '_meta', 'reserved'),
      { id: 'dynamic', prompt: '', call: { tool: 'space_set_data', args: { slug: '{{input.space}}', source_id: 'x', data_json: '{}' } } } as Step,
      { id: 'prose', prompt: 'When done, call space_refresh for post-queue.' } as Step,
    ],
  }, isSpaceWrite);
  assert.deepEqual(writes, [{ workspaceId: 'post-queue', collection: 'drafts', stepId: 'publish' }]);
  assert.deepEqual(notFixed, ['padded-slug', 'padded-source', 'reserved', 'dynamic']);
});

test('derived feeds follow the saved workflows and never touch the formal binding store', async () => {
  store.spaceStore.save({ id: 'post-queue', title: 'Post queue', viewContent: '<p>queue</p>' });
  saveWorkflow('queue-feed', [fetchStep, writeStep('post-queue', 'drafts')]);
  saveWorkflow('queue-metrics', [fetchStep, writeStep('post-queue', 'metrics'), writeStep('ads-watch', 'spend', 'publish-2')]);
  let index = await feeds.rebuildFeedIndex({ isSpaceWrite });
  assert.deepEqual(index.get('post-queue')!.map((l) => [l.workflow, l.collections]), [['queue-feed', ['drafts']], ['queue-metrics', ['metrics']]]);
  assert.deepEqual(index.get('ads-watch')!.map((l) => l.workflow), ['queue-metrics'], 'one workflow may feed two Spaces');

  saveWorkflow('queue-metrics', [fetchStep, writeStep('post-queue', 'metrics')], { enabled: false });
  saveWorkflow('queue-feed', [fetchStep]);
  index = await feeds.rebuildFeedIndex({ isSpaceWrite });
  assert.deepEqual(index.get('post-queue')!.map((l) => [l.workflow, l.enabled]), [['queue-metrics', false]]);
  assert.equal(index.get('ads-watch'), undefined);

  assert.deepEqual(bindings.listWorkflowSurfaceBindingsForWorkspace('post-queue'), [], 'no formal binding row was written');
});

test('a formal binding stays exactly as it was and is shown beside derived feeds', async () => {
  store.spaceStore.save({ id: 'ads-board', title: 'Ads board', viewContent: '<p>ads</p>' });
  const now = new Date().toISOString();
  const binding = {
    version: 1 as const, bindingId: 'pilot-binding-1', workflowId: 'ads-pilot', workspaceId: 'ads-board', revision: 1,
    role: 'primary' as const, projectionVersion: 1 as const, scheduleAuthority: 'workflow' as const, state: 'active' as const, createdAt: now, updatedAt: now,
  };
  const stored = bindings.putWorkflowSurfaceBinding({ binding });
  assert.equal(stored.ok, true);
  saveWorkflow('ads-pilot', [fetchStep]);
  saveWorkflow('ads-feed', [fetchStep, writeStep('ads-board', 'spend')]);
  const index = await feeds.rebuildFeedIndex({ isSpaceWrite });
  const summaries = await feeds.spaceFeedSummaries('ads-board', { links: index.get('ads-board') });
  assert.deepEqual(summaries.map((s) => [s.workflow, s.link, s.role]), [['ads-pilot', 'reviewed', 'primary'], ['ads-feed', 'derived', 'supporting']]);
  const after = bindings.getWorkflowSurfaceBinding('pilot-binding-1')!;
  assert.equal(after.digest, stored.ok ? stored.digest : '', 'the formal binding is byte-for-byte unchanged');
});

test('a Space learns what feeds it: what it fills, its last run and its next one', async () => {
  saveWorkflow('calendar-feed', [fetchStep, writeStep('content-calendar', 'posts')]);
  store.spaceStore.save({ id: 'content-calendar', title: 'Content calendar', viewContent: '<p>cal</p>' });
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

  const index = await feeds.rebuildFeedIndex({ isSpaceWrite });
  const [feed] = await feeds.spaceFeedSummaries('content-calendar', {
    links: index.get('content-calendar'), runsDir, now: new Date('2026-10-09T08:00:00.000Z'),
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
  assert.equal(feed!.scheduled, true);
});

test('next runs: exact within the week, unnamed (but still scheduled) beyond it, across zones', () => {
  const now = new Date('2026-10-09T08:00:00.000Z');
  assert.equal(feeds.nextScheduledRun('30 9 * * *', 'America/Los_Angeles', now), '2026-10-09T16:30:00.000Z');
  assert.equal(feeds.nextScheduledRun('15 6 * * *', 'Asia/Kolkata', now), '2026-10-10T00:45:00.000Z', 'a half-hour zone');
  assert.equal(feeds.nextScheduledRun('0 7 1 * *', 'America/Los_Angeles', now), undefined, 'monthly: beyond the horizon, not invented');
  assert.equal(feeds.nextScheduledRun('not a cron', undefined, now), undefined);
});

test('the registered test recognises the Space dataset write by its execution contract', async () => {
  const registered = await feeds.spaceDatasetWriteTest();
  assert.equal(registered('space_set_data'), true);
  assert.equal(registered('write_file'), false, 'a local file write is not a Space feed');
  assert.equal(registered('space_save'), false);
  assert.equal(registered('GMAIL_SEND_EMAIL'), false);
});
