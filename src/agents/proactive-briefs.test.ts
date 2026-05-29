/**
 * Run: npx tsx --test src/agents/proactive-briefs.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  approvalSummaryMetadataForBrief,
  discordUserIdForProactiveBrief,
  isActiveBackgroundTaskForBrief,
  shouldSendBrief,
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

test('brief metadata summarizes approvals without creating Discord action buttons', () => {
  assert.deepEqual(approvalSummaryMetadataForBrief([approvalRow()]), {
    approvalIds: ['apr-live'],
    approvalSubjects: ['Send the pending cold-prospect emails from the outreach sheet'],
  });
  assert.deepEqual(approvalSummaryMetadataForBrief([]), {});
  assert.deepEqual(approvalSummaryMetadataForBrief([approvalRow(), approvalRow({ approvalId: 'apr-other', subject: 'Second approval' })]), {
    approvalIds: ['apr-live', 'apr-other'],
    approvalSubjects: ['Send the pending cold-prospect emails from the outreach sheet', 'Second approval'],
  });
});

test('proactive briefs do not fan out to Discord by default', () => {
  assert.equal(discordUserIdForProactiveBrief(true), undefined);
  assert.equal(discordUserIdForProactiveBrief(false), undefined);
});

test('brief dedupe suppresses same urgent attention when active work churns', () => {
  const now = Date.parse('2026-05-28T04:40:00.000Z');
  const recentState = {
    lastBriefAt: new Date(now - 10 * 60_000).toISOString(),
    lastSignature: 'old-active-work-signature',
    lastAttentionSignature: 'same-approval',
  };

  assert.equal(
    shouldSendBrief(recentState, 'new-active-work-signature', 'same-approval', 60, true, now),
    false,
  );
  assert.equal(
    shouldSendBrief(recentState, 'new-active-work-signature', 'different-approval', 60, true, now),
    true,
  );
  assert.equal(
    shouldSendBrief({
      ...recentState,
      lastBriefAt: new Date(now - 5 * 60 * 60_000).toISOString(),
    }, 'new-active-work-signature', 'same-approval', 60, true, now),
    false,
  );
});

test('brief dedupe can explicitly repeat stale attention when opted in', () => {
  const previous = process.env.CLEMMY_PROACTIVE_REPEAT_STALE_ATTENTION;
  process.env.CLEMMY_PROACTIVE_REPEAT_STALE_ATTENTION = 'true';
  try {
    const now = Date.parse('2026-05-28T04:40:00.000Z');
    assert.equal(
      shouldSendBrief({
        lastBriefAt: new Date(now - 5 * 60 * 60_000).toISOString(),
        lastSignature: 'old-active-work-signature',
        lastAttentionSignature: 'same-approval',
      }, 'new-active-work-signature', 'same-approval', 60, true, now),
      true,
    );
  } finally {
    if (previous === undefined) delete process.env.CLEMMY_PROACTIVE_REPEAT_STALE_ATTENTION;
    else process.env.CLEMMY_PROACTIVE_REPEAT_STALE_ATTENTION = previous;
  }
});
