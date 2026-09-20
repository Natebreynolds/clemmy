import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveWorkflowUsageSource, withWorkflowUsageAttribution } from './workflow-usage-context.js';

test('concurrent workflow calls retain their run without stealing step or chat identity', async () => {
  await Promise.all(['one', 'two'].map(runId => withWorkflowUsageAttribution(runId, async () => {
    await Promise.resolve();
    assert.equal(resolveWorkflowUsageSource('unknown'), `workflow:${runId}`);
    assert.equal(resolveWorkflowUsageSource(`workflow:${runId}:step`), `workflow:${runId}:step`);
    assert.equal(resolveWorkflowUsageSource('chat-owner'), 'chat-owner');
  })));
  assert.equal(resolveWorkflowUsageSource('unknown'), 'unknown');
});

test('nested run restores outer accounting scope even after rejection', async () => {
  await withWorkflowUsageAttribution('outer', async () => {
    await assert.rejects(withWorkflowUsageAttribution('inner', async () => {
      assert.equal(resolveWorkflowUsageSource('unknown'), 'workflow:inner');
      throw new Error('failed review');
    }));
    assert.equal(resolveWorkflowUsageSource('unknown'), 'workflow:outer');
  });
});
