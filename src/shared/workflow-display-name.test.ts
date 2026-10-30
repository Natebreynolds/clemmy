/** Run: npx tsx --test src/shared/workflow-display-name.test.ts */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workflowDisplayName, withWorkflowName } from './workflow-display-name.js';
import { workflowDisplayName as appRule } from '../../packages/chat-engine/src/workflow-name.js';

test('the daemon names a workflow exactly as the apps do', () => {
  const cases: Array<[string, string?]> = [
    ['daily-standup-email'], ['end-of-week-team-sales-snapshot'], ['platform-49-slack-channel-review'],
    ['automation-9574eff2192f943e', 'Check the inbox every morning. Then file it.'], ['workflow-1792771701722'],
    ['Mr Jordan Daily Swim Blog Draft'], ['morning_briefing'], ['a-b-in-the-c'], [''],
  ];
  for (const [name, description] of cases) assert.equal(workflowDisplayName(name, description), appRule(name, description), name);
});

test('a title written with the slug reads the name', () => {
  // Live 2026-10-30: "Workflow failed: morning-briefing" sat beside
  // "Workflow failed: Mr Jordan Daily Swim Blog Draft".
  assert.equal(withWorkflowName('Workflow failed: morning-briefing', 'morning-briefing'), 'Workflow failed: Morning Briefing');
  assert.equal(withWorkflowName('Paused "daily-standup-email" after repeated restarts', 'daily-standup-email'),
    'Paused "Daily Standup Email" after repeated restarts');
  assert.equal(withWorkflowName('Finished: Daily brief', 'daily-brief'), 'Finished: Daily brief', 'nothing to swap');
  assert.equal(withWorkflowName('Workflow failed: Mr Jordan', 'Mr Jordan'), 'Workflow failed: Mr Jordan');
  assert.equal(withWorkflowName('Workflow failed: x', undefined), 'Workflow failed: x');
});
