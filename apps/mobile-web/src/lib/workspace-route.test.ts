import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mobileWorkspacePath,
  workspaceColdOpenNeedsParent,
  workspaceFromSearch,
  workspaceNavigationIntent,
} from './workspace-route.js';

test('exact mobile Workspace route round-trips one validated detail', () => {
  const path = mobileWorkspacePath('local-llm-content');
  assert.equal(path, '/m/?tab=spaces&workspace=local-llm-content');
  assert.equal(workspaceFromSearch(new URL(path, 'https://phone.test').search), 'local-llm-content');
});

test('Workspace selection cannot escape its exact tab or slug namespace', () => {
  assert.equal(workspaceFromSearch('?tab=home&workspace=local-llm-content'), null);
  assert.equal(workspaceFromSearch('?tab=spaces&workspace=../secrets'), null);
  assert.equal(workspaceFromSearch('?tab=spaces&workspace=UPPER'), null);
  assert.equal(workspaceFromSearch('?tab=spaces'), null);
  assert.throws(() => mobileWorkspacePath('../secrets'), /invalid Workspace slug/);
});

test('cold handoff, tap, native back, and arrow back share one exact history contract', () => {
  const deep = '?tab=spaces&workspace=local-llm-content';
  assert.equal(workspaceColdOpenNeedsParent(deep, null), true, 'cold link needs a list parent');
  assert.equal(
    workspaceColdOpenNeedsParent(deep, { clemWorkspace: 'local-llm-content' }),
    false,
    'the normalized pushed entry is not duplicated',
  );
  assert.deepEqual(workspaceNavigationIntent({ search: '?tab=spaces', historyState: null, next: 'local-llm-content' }), {
    kind: 'push',
    path: '/m/?tab=spaces&workspace=local-llm-content',
    state: { clemWorkspace: 'local-llm-content' },
  });
  assert.deepEqual(workspaceNavigationIntent({
    search: deep,
    historyState: { clemWorkspace: 'local-llm-content' },
    next: null,
  }), { kind: 'back' });
  assert.deepEqual(workspaceNavigationIntent({ search: deep, historyState: null, next: null }), { kind: 'replace_list' });
});
