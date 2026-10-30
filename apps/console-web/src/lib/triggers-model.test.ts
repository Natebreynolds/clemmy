/** Run with scripts/run-tests-isolated.mjs; no daemon, providers, or home needed. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextUp, scheduledWorkflows, webhookWorkflows, webhookAddress, eventWorkflows, workflowKinds, whenLabel } from './triggers-model';
import type { TriggersView, TriggerWorkflowRow } from './triggers';

const NOW = Date.parse('2026-10-28T18:00:00.000Z');
const workflow = (overrides: Partial<TriggerWorkflowRow>): TriggerWorkflowRow => ({
  name: 'Daily brief', slug: 'daily-brief', enabled: true, description: null, schedule: null, timezone: null, onceAt: null,
  interval: null, webhookPath: null, webhookKey: null, events: [], manual: false, lastRun: null, ...overrides,
});
const view = (overrides: Partial<TriggersView> = {}): TriggersView => ({
  generatedAt: new Date(NOW).toISOString(), workflows: [], upcoming: [], watches: [], reminders: [], webhookBase: 'http://127.0.0.1:8520/api/hooks/workflows/', ...overrides,
});

test('next up merges schedules, one-shots and reminders soonest first, and skips paused workflows and the past', () => {
  const v = view({
    workflows: [
      workflow({ name: 'Daily brief', schedule: '0 8 * * *' }),
      workflow({ name: 'Paused one', schedule: '0 9 * * *', enabled: false }),
      workflow({ name: 'Board sync', onceAt: '2026-10-28T19:30:00.000Z' }),
    ],
    upcoming: [
      { workflowName: 'Daily brief', at: '2026-10-29T08:00:00.000Z', schedule: '0 8 * * *' },
      { workflowName: 'Paused one', at: '2026-10-28T18:30:00.000Z', schedule: '0 9 * * *' },
      { workflowName: 'Daily brief', at: '2026-10-28T08:00:00.000Z', schedule: '0 8 * * *' },
    ],
    reminders: [{ id: 'timer-aaaaaaaa', message: 'Call the dentist', fireAt: '2026-10-28T18:20:00.000Z', createdAt: '2026-10-28T17:00:00.000Z' }],
  });
  assert.deepEqual(nextUp(v, NOW).map((item) => `${item.kind}:${item.title}`), ['reminder:Call the dentist', 'once:Board sync', 'schedule:Daily brief']);
});

test('each kind lists its own rows and a workflow can be several kinds at once', () => {
  const both = workflow({ name: 'Lead intake', schedule: '*/30 * * * *', webhookPath: 'lead-intake', events: ['composio.gmail.new_message'] });
  const v = view({ workflows: [both, workflow({ name: 'Manual only', manual: true })] });
  assert.deepEqual(workflowKinds(both), ['schedule', 'webhook', 'event']);
  assert.deepEqual(scheduledWorkflows(v).map((row) => row.name), ['Lead intake']);
  assert.deepEqual(webhookWorkflows(v).map((row) => row.name), ['Lead intake']);
  assert.deepEqual(eventWorkflows(v).map((row) => row.name), ['Lead intake']);
});

test('timeline uses readable workflow and schedule labels with an exact existing workflow destination', () => {
  const v = view({
    workflows: [workflow({name:'automation-1234567890abcdef', slug:'canonical-alias', description:'Prepare the weekly customer brief.', schedule:'0 9 * * 1-5', timezone:'America/Los_Angeles'}), workflow({name:'paused-workflow', slug:'paused-alias', enabled:false})],
    upcoming: [
      {workflowName:'canonical-alias', at:new Date(NOW + 60_000).toISOString(), schedule:'0 9 * * 1-5'},
      {workflowName:'paused-alias', at:new Date(NOW + 120_000).toISOString(), schedule:'0 9 * * 1-5'},
    ],
    reminders: [{id:'reminder-controlled', message:'Remember my 0 9 * * 1-5 example', fireAt:new Date(NOW + 180_000).toISOString(), createdAt:new Date(NOW).toISOString()}],
  });
  const items = nextUp(v, NOW);
  assert.equal(items.length, 2, 'the paused alias stays excluded');
  assert.equal(items[0].title, 'Prepare the weekly customer brief');
  assert.match(items[0].detail, /Every weekday at 9:00 AM/);
  assert.equal(items[0].technicalDetail, '0 9 * * 1-5');
  assert.equal(items[0].href, '/automate/automation-1234567890abcdef');
  assert.equal(items[1].title, 'Remember my 0 9 * * 1-5 example');
  assert.equal(items[1].href, undefined, 'a reminder gets no invented workflow or dispatch target');
});

test('when labels read as a person says them', () => {
  assert.equal(whenLabel(new Date(NOW + 5 * 60_000).toISOString(), NOW), 'in 5 min');
  assert.equal(whenLabel(new Date(NOW + 3 * 3_600_000).toISOString(), NOW), 'in 3 h');
  assert.match(whenLabel(new Date(NOW + 30 * 3_600_000).toISOString(), NOW), /^tomorrow /);
  assert.equal(whenLabel('not a date', NOW), '');
});

test('a webhook\'s address carries the hook\'s own key, never the console token', () => {
  const view = { webhookBase: 'https://clem.local/api/hooks/workflows/' };
  assert.equal(webhookAddress(view, { webhookPath: 'lead-intake', webhookKey: 'k_abc' }), 'https://clem.local/api/hooks/workflows/lead-intake?key=k_abc');
  assert.equal(webhookAddress(view, { webhookPath: 'lead-intake', webhookKey: null }), 'https://clem.local/api/hooks/workflows/lead-intake');
});
