import { test } from 'node:test';
import assert from 'node:assert/strict';
import { failedWorkspaceSources, workspaceNeedsSourceRepair } from './workspace-presentation.js';

test('only an explicit static snapshot suppresses the missing-source repair prompt', () => {
  assert.equal(workspaceNeedsSourceRepair({ sourceCount: 0, contentMode: 'static_snapshot' }), false);
  assert.equal(workspaceNeedsSourceRepair({ sourceCount: 0, contentMode: null }), true);
  assert.equal(workspaceNeedsSourceRepair({ sourceCount: 0, contentMode: undefined }), true);
  assert.equal(workspaceNeedsSourceRepair({ sourceCount: 1, contentMode: null }), false);
});

test('the static marker never suppresses a real source failure', () => {
  const sources = [
    { id: 'healthy', ok: true },
    { id: 'failed-refresh', ok: false },
  ];
  assert.deepEqual(failedWorkspaceSources(sources), [{ id: 'failed-refresh', ok: false }]);
});
