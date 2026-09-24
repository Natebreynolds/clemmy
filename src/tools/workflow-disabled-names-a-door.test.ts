import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { disabledWorkflowRunMessage } from './workflow-verification-state.js';

const ADMIT = readFileSync(new URL('./admit-named-workflow-run.ts', import.meta.url), 'utf8');
const QUEUE = readFileSync(new URL('./workflow-run-queue.ts', import.meta.url), 'utf8');

for (const [label, src] of [['admit', ADMIT], ['queue', QUEUE]]) {
  test(`${label}: a disabled saved workflow retains the requested execution and names its enablement door`, () => {
    assert.match(src, /disabledWorkflowRunMessage\(/, 'both entry points share the recovery guidance');
    const message = disabledWorkflowRunMessage('Quarterly refresh');
    assert.match(message, /Quarterly refresh/);
    assert.match(message, /no execution was queued/);
    assert.match(message, /already authorized, use workflow_set_enabled/);
    assert.match(message, /otherwise ask whether to enable/);
    assert.match(message, /Do not substitute ad-hoc work or claim completion/);
  });
}

test('pending workflow verification names the existing run and preserves the requested business execution', () => {
  const message = disabledWorkflowRunMessage('Quarterly refresh', 'verification-42');
  assert.match(message, /verification-42/);
  assert.match(message, /read-only steps and previews mutations/);
  assert.match(message, /NOT been queued/);
  assert.match(message, /After verification passes.*workflow_run/);
  assert.match(message, /Do not recreate it, repeatedly enable it/);
});

test('admit: a missing workflow also names the direct door', () => {
  const i = ADMIT.indexOf('not found.');
  assert.ok(i > 0);
  const block = ADMIT.slice(i, i + 500);
  assert.match(block, /block the work/, 'absence is not incapacity');
  assert.match(block, /tool_search/, 'and the door is named');
});
