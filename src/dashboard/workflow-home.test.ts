import { test } from 'node:test';
import assert from 'node:assert/strict';
import { upcomingWorkflowOccurrences } from './console-routes.js';

// The two legacy-renderer tests that lived here (asserting renderConsoleHtml's
// inline HTML/scripts) were removed 2026-07-21 with console.ts — that surface
// is now the React SPA (apps/console-web), tested there. The schedule-
// aggregation logic below is renderer-independent and stays.

function workflow(name: string, schedule: string, enabled = true): any {
  return {
    name,
    layout: 'directory',
    data: {
      name,
      description: `${name} description`,
      enabled,
      trigger: schedule ? { manual: true, schedule } : { manual: true },
      steps: [{ id: 'step', prompt: 'Do the work.' }],
    },
  };
}

test('workflow home schedule aggregation omits disabled and malformed schedules', () => {
  const now = new Date(2026, 4, 28, 12, 0, 0);
  const occurrences = upcomingWorkflowOccurrences([
    workflow('daily-enabled', '30 12 * * *', true),
    workflow('weekday-enabled', '45 12 * * 1-5', true),
    workflow('disabled', '30 12 * * *', false),
    workflow('manual', '', true),
    workflow('malformed', 'not a cron', true),
  ], now, 1);
  const names = new Set(occurrences.map((item) => item.workflowName));
  assert.equal(names.has('daily-enabled'), true);
  assert.equal(names.has('weekday-enabled'), true);
  assert.equal(names.has('disabled'), false);
  assert.equal(names.has('manual'), false);
  assert.equal(names.has('malformed'), false);
});
