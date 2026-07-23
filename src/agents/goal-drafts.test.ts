/**
 * Run: npx tsx --test src/agents/goal-drafts.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-goal-drafts-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const {
  createGoalFromDraft,
  dismissGoalDraft,
  getGoalDraft,
  listGoalDrafts,
  surfaceGoalDraftFromNotes,
} = await import('./goal-drafts.js');
const { listNotifications } = await import('../runtime/notifications.js');

test.after(() => { try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ } });

test('surfaceGoalDraftFromNotes persists a reviewable draft and notification', () => {
  const record = surfaceGoalDraftFromNotes({
    notes: [
      'Goal: improve onboarding completion by 20% over the next 4 weeks.',
      'Success: baseline is captured and weekly completion rate is measured.',
      'Next action: pull the current funnel report.',
      'Risk: analytics access needs approval.',
    ].join('\n'),
    sessionId: 'sess-draft',
    channel: 'discord:chan',
  });

  assert.match(record.id, /^gd-/);
  assert.equal(record.status, 'pending');
  assert.match(record.draft.objective, /onboarding completion/i);
  assert.equal(getGoalDraft(record.id)?.id, record.id);
  assert.equal(listGoalDrafts({ status: 'pending' }).length, 1);

  const note = listNotifications(10).find((item) => item.metadata?.goalDraftId === record.id);
  assert.ok(note, 'goal draft notification exists');
  assert.equal(note?.kind, 'system');
  assert.equal(note?.metadata?.needsAttention, true);
});

test('createGoalFromDraft creates a durable goal and resolves the draft', () => {
  const record = surfaceGoalDraftFromNotes({
    notes: 'Goal: reduce support first response time by 10% within 2 weeks. Success: baseline is measured. Risk: inbox access needs approval.',
    notify: false,
  });

  const result = createGoalFromDraft(record.id, { selfDriving: true, resumeEveryMs: 900000, maxResumes: 4 });
  assert.ok(result);
  assert.equal(result?.draft.status, 'created');
  assert.equal(result?.draft.goalId, result?.goal.id);
  assert.equal(result?.goal.status, 'active');
  assert.equal(result?.goal.selfDriving, true);
});

test('dismissGoalDraft resolves a pending draft without creating a goal', () => {
  const record = surfaceGoalDraftFromNotes({ notes: 'Goal: improve weekly reporting quality. Success: owner signs off monthly.' });
  const dismissed = dismissGoalDraft(record.id, 'not needed');
  assert.equal(dismissed?.status, 'dismissed');
  assert.equal(dismissed?.resolvedReason, 'not needed');
  assert.equal(dismissGoalDraft(record.id), null);
});

test('a pending draft untouched for 7+ days auto-dismisses on listing', async () => {
  const { readFileSync, writeFileSync } = await import('node:fs');
  const record = surfaceGoalDraftFromNotes({ notes: 'Goal: something stale nobody reviewed for weeks.', notify: false });

  // Backdate the stored record past the 7-day pending TTL.
  const file = path.join(TMP_HOME, 'state', 'goal-drafts', `${record.id}.json`);
  const stored = JSON.parse(readFileSync(file, 'utf-8'));
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  stored.createdAt = old;
  stored.updatedAt = old;
  writeFileSync(file, JSON.stringify(stored));

  const pending = listGoalDrafts({ status: 'pending' });
  assert.equal(pending.find((d) => d.id === record.id), undefined, 'stale draft no longer pending');
  assert.equal(getGoalDraft(record.id)?.status, 'dismissed', 'auto-dismissed, not deleted');
  assert.match(getGoalDraft(record.id)?.resolvedReason ?? '', /expired/);
});
