/** Run: npx tsx --test src/runtime/semantic-boundary/project-checked-semantics.test.ts */
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTurnSemanticHostViewV1 } from './build-semantic-host-view.js';
import { fakeSemanticProposal, SEMANTIC_EVAL_FIXTURES } from './fake-semantic-model.js';
import {
  projectCheckedSemantics,
  proposedGraphFromProjection,
} from './project-checked-semantics.js';
import {
  isContextCheckedTurnSemanticProposalV1,
  validateTurnSemanticProposalV1,
} from './turn-semantic-proposal.js';

const activeGoal = { goalId: 'goal-17', baseRevision: 4 } as const;

function hostView() {
  return buildTurnSemanticHostViewV1({
    sessionId: 'session-9',
    sourceUserSeq: 42,
    acceptedText: SEMANTIC_EVAL_FIXTURES.affirmDidYouMean,
    audienceKey: 'aud-1',
    userId: 'user-1',
    conversationKey: 'conv-1',
    policyRevision: 'd'.repeat(64),
    resumableGoals: [activeGoal],
    openQuestions: [{
      questionId: 'question-3',
      goalId: activeGoal.goalId,
      goalRevision: activeGoal.baseRevision,
      slotKey: 'resource-choice',
      question: 'Which resource should I use?',
      options: [
        { optionId: 'choice-a', label: 'First' },
        { optionId: 'choice-b', label: 'Second' },
      ],
      allowFreeText: false,
    }],
    workflowIds: ['workflow-1'],
  });
}

test('eval fixtures project to answer_open_slot on the exact visible option', () => {
  const host = hostView();
  for (const fixture of ['affirmDidYouMean', 'affirmNamedHost'] as const) {
    const raw = fakeSemanticProposal(fixture, host);
    const checked = validateTurnSemanticProposalV1(raw, host);
    assert.equal(checked.ok, true, fixture);
    if (!checked.ok) continue;
    const projected = projectCheckedSemantics(checked.checked);
    assert.equal(projected.ok, true);
    if (!projected.ok) continue;
    assert.equal(projected.projection.kind, 'settle_slot');
    assert.deepEqual(projected.projection.targetGoal, activeGoal);
    assert.equal(projected.projection.slotAnswer?.kind, 'option');
    if (projected.projection.slotAnswer?.kind === 'option') {
      assert.equal(projected.projection.slotAnswer.optionId, 'choice-a');
    }
  }
});

test('a forged lookalike envelope cannot project', () => {
  const host = hostView();
  const checked = validateTurnSemanticProposalV1(fakeSemanticProposal({
    relation: 'new_goal',
    goal: {
      objective: 'Produce the requested result.',
      criteria: [{ id: 'c-set', statement: 'A set.' }, { id: 'c-dest', statement: 'A dest.' }],
      openSlots: [],
      candidates: [],
    },
    work: fakeSemanticProposal('newConstruct', host).work,
  }, host), host);
  assert.equal(checked.ok, true);
  if (!checked.ok) return;
  const lookalike = JSON.parse(JSON.stringify(checked.checked));
  assert.equal(isContextCheckedTurnSemanticProposalV1(lookalike), false);
  const projected = projectCheckedSemantics(lookalike);
  assert.equal(projected.ok, false);
});

test('new_goal with clarifying open-slots and no work projects as conversation', () => {
  const host = buildTurnSemanticHostViewV1({
    sessionId: 'session-clarify',
    sourceUserSeq: 1,
    acceptedText: 'Clean up the Zephyr deal tracker and send the crew an update about it.',
    audienceKey: 'aud-1',
    userId: 'user-1',
    conversationKey: 'conv-1',
    policyRevision: 'd'.repeat(64),
  });
  const checked = validateTurnSemanticProposalV1({
    version: 1,
    relation: 'new_goal',
    targetGoal: null,
    goal: {
      objective: 'Clean up the Zephyr deal tracker and send the crew an update about it.',
      criteria: [
        { id: 'tracker_cleaned', statement: 'The tracker is cleaned.' },
        { id: 'crew_updated', statement: 'The crew is updated.' },
      ],
      openSlots: [
        {
          slotKey: 'crew_definition',
          question: 'Who exactly is the crew that should receive the update?',
          options: [],
          allowFreeText: true,
        },
        {
          slotKey: 'update_channel',
          question: 'How should the update be sent?',
          options: [],
          allowFreeText: true,
        },
      ],
      candidates: [],
    },
    work: null,
    slotAnswers: [],
    rationale: 'Need alignment before any work.',
  }, host);
  assert.equal(checked.ok, true, checked.ok ? '' : checked.issues.map((issue) => issue.code).join(','));
  if (!checked.ok) return;
  const projected = projectCheckedSemantics(checked.checked);
  assert.equal(projected.ok, true);
  if (!projected.ok) return;
  assert.equal(projected.projection.kind, 'conversation');
  assert.equal(projected.projection.goal, undefined);
  assert.deepEqual(proposedGraphFromProjection(projected.projection).nodes, [{ kind: 'compose_reply' }]);
});

