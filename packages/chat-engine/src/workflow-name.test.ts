import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workflowCaption, workflowDisplayName } from './workflow-name.js';

test('a slug becomes words; the slug stays as the caption', () => {
  assert.equal(workflowDisplayName('daily-overdue-salesforce-meetings'), 'Daily Overdue Salesforce Meetings');
  assert.equal(workflowDisplayName('platform-49-slack-channel-review'), 'Platform 49 Slack Channel Review');
  assert.equal(workflowDisplayName('team_activity_slack_updates'), 'Team Activity Slack Updates');
  assert.equal(workflowCaption('daily-overdue-salesforce-meetings'), 'daily-overdue-salesforce-meetings');
});

test('a name that already is words is left exactly alone', () => {
  assert.equal(workflowDisplayName('Clem qualification 20260907 B'), 'Clem qualification 20260907 B');
  assert.equal(workflowDisplayName('Digest check'), 'Digest check');
  assert.equal(workflowCaption('Digest check'), '');
});

test('a machine-minted slug takes its title from the description, and never shows a hash as a title', () => {
  assert.equal(
    workflowDisplayName('automation-9574eff2192f943e', 'Controlled framework acceptance test: use the enabled provider\'s free documentation inventory.'),
    'Controlled framework acceptance test',
  );
  assert.equal(workflowDisplayName('harness-multistep-1789867033991'), 'Harness Multistep');
  assert.equal(workflowDisplayName('automation-9574eff2192f943e'), 'Automation 9574ef');
  assert.equal(workflowCaption('automation-9574eff2192f943e', 'x'), 'automation-9574eff2192f943e');
});

test('a long description is cut at a word, never mid-word', () => {
  const long = 'Give Nate a business-hours read of the Platform question channel refreshed every two hours with everything anyone raised';
  const title = workflowDisplayName('automation-abcdef0123456789', long);
  assert.ok(title.length <= 65, title);
  assert.ok(title.endsWith('…'));
  assert.ok(!/\s…$/.test(title));
});
