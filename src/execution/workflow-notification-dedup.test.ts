import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldSilenceCompletionEcho } from './workflow-runner.js';

const RUN = 'run-123';

test('success + matching notify_user_tool notification for THIS run → suppress', () => {
  assert.equal(
    shouldSilenceCompletionEcho({
      needsAttention: false,
      runId: RUN,
      notifications: [
        { metadata: { source: 'notify_user_tool', workflowRunId: RUN } },
      ],
    }),
    true,
  );
});

test('success + NO matching notification → deliver', () => {
  assert.equal(
    shouldSilenceCompletionEcho({
      needsAttention: false,
      runId: RUN,
      notifications: [{ metadata: { source: 'some_other_tool' } }, {}],
    }),
    false,
  );
});

test('success + notify_user_tool notification from a DIFFERENT run → deliver (per-run correlation)', () => {
  assert.equal(
    shouldSilenceCompletionEcho({
      needsAttention: false,
      runId: RUN,
      notifications: [
        { metadata: { source: 'notify_user_tool', workflowRunId: 'other-run' } },
      ],
    }),
    false,
  );
});

test('needsAttention=true + matching notification → STILL deliver (never silence reports-back)', () => {
  assert.equal(
    shouldSilenceCompletionEcho({
      needsAttention: true,
      runId: RUN,
      notifications: [
        { metadata: { source: 'notify_user_tool', workflowRunId: RUN } },
      ],
    }),
    false,
  );
});

test('success + matching runId but source !== notify_user_tool → deliver', () => {
  assert.equal(
    shouldSilenceCompletionEcho({
      needsAttention: false,
      runId: RUN,
      notifications: [{ metadata: { source: 'workflow', workflowRunId: RUN } }],
    }),
    false,
  );
});
