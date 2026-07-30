import assert from 'node:assert/strict';
import test from 'node:test';
import {
  WorkspaceRefreshError,
  refreshFailureForResults,
} from './workspace-refresh.js';
import { openApprovalCount, type SpaceNote } from './spaces.js';

test('pending Workspace refreshes become an actionable approval error', () => {
  const failure = refreshFailureForResults([
    {
      ok: false,
      sourceId: 'weekly',
      pendingApprovalId: 'apr-test',
      error: 'runner is awaiting approval',
    },
  ]);
  assert.ok(failure instanceof WorkspaceRefreshError);
  assert.deepEqual(failure.pendingApprovalIds, ['apr-test']);
  assert.match(failure.message, /approval needed/i);
  assert.match(failure.message, /Ask Clem/i);
  assert.match(failure.message, /apr-test/);
});

test('hard refresh failures stay distinct from approval waits', () => {
  const failure = refreshFailureForResults([
    { ok: false, sourceId: 'weekly', error: 'Salesforce session expired' },
  ]);
  assert.ok(failure instanceof WorkspaceRefreshError);
  assert.deepEqual(failure.pendingApprovalIds, []);
  assert.match(failure.message, /Salesforce session expired/);
});

test('Workspace waiting badge includes data-runner cards and clears on every terminal decision', () => {
  const notes = (status: string): SpaceNote[] => [
    {
      id: 'pending',
      text: 'Waiting',
      kind: 'data-source',
      meta: { approvalId: 'apr-runner', status: 'pending' },
      createdAt: '2026-07-30T00:00:00.000Z',
    },
    ...(status === 'pending' ? [] : [{
      id: 'terminal',
      text: status,
      kind: 'data-source',
      meta: { approvalId: 'apr-runner', status },
      createdAt: '2026-07-30T00:01:00.000Z',
    }]),
  ];

  assert.equal(openApprovalCount(notes('pending')), 1);
  for (const status of ['approved', 'rejected', 'expired', 'cancelled_by_user']) {
    assert.equal(openApprovalCount(notes(status)), 0, `${status} must clear the badge`);
  }
});
