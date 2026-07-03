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

test('completionOutputPreview prefers reply over internal summary', () => {
  assert.equal(
    __test__.completionOutputPreview({
      data: { summary: 'Internal log: greeted user; awaiting request.', reply: 'Hey - what can I help with?' },
    }),
    'Hey - what can I help with?',
  );
});

test('completionOutputPreview falls back to summary for legacy completions', () => {
  assert.equal(
    __test__.completionOutputPreview({ data: { summary: 'Legacy public completion.' } }),
    'Legacy public completion.',
  );
});

test('message response serializer preserves route and stop diagnostics', () => {
  assert.deepEqual(
    __test__.serializeMessageResponse({
      text: 'hello',
      sessionId: 'sess-webhook-route',
      runId: 'run-webhook-route',
      stoppedReason: 'max-turns-with-grace',
      turnsUsed: 12,
      route: {
        routeKind: 'harness',
        surface: 'webhook',
        effectiveModel: 'glm-4.5',
        falloverFrom: 'claude_agent_sdk_brain',
      },
    }),
    {
      response: 'hello',
      session_id: 'sess-webhook-route',
      run_id: 'run-webhook-route',
      queued_task_id: undefined,
      pending_approval_id: undefined,
      stopped_reason: 'max-turns-with-grace',
      turns_used: 12,
      route: {
        routeKind: 'harness',
        surface: 'webhook',
        effectiveModel: 'glm-4.5',
        falloverFrom: 'claude_agent_sdk_brain',
      },
    },
  );
});

test('/api/message session resolver accepts snake_case and camelCase ids', () => {
  assert.deepEqual(
    __test__.resolveApiMessageSession({ session_id: 'sess-snake', sessionId: 'sess-camel', user_id: 'user-snake' }),
    { sessionId: 'sess-snake', userId: 'user-snake' },
  );
  assert.deepEqual(
    __test__.resolveApiMessageSession({ sessionId: 'sess-camel', userId: 'user-camel' }),
    { sessionId: 'sess-camel', userId: 'user-camel' },
  );
  assert.deepEqual(
    __test__.resolveApiMessageSession({ userId: 'user-camel' }),
    { sessionId: 'webhook:user-camel', userId: 'user-camel' },
  );
});
