/**
 * Run: npx tsx --test src/agents/proactive-briefs.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isActiveBackgroundTaskForBrief,
  singleApprovalMetadataForBrief,
} from './proactive-briefs.js';
import type { PendingApprovalRow } from '../runtime/harness/approval-registry.js';

function approvalRow(overrides: Partial<PendingApprovalRow> = {}): PendingApprovalRow {
  return {
    approvalId: 'apr-live',
    sessionId: 'sess-live',
    channel: 'workflow',
    channelId: null,
    requestedAt: new Date(Date.now() - 11 * 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    subject: 'Send the pending cold-prospect emails from the outreach sheet',
    tool: 'request_approval',
    args: null,
    status: 'pending',
    resolution: null,
    resolver: null,
    resolvedAt: null,
    ...overrides,
  };
}

test('brief task filter drops awaiting_approval tasks whose approval no longer exists', () => {
  const liveApprovals = new Set(['apr-live']);

  assert.equal(
    isActiveBackgroundTaskForBrief({ status: 'awaiting_approval', pendingApprovalId: 'apr-live' }, liveApprovals),
    true,
  );
  assert.equal(
    isActiveBackgroundTaskForBrief({ status: 'awaiting_approval', pendingApprovalId: 'apr-stale' }, liveApprovals),
    false,
  );
  assert.equal(
    isActiveBackgroundTaskForBrief({ status: 'running', pendingApprovalId: 'apr-stale' }, liveApprovals),
    true,
  );
});

test('brief metadata exposes one approval id for Discord buttons only when unambiguous', () => {
  assert.deepEqual(singleApprovalMetadataForBrief([approvalRow()]), {
    approvalId: 'apr-live',
    approvalSessionId: 'sess-live',
    approvalSubject: 'Send the pending cold-prospect emails from the outreach sheet',
  });
  assert.deepEqual(singleApprovalMetadataForBrief([]), {});
  assert.deepEqual(singleApprovalMetadataForBrief([approvalRow(), approvalRow({ approvalId: 'apr-other' })]), {});
});
