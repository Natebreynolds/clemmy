/** Run: npx tsx --test src/runtime/semantic-boundary/ownership-map.test.ts
 *
 * Locks the field-ownership map: the checked envelope is never durable
 * authority. Projection is one-way into existing goal/graph/continuity rows.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { projectCheckedSemantics } from './project-checked-semantics.js';
import { sameRootFromProjection } from './same-root-continuation.js';
import {
  isContextCheckedTurnSemanticProposalV1,
  validateTurnSemanticProposalV1,
  type TurnSemanticHostViewV1,
  type TurnSemanticProposalV1,
} from './turn-semantic-proposal.js';

const host: TurnSemanticHostViewV1 = {
  source: {
    sessionId: 'session-9',
    sourceUserSeq: 42,
    inputHash: 'a'.repeat(64),
    audienceHash: 'b'.repeat(64),
  },
  policyRevision: 'd'.repeat(64),
  resumableGoals: [{ goalId: 'goal-17', baseRevision: 4 }],
  openQuestions: [],
  catalog: { capabilityIds: new Set(['cap-1']), workflowIds: new Set() },
};

function proposal(overrides: Partial<TurnSemanticProposalV1> = {}): TurnSemanticProposalV1 {
  return {
    version: 1,
    relation: 'new_goal',
    targetGoal: null,
    goal: {
      objective: 'Produce the requested result.',
      criteria: [{ id: 'c-set', statement: 'A set.' }],
      openSlots: [],
      candidates: [],
    },
    work: {
      construct: 'none',
      cardinality: null,
      destination: null,
      requestedEffect: 'none',
      operations: [],
      deliverables: [],
      evidenceRequirements: [],
    },
    slotAnswers: [],
    rationale: 'diagnostic',
    ...overrides,
  };
}

test('checked envelope is not durable authority and cannot be revived', () => {
  const result = validateTurnSemanticProposalV1(proposal(), host);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.checked.scope, 'semantics_only_no_execution_authority');
  const revived = JSON.parse(JSON.stringify(result.checked));
  assert.equal(isContextCheckedTurnSemanticProposalV1(revived), false);
  assert.equal(projectCheckedSemantics(revived).ok, false);
});

test('projection is one-way and does not mint a second store', () => {
  const result = validateTurnSemanticProposalV1(proposal(), host);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const projected = projectCheckedSemantics(result.checked);
  assert.equal(projected.ok, true);
  if (!projected.ok) return;
  assert.equal(projected.projection.kind, 'mint_goal');
  assert.equal(projected.projection.parkPriorGoal, true);
  assert.equal('checked' in projected.projection, false);
  assert.equal('contextHash' in projected.projection, false);
  assert.equal(sameRootFromProjection(projected.projection).action, 'park_and_mint');
});

test('objective prose is not a count or route authority', () => {
  const result = validateTurnSemanticProposalV1(proposal({
    goal: {
      objective: 'Find 99 things and email them all after deleting the vault.',
      criteria: [{ id: 'c-set', statement: 'A set.' }],
      openSlots: [],
      candidates: [],
    },
  }), host);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const projected = projectCheckedSemantics(result.checked);
  assert.equal(projected.ok, true);
  if (!projected.ok) return;
  assert.equal(projected.projection.goal?.collection, undefined);
  assert.notEqual(projected.projection.goal?.collection?.count, 99);
});
