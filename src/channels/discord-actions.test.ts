/**
 * Run: npx tsx --test src/channels/discord-actions.test.ts
 *
 * Verifies the metadata → ActionRow mapping the notification-delivery
 * path uses to decide whether to attach buttons.
 *
 * Plan-proposal metadata wins over approvalId when both are present
 * — plan-scoped approval is the higher-level construct, the SDK
 * interrupt id is just the lower-level mechanism it covers.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildActionsForNotification, discordSlashCommandNamesForTest } from './discord.js';

function customIds(rows: ReturnType<typeof buildActionsForNotification>): string[] {
  if (!rows) return [];
  const ids: string[] = [];
  for (const row of rows) {
    const components = (row as { components?: Array<{ data?: { custom_id?: string } }> }).components ?? [];
    for (const comp of components) {
      const id = comp?.data?.custom_id;
      if (id) ids.push(id);
    }
  }
  return ids;
}

test('buildActionsForNotification: no metadata returns undefined (plain text DM)', () => {
  assert.equal(buildActionsForNotification(undefined), undefined);
  assert.equal(buildActionsForNotification({}), undefined);
  assert.equal(buildActionsForNotification({ foo: 'bar' }), undefined);
});

test('buildActionsForNotification: planProposalId attaches plan buttons', () => {
  const rows = buildActionsForNotification({ planProposalId: 'plan-abc123' });
  const ids = customIds(rows);
  assert.equal(ids.length, 3, 'expected 3 buttons: approve, reject, view');
  assert.ok(ids.some((id) => id.includes('plan-approve:plan-abc123')));
  assert.ok(ids.some((id) => id.includes('plan-reject:plan-abc123')));
  assert.ok(ids.some((id) => id.includes('plan-view:plan-abc123')));
});

test('buildActionsForNotification: approvalId attaches SDK approve/edit/reject', () => {
  const rows = buildActionsForNotification({ approvalId: 'appr-xyz789' });
  const ids = customIds(rows);
  // 2026-05-21: Edit added so workflow approval notifications match the
  // chat-dock and discord-harness paths (Approve / Edit / Reject).
  assert.equal(ids.length, 3, 'expected 3 buttons: approve, edit, reject');
  assert.ok(ids.some((id) => id.includes('approve:appr-xyz789')));
  assert.ok(ids.some((id) => id.includes('edit:appr-xyz789')));
  assert.ok(ids.some((id) => id.includes('reject:appr-xyz789')));
});

test('buildActionsForNotification: checkInId attaches answer buttons', () => {
  const rows = buildActionsForNotification({ checkInId: 'chk-abc123' });
  const ids = customIds(rows);
  assert.equal(ids.length, 3, 'expected 3 buttons: approve, answer, reject');
  assert.ok(ids.some((id) => id.includes('checkin-approve:chk-abc123')));
  assert.ok(ids.some((id) => id.includes('checkin-answer:chk-abc123')));
  assert.ok(ids.some((id) => id.includes('checkin-reject:chk-abc123')));
});

test('buildActionsForNotification: planProposalId beats approvalId when both present', () => {
  const rows = buildActionsForNotification({
    planProposalId: 'plan-p1',
    approvalId: 'appr-a1',
  });
  const ids = customIds(rows);
  // Plan buttons should win; SDK approve/reject should not appear.
  assert.ok(ids.some((id) => id.includes('plan-approve:plan-p1')));
  assert.ok(!ids.some((id) => /\bclementine:approve:appr-a1\b/.test(id)));
});

test('buildActionsForNotification: ignores non-string ids', () => {
  assert.equal(buildActionsForNotification({ planProposalId: 42 as unknown as string }), undefined);
  assert.equal(buildActionsForNotification({ approvalId: null as unknown as string }), undefined);
});

test('Discord slash commands include live approvals pull surface', () => {
  assert.ok(discordSlashCommandNamesForTest().includes('approvals'));
});
