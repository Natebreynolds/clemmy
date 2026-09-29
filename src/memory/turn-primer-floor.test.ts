/**
 * Run: node scripts/run-tests-isolated.mjs src/memory/turn-primer-floor.test.ts
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectRankedTailHits } from './turn-primer.js';
import type { UnifiedHit } from './unified-recall.js';

const hit = (type: UnifiedHit['type'], ref: string, score: number): UnifiedHit => ({ type, ref, title: ref, snippet: ref, score });
const refs = (hits: UnifiedHit[]): string[] => hits.map((entry) => `${entry.type}:${entry.ref}`);
const selection = { relativeFloor: 0.5, reservedPolicySlots: 1 };

test('a record of earlier work on the same request does not push what is known about it off the prompt', () => {
  // The episode repeats the request's words, so it outranks everything. The
  // fact is the most relevant thing known about the subject.
  const hits = [hit('episode', 'earlier-run', 10), hit('fact', 'filing-rule', 3), hit('note', 'related-note', 2), hit('fact', 'faint', 0.5)];
  assert.deepEqual(refs(selectRankedTailHits(hits, selection)), ['fact:filing-rule', 'note:related-note', 'episode:earlier-run'],
    'facts are measured against the best fact or note, and take their place in the block before earlier work');
});

test('among what is known the floor still holds, and among episodes it still holds', () => {
  const hits = [hit('fact', 'strong', 8), hit('fact', 'weak', 1), hit('episode', 'close', 9), hit('episode', 'distant', 2)];
  assert.deepEqual(refs(selectRankedTailHits(hits, selection)), ['fact:strong', 'episode:close']);
});

test('with nothing but episodes, and with none at all, selection is what it was', () => {
  assert.deepEqual(refs(selectRankedTailHits([hit('episode', 'a', 4), hit('episode', 'b', 1)], selection)), ['episode:a']);
  assert.deepEqual(refs(selectRankedTailHits([hit('fact', 'a', 4), hit('note', 'b', 2), hit('fact', 'c', 1)], selection)), ['fact:a', 'note:b']);
  assert.deepEqual(selectRankedTailHits([], selection), []);
});

test('a standing policy keeps its reserved place whatever else is recalled', () => {
  const hits = [hit('episode', 'earlier-run', 10), hit('policy', 'standing-rule', 0.2), hit('fact', 'filing-rule', 3)];
  assert.deepEqual(refs(selectRankedTailHits(hits, selection)), ['policy:standing-rule', 'fact:filing-rule', 'episode:earlier-run']);
});

test('what is known is placed before earlier work, each in its ranked order', () => {
  const hits = [hit('episode', 'first-run', 9), hit('fact', 'b', 5), hit('episode', 'second-run', 8), hit('fact', 'a', 6)];
  assert.deepEqual(refs(selectRankedTailHits(hits, selection)), ['fact:b', 'fact:a', 'episode:first-run', 'episode:second-run'],
    'the ranker\'s order is kept within each group');
});
