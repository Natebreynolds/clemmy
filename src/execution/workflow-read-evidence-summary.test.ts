import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summarizeWorkflowReadExecutions } from './workflow-read-evidence.js';

test('execution summary shows only verified successful receipt identities, without result payloads', () => {
  const text = summarizeWorkflowReadExecutions({ refKind: 'fixture', refs: () => ['read_receipts/step/1'], resolve: () => ({ text: 'large private payload', value: { results: [
    { toolName: 'read_file', logicalToolCallId: 'actual-call', status: 'verified', outcome: 'succeeded', payload: 'do not inline' },
    { toolName: 'not_executed', logicalToolCallId: 'failed-call', status: 'unavailable', outcome: 'succeeded' },
    { toolName: 'failed', logicalToolCallId: 'failed-call', status: 'verified', outcome: 'failed' },
  ] } }) });
  assert.match(text, /read_file/);
  assert.match(text, /actual-call/);
  assert.doesNotMatch(text, /not_executed|failed-call|private payload|do not inline/);
  assert.equal(summarizeWorkflowReadExecutions({ refKind: 'fixture', refs: () => [], resolve: () => undefined }), '');
});
