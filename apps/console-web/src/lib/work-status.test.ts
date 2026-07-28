/**
 * Run: npx tsx --test apps/console-web/src/lib/work-status.test.ts
 * State-transition coverage for the shared status vocabulary + evidence fold.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { humanStatusLabel, evidenceSummary, evidenceChips, blockerSummary } from './work-status.js';
import type { TaskOutcomeSnapshot } from './board.js';

test('raw harness statuses never leak verbatim', () => {
  assert.equal(humanStatusLabel('parked'), 'Waiting for your approval');
  assert.equal(humanStatusLabel('awaiting_capability'), 'Waiting for a connection');
  assert.equal(humanStatusLabel('interrupted'), 'Interrupted — resumable');
  assert.equal(humanStatusLabel('step: publish_approved_post'), 'Working');
  // Unknown states are prettified, never underscored.
  assert.equal(humanStatusLabel('some_future_state'), 'Some future state');
  assert.ok(!humanStatusLabel('awaiting_capability').includes('_'));
});

const snapshot: TaskOutcomeSnapshot = {
  version: 1,
  capturedAt: '2026-07-28T00:00:00.000Z',
  evidence: {
    work: [{ label: 'companies', completed: 119, total: 120, evidenceCount: 119 }],
    artifacts: [
      { kind: 'csv', ref: '/tmp/out.csv', verified: true },
      { kind: 'sheet', ref: 'https://sheets.example/1', verified: false },
    ],
    committedExternalActions: 2,
  },
  blocker: 'Railway sign-in is required',
  nextAction: 'Run `railway login`, then reply continue.',
  resumable: true,
};

test('evidence folds to honest chip facts (partial stays partial)', () => {
  const summary = evidenceSummary(snapshot);
  assert.ok(summary);
  assert.equal(summary!.work, '119/120 items');
  assert.equal(summary!.artifactsVerified, 1);
  assert.equal(summary!.artifactsTotal, 2);
  assert.equal(summary!.receipts, 2);
  assert.equal(summary!.complete, false, '119/120 with an unverified artifact must NOT read complete');

  const chips = evidenceChips(snapshot);
  assert.deepEqual(chips, ['119/120 items', '1/2 artifacts verified', '2 send receipts']);
});

test('a complete snapshot reads complete; an empty one renders nothing', () => {
  const done: TaskOutcomeSnapshot = {
    version: 1,
    capturedAt: '2026-07-28T00:00:00.000Z',
    evidence: {
      work: [{ label: 'items', completed: 12, total: 12 }],
      artifacts: [{ kind: 'file', ref: '/tmp/a', verified: true }],
      committedExternalActions: 0,
    },
  };
  assert.equal(evidenceSummary(done)!.complete, true);
  assert.deepEqual(evidenceChips(done), ['12/12 items', '1 artifact ✓']);

  assert.equal(evidenceSummary(undefined), null);
  assert.equal(evidenceSummary({ version: 1, capturedAt: 'x' } as TaskOutcomeSnapshot), null);
  assert.deepEqual(evidenceChips(null), []);
});

test('blocker summary carries the exact next action and resumability', () => {
  const b = blockerSummary(snapshot);
  assert.ok(b);
  assert.equal(b!.blocker, 'Railway sign-in is required');
  assert.match(b!.nextAction!, /railway login/);
  assert.equal(b!.resumable, true);
  assert.equal(blockerSummary({ version: 1, capturedAt: 'x' } as TaskOutcomeSnapshot), null);
});
