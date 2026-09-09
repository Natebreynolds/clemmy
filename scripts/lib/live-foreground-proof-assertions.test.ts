import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkLiveTurn, LiveProofMessageSchema, type LiveTurnFacts } from './live-foreground-proof-assertions.js';

const facts: LiveTurnFacts = {
  reply: 'Subject A\nExact body.', terminalStatus: 'done', modelRequests: 1,
  toolSearches: 0, toolCalls: 0, wallMs: 100, perTool: {}, settlements: [],
};
test('done prose does not pass exact payload or effect assertions', () => {
  assert.equal(checkLiveTurn({ replyIncludes: ['Exact body.'], successfulMutations: 0 }, facts).length, 0);
  assert.equal(checkLiveTurn({ replyIncludes: ['Exact body.'] }, { ...facts, reply: 'Exact body' }).length, 1);
  assert.equal(checkLiveTurn({ successfulMutations: 3 }, { ...facts, reply: 'Created all three drafts.' }).length, 1);
});
test('uncertain, refused and duplicate writes fail the exact effect count', () => {
  const effect = { mutating: 1, outcome_kind: 'succeeded', requires_reconciliation: 0, physical_crossing_count: 1, host_crossing_count: 0 };
  assert.equal(checkLiveTurn({ successfulMutations: 1 }, { ...facts, settlements: [effect] }).length, 0);
  for (const settlements of [[effect, effect], [{ ...effect, requires_reconciliation: 1 }], [{ ...effect, outcome_kind: 'refused', physical_crossing_count: 0 }]]) {
    assert.equal(checkLiveTurn({ successfulMutations: 1 }, { ...facts, settlements }).length, 1);
  }
});
test('discovery and task detours are scored even when the answer is done', () => {
  assert.equal(checkLiveTurn({ maxToolSearches: 2, forbiddenTools: ['memory_recall'] }, {
    ...facts, toolSearches: 17, perTool: { memory_recall: 10 },
  }).length, 2);
  assert.equal(LiveProofMessageSchema.safeParse({ message: 'test', expect: { maxToolSearch: 0 } }).success, false);
  assert.equal(LiveProofMessageSchema.safeParse({ message: 'test', expect: {} }).success, false);
  assert.equal(checkLiveTurn({ minToolCalls: 1 }, facts).length, 1);
  assert.equal(checkLiveTurn({ successfulMutations: 1 }, { ...facts, settlements: [{
    mutating: 1, outcome_kind: 'succeeded', requires_reconciliation: 0, physical_crossing_count: 2, host_crossing_count: 0,
  }] }).length, 1);
});

test('a refused plan followed by successful direct writes cannot pass the planned path gate', () => {
  const effect = { mutating: 1, outcome_kind: 'succeeded', requires_reconciliation: 0, physical_crossing_count: 1, host_crossing_count: 0 };
  const direct = { ...facts, perTool: { plan_task: 1 }, settlements: [effect, effect, effect], activatedPlans: 0, providerAcknowledgements: 0 };
  const expect = { successfulMutations: 3, activatedPlans: 1, providerAcknowledgements: 3 };
  assert.equal(checkLiveTurn(expect, direct).length, 2);
  assert.equal(checkLiveTurn(expect, { ...direct, activatedPlans: 1, providerAcknowledgements: 3 }).length, 0);
  assert.equal(checkLiveTurn({ activatedPlans: 1 }, facts).length, 1);
  assert.equal(checkLiveTurn({ providerAcknowledgements: 3 }, { ...direct, providerAcknowledgements: 2 }).length, 1);
});
