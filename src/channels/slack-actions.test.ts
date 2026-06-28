/**
 * Run: npx tsx --test src/channels/slack-actions.test.ts
 *
 * Slack sibling of discord-actions.test.ts — verifies the metadata → Block Kit
 * action_id mapping the notification-delivery path uses to attach buttons.
 * Same precedence + the same `clementine:<verb>:<id>` convention as Discord,
 * so the Slack action handler routes them through the identical paths.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { __test__ } from './slack.js';

const { buildSlackActionsForNotification } = __test__;

function actionIds(blocks: ReturnType<typeof buildSlackActionsForNotification>): string[] {
  if (!blocks) return [];
  const ids: string[] = [];
  for (const block of blocks) {
    const elements = (block as { elements?: Array<{ action_id?: string }> }).elements ?? [];
    for (const el of elements) {
      if (el.action_id) ids.push(el.action_id);
    }
  }
  return ids;
}

test('buildSlackActionsForNotification: no metadata returns undefined (plain text)', () => {
  assert.equal(buildSlackActionsForNotification(undefined), undefined);
  assert.equal(buildSlackActionsForNotification({}), undefined);
  assert.equal(buildSlackActionsForNotification({ foo: 'bar' }), undefined);
});

test('buildSlackActionsForNotification: approvalId attaches approve/edit/reject', () => {
  const ids = actionIds(buildSlackActionsForNotification({ approvalId: 'apr-xyz789' }));
  assert.equal(ids.length, 3, 'expected approve, edit, reject');
  assert.ok(ids.includes('clementine:approve:apr-xyz789'));
  assert.ok(ids.includes('clementine:edit:apr-xyz789'));
  assert.ok(ids.includes('clementine:reject:apr-xyz789'));
});

test('buildSlackActionsForNotification: checkInId attaches answer buttons', () => {
  const ids = actionIds(buildSlackActionsForNotification({ checkInId: 'chk-abc123' }));
  assert.equal(ids.length, 3, 'expected approve, answer, reject');
  assert.ok(ids.includes('clementine:checkin-approve:chk-abc123'));
  assert.ok(ids.includes('clementine:checkin-answer:chk-abc123'));
  assert.ok(ids.includes('clementine:checkin-reject:chk-abc123'));
});

test('buildSlackActionsForNotification: stale planProposalId does not attach dead buttons', () => {
  // No matching plan record on disk → undefined/empty, exactly like Discord.
  const ids = actionIds(buildSlackActionsForNotification({ planProposalId: 'plan-does-not-exist' }));
  assert.equal(ids.length, 0);
});

test('buildSlackActionsForNotification: stale goalDraftId does not attach dead buttons', () => {
  const ids = actionIds(buildSlackActionsForNotification({ goalDraftId: 'goal-does-not-exist' }));
  assert.equal(ids.length, 0);
});

test('buildSlackActionsForNotification: non-string ids are ignored', () => {
  assert.equal(buildSlackActionsForNotification({ approvalId: 123 as unknown as string }), undefined);
  assert.equal(buildSlackActionsForNotification({ checkInId: { x: 1 } as unknown as string }), undefined);
});
