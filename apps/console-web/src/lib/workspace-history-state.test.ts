import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { isCurrentWorkspaceDiffScope, type WorkspaceDiffScope } from './workspace-history-state';

function scope(overrides: Partial<WorkspaceDiffScope> = {}): WorkspaceDiffScope {
  return {
    workspaceId: 'workspace-a',
    pageToken: 'page-a1',
    requestId: 7,
    ...overrides,
  };
}

test('a history diff result is current only for the same route, first page, and request', () => {
  const requested = scope();
  assert.equal(isCurrentWorkspaceDiffScope(requested, scope()), true);
  assert.equal(
    isCurrentWorkspaceDiffScope(requested, scope({ workspaceId: 'workspace-b' })),
    false,
    'a response started under workspace A cannot render after routing to B',
  );
  assert.equal(
    isCurrentWorkspaceDiffScope(requested, scope({ pageToken: 'page-a2' })),
    false,
    'a response from an old first page cannot render after that page is replaced',
  );
  assert.equal(
    isCurrentWorkspaceDiffScope(requested, scope({ requestId: 8 })),
    false,
    'a superseded comparison cannot replace the newer result',
  );
});

test('Workspace route identity remounts chat and local async state before rendering another id', () => {
  const source = readFileSync(new URL('../screens/WorkspaceView.tsx', import.meta.url), 'utf8');
  assert.match(
    source,
    /return <WorkspaceViewForId key=\{id\} id=\{id\} \/>;/,
    'A→B route navigation must rebind useChat and discard A-local promises/state',
  );
  assert.match(
    source,
    /workspaceIdRef\.current === requestedWorkspaceId\s*&& historyPageRef\.current === requestedPage/,
    'pagination must also reject a result after the first page is replaced',
  );
});
