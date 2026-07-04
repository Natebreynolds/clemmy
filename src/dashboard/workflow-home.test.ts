import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { renderConsoleHtml } from './console.js';
import { upcomingWorkflowOccurrences } from './console-routes.js';

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

test('workflow dashboard inline scripts compile and expose the home controls', () => {
  const html = renderConsoleHtml('test-token');
  assert.match(html, /data-wf-home/);
  assert.match(html, /Workflow home/);
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .map((match) => match[1])
    .filter((script) => script.trim());
  assert.ok(scripts.length >= 1);
  scripts.forEach((script, index) => {
    new vm.Script(script, { filename: `console-inline-${index}.js` });
  });
});

test('workflow dashboard exposes the run inspector + board cockpit controls', () => {
  const html = renderConsoleHtml('test-token');
  // Board entry point + view.
  assert.match(html, /data-wf-board/);
  assert.match(html, /Task board/);
  // The board consumes the never-before-fetched board + queue endpoints.
  assert.match(html, /\/api\/console\/board/);
  assert.match(html, /\/board\/run\//);
  // Run inspector open hook + its functions (proves the past-run event replay
  // path exists; the compile assertion above proves the script parses).
  assert.match(html, /data-wf-run-open/);
  assert.match(html, /openRunInspector/);
  assert.match(html, /buildRunInspectorModel/);
  // Inspector renders attempt records, judge/quality verdicts (step_advisory),
  // run summary, and per-step tokens — the full T4.2 event set.
  assert.match(html, /attempt_record/);
  assert.match(html, /step_advisory/);
  assert.match(html, /renderInspectorAdvisories/);
  assert.match(html, /run_summary/);
  assert.match(html, /inspStepTokens/);
});