test('underspecified named-existing writes stay mint_goal so dispatch can park, not conversation', () => {
  const host = buildTurnSemanticHostViewV1({
    sessionId: 'session-clarify',
    sourceUserSeq: 1,
    acceptedText: 'Clean up the Zephyr deal tracker and send the crew an update about it.',
    audienceKey: 'aud-1',
    userId: 'user-1',
    conversationKey: 'conv-1',
    policyRevision: 'd'.repeat(64),
  });
  const checked = validateTurnSemanticProposalV1({
    version: 1,
    relation: 'new_goal',
    targetGoal: null,
    goal: {
      objective: 'Clean up the Zephyr deal tracker and send the crew an update about it.',
      criteria: [
        { id: 'c1', statement: 'The tracker is cleaned.' },
        { id: 'c2', statement: 'The crew is updated.' },
      ],
      openSlots: [],
      candidates: [],
    },
    work: {
      construct: 'collect_then_construct',
      cardinality: null,
      destinations: [
        { posture: 'named_existing', family: 'deal_tracker', handleRequired: true },
        { posture: 'named_existing', family: 'crew_update_channel', handleRequired: true },
      ],
      destination: null,
      requestedEffect: 'external_write',
      operations: [],
      deliverables: [],
      evidenceRequirements: [],
    },
    slotAnswers: [],
    rationale: 'Named existing destinations with no handles.',
  }, host);
  assert.equal(checked.ok, true, checked.ok ? '' : checked.issues.map((issue) => issue.code).join(','));
  if (!checked.ok) return;
  const projected = projectCheckedSemantics(checked.checked);
  assert.equal(projected.ok, true);
  if (!projected.ok) return;
  assert.equal(projected.projection.kind, 'mint_goal');
  assert.equal(projected.projection.goal?.requestedEffect, 'external_write');
  assert.ok((projected.projection.goal?.destinations?.length ?? 0) > 0);
});

test('new_goal projection takes construct from hash-bound work, not criterion ids', () => {
  const host = buildTurnSemanticHostViewV1({
    sessionId: 'session-9',
    sourceUserSeq: 42,
    acceptedText: SEMANTIC_EVAL_FIXTURES.newConstruct,
    audienceKey: 'aud-1',
    userId: 'user-1',
    conversationKey: 'conv-1',
    policyRevision: 'd'.repeat(64),
  });
  const checked = validateTurnSemanticProposalV1(fakeSemanticProposal('newConstruct', host), host);
  assert.equal(checked.ok, true);
  if (!checked.ok) return;
  const projected = projectCheckedSemantics(checked.checked);
  assert.equal(projected.ok, true);
  if (!projected.ok) return;
  assert.equal(projected.projection.kind, 'mint_goal');
  assert.equal(projected.projection.parkPriorGoal, true);
  assert.equal(projected.projection.goal?.construct, 'collect_then_construct');
  assert.equal(projected.projection.goal?.collection?.count, 5);
  assert.equal(projected.projection.goal?.requestedEffect, 'external_write');
  assert.ok(proposedGraphFromProjection(projected.projection).nodes.some((node) => node.kind === 'retrieve'));
  assert.ok(proposedGraphFromProjection(projected.projection).nodes.some((node) => node.kind === 'execute'));
});

test('criterion ids named collection/destination do not grant construct', () => {
  const host = buildTurnSemanticHostViewV1({
    sessionId: 'session-9',
    sourceUserSeq: 42,
    acceptedText: 'x',
    audienceKey: 'aud-1',
    userId: 'user-1',
    conversationKey: 'conv-1',
    policyRevision: 'd'.repeat(64),
  });
  const checked = validateTurnSemanticProposalV1(fakeSemanticProposal({
    relation: 'new_goal',
    goal: {
      objective: 'Produce the requested result.',
      criteria: [
        { id: 'collection', statement: 'A set.' },
        { id: 'destination', statement: 'A dest.' },
      ],
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
  }, host), host);
  assert.equal(checked.ok, true);
  if (!checked.ok) return;
  const projected = projectCheckedSemantics(checked.checked);
  assert.equal(projected.ok, true);
  if (!projected.ok) return;
  assert.equal(projected.projection.goal?.construct, 'none');
  assert.equal(projected.projection.goal?.collection, undefined);
  assert.equal(projected.projection.goal?.requestedEffect, 'none');
});

test('equivalent typed semantics project identically regardless of rationale wording', () => {
  const host = hostView();
  const first = validateTurnSemanticProposalV1(fakeSemanticProposal('affirmDidYouMean', host), host);
  const second = validateTurnSemanticProposalV1({
    ...fakeSemanticProposal('affirmDidYouMean', host),
    rationale: 'Different diagnostic prose.',
  }, host);
  assert.equal(first.ok && second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.deepEqual(
    projectCheckedSemantics(first.checked),
    projectCheckedSemantics(second.checked),
  );
});
