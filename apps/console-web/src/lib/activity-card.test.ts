import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activityCardHead, clockLabel, groupActivityByParent, stepElapsed, summarizeActivity } from './activity-card.js';
import type { ActivityItem } from './useChat.js';

const row = (over: Partial<ActivityItem>): ActivityItem => ({ id: 't1', kind: 'tool', label: 'Read Salesforce', status: 'done', ...over });

test('live head names the current step, then helpers if nothing is in flight', () => {
  const current = activityCardHead([
    row({ id: 'a', status: 'done', startedAt: 1000, finishedAt: 2400 }),
    row({ id: 't', label: 'Reading the inbox', status: 'running', startedAt: 2500 }),
  ], true, 5000);
  assert.equal(current.title, 'Reading the inbox');
  assert.equal(current.running, 1);

  const helpers = activityCardHead([
    row({ id: 'a', status: 'done', startedAt: 1000, finishedAt: 2400 }),
    row({ id: 'h', kind: 'agent', label: 'Researcher', status: 'running', startedAt: 2000 }),
  ], true, 5000);
  assert.equal(helpers.title, 'Researcher');
  assert.equal(helpers.running, 1);
  assert.equal(helpers.helpers, 1);
  assert.equal(helpers.startedAt, 1000);
  assert.equal(helpers.totalMs, undefined, 'a live turn has no total yet');
});

test('a settled head leads with results and carries the total elapsed', () => {
  const head = activityCardHead([
    row({ id: 'a', startedAt: 1000, finishedAt: 2400 }),
    row({ id: 'b', label: 'Read calendar', startedAt: 2500, finishedAt: 3200 }),
    row({ id: 'w', kind: 'event', variant: 'write', label: 'Sent a message', tone: 'success' }),
  ], false, 9000);
  assert.equal(head.title, '1 thing sent or written · looked at 2 things');
  assert.equal(head.running, 0);
  assert.equal(head.totalMs, 2200);
});

test('a published work plan outranks the tool count in the summary', () => {
  assert.equal(summarizeActivity([
    row({ id: 'work:1', kind: 'check', label: 'Research complete', tone: 'success' }),
    row({ id: 'work:2', kind: 'check', label: 'Create sheet — blocked', tone: 'warning' }),
    row({ id: 't', status: 'done' }),
  ]), 'Research complete · Create sheet — blocked');
});

test('step elapsed ticks while running, freezes on finish, and stays blank without an anchor', () => {
  assert.equal(stepElapsed({ status: 'running', startedAt: 1000 }, 2400, true), '1.4s');
  assert.equal(stepElapsed({ status: 'done', startedAt: 1000, finishedAt: 13_000 }, 99_999, false), '12s');
  assert.equal(stepElapsed({ status: 'done', startedAt: 1000, finishedAt: 65_000 }, 99_999, false), '1m 4s');
  assert.equal(stepElapsed({ status: 'done', startedAt: 1000 }, 99_999, false), '', 'a settled row without finishedAt cannot claim a duration');
  assert.equal(stepElapsed({ status: 'running' }, 99_999, true), '');
});

test('the card clock reads m:ss', () => {
  assert.equal(clockLabel(1000, 43_400), '0:42');
  assert.equal(clockLabel(undefined, 43_400), '');
});

test('helper steps nest under their helper; orphans stay top-level', () => {
  const { top, children } = groupActivityByParent([
    row({ id: 'h', kind: 'agent', label: 'Researcher', status: 'running' }),
    row({ id: 'c1', label: 'Read Sheets', parentId: 'h' }),
    row({ id: 'c2', label: 'Searched web', parentId: 'h' }),
    row({ id: 'orphan', label: 'Read mail', parentId: 'missing' }),
  ]);
  assert.deepEqual(top.map((r) => r.id), ['h', 'orphan']);
  assert.deepEqual(children.get('h')?.map((r) => r.id), ['c1', 'c2']);
});
