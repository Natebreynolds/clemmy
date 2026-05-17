/**
 * Run: npx tsx --test src/tools/execution-tools.test.ts
 *
 * Focuses on the pure `pickFocusTarget` matcher — the part of
 * execution_focus that decides which execution the user means when
 * they say `/focus social media` or `/focus 4a2b...`. The matcher is
 * the place where a subtle bug (matching too eagerly, picking the
 * wrong record on a substring collision) would silently pause the
 * wrong work.
 *
 * The pause/resume/clear-focus logic itself is a straight wrapper
 * over ExecutionStore.update, covered indirectly by the runtime
 * e2e and the existing store tests. The matcher gets dedicated
 * coverage here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickFocusTarget } from './execution-tools.js';
import type { ExecutionRecord } from '../types.js';

function baseExec(overrides: Partial<ExecutionRecord>): ExecutionRecord {
  const iso = new Date().toISOString();
  return {
    id: `exec-${Math.random().toString(36).slice(2, 10)}`,
    sessionId: 'sess-test',
    title: 'untitled',
    objective: 'do a thing',
    reason: 'because',
    status: 'active',
    createdAt: iso,
    updatedAt: iso,
    lastActivityAt: iso,
    startedFromMessage: 'go',
    confidence: 0.5,
    reasons: [],
    ...overrides,
  } as ExecutionRecord;
}

test('pickFocusTarget: exact id match wins even if a substring would also match', () => {
  const target = baseExec({ id: 'exec-the-id', title: 'something else' });
  const other = baseExec({ id: 'exec-other', title: 'mentions exec-the-id in title' });
  const result = pickFocusTarget('exec-the-id', [target, other]);
  assert.equal(result.kind, 'match');
  if (result.kind === 'match') {
    assert.equal(result.target.id, 'exec-the-id');
  }
});

test('pickFocusTarget: substring match against title (case-insensitive)', () => {
  const records = [
    baseExec({ id: 'e1', title: 'LegalLady social media post' }),
    baseExec({ id: 'e2', title: 'morning briefing cron' }),
    baseExec({ id: 'e3', title: 'end-of-day cron' }),
  ];
  const result = pickFocusTarget('social media', records);
  assert.equal(result.kind, 'match');
  if (result.kind === 'match') assert.equal(result.target.id, 'e1');
});

test('pickFocusTarget: substring match against objective when title misses', () => {
  const records = [
    baseExec({ id: 'a', title: 'unrelated', objective: 'write a Twitter post about LegalLady' }),
    baseExec({ id: 'b', title: 'unrelated 2', objective: 'morning briefing' }),
  ];
  const result = pickFocusTarget('twitter', records);
  assert.equal(result.kind, 'match');
  if (result.kind === 'match') assert.equal(result.target.id, 'a');
});

test('pickFocusTarget: empty list → none', () => {
  const result = pickFocusTarget('anything', []);
  assert.equal(result.kind, 'none');
});

test('pickFocusTarget: nothing matches → none', () => {
  const records = [
    baseExec({ id: 'a', title: 'morning briefing', objective: 'summarize inbox' }),
  ];
  const result = pickFocusTarget('rocket science', records);
  assert.equal(result.kind, 'none');
});

test('pickFocusTarget: multiple matches → ambiguous with all candidates returned', () => {
  const records = [
    baseExec({ id: 'a', title: 'social media post for LegalLady' }),
    baseExec({ id: 'b', title: 'social media plan for the next quarter' }),
    baseExec({ id: 'c', title: 'unrelated cron job' }),
  ];
  const result = pickFocusTarget('social', records);
  assert.equal(result.kind, 'ambiguous');
  if (result.kind === 'ambiguous') {
    assert.equal(result.matches.length, 2);
    const ids = result.matches.map((e) => e.id).sort();
    assert.deepEqual(ids, ['a', 'b']);
  }
});

test('pickFocusTarget: matcher is case-insensitive for query vs title', () => {
  const records = [baseExec({ id: 'x', title: 'LegalLady Marketing' })];
  for (const q of ['legalLADY', 'LEGALLADY', 'LegalLady', 'legallady']) {
    const r = pickFocusTarget(q, records);
    assert.equal(r.kind, 'match', `query "${q}" should match`);
  }
});

test('pickFocusTarget: records with undefined title/objective are skipped, not crashed on', () => {
  const records = [
    baseExec({ id: 'good', title: 'find social media drafts' }),
    // Force a malformed record through the type system — should not throw.
    { ...baseExec({ id: 'bad' }), title: undefined as unknown as string, objective: undefined as unknown as string },
  ];
  const result = pickFocusTarget('social', records);
  assert.equal(result.kind, 'match');
  if (result.kind === 'match') assert.equal(result.target.id, 'good');
});
