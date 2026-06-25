import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __test__ } from './webhook.js';

test('workflow run file fallback preserves needsAttention in activity enrichment', () => {
  const activityRun = __test__.workflowRunRecordAsActivityRun({
    id: 'wf-run-attention',
    workflow: 'daily_digest',
    status: 'completed',
    needsAttention: true,
    createdAt: '2026-06-24T09:00:00.000Z',
    finishedAt: '2026-06-24T09:02:00.000Z',
    output: 'Delivered the report, but the pinned goal was not confirmed.',
  });

  const enriched = __test__.enrichActivityRun(activityRun);

  assert.equal(activityRun.needsAttention, true);
  assert.equal(enriched.status, 'completed');
  assert.equal(enriched.runState, 'needs_attention');
  assert.equal(enriched.statusLabel, 'Needs attention');
  assert.equal(enriched.needsAttention, true);
  assert.equal(enriched.live, false);
  assert.equal(enriched.preview, 'Delivered the report, but the pinned goal was not confirmed.');
});
