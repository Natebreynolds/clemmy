import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  STOP_CONTINUITY_REASONING_GUIDANCE,
  STOP_CONTINUITY_RUBRIC_GUIDANCE,
  STOP_CONTINUITY_ACTION_RUBRIC_GUIDANCE,
} from './stop-continuity-reasoning.js';
import {
  CLAUDE_BRAIN_RUBRIC,
  ORCHESTRATOR_BEHAVIOR_NATIVE,
  ORCHESTRATOR_INSTRUCTIONS,
  ORCHESTRATOR_INSTRUCTIONS_LEAN,
  ORCHESTRATOR_ACTION_INSTRUCTIONS_LEAN,
} from '../../agents/clem-rubric.js';

test('logical effects, not physical attempts, govern settled reuse and repeated Continue', () => {
  assert.match(STOP_CONTINUITY_REASONING_GUIDANCE, /both when executing and when explaining scenarios/);
  assert.match(STOP_CONTINUITY_REASONING_GUIDANCE, /Logical effect identity survives attempts and successors/);
  assert.match(STOP_CONTINUITY_REASONING_GUIDANCE, /never repeat them merely because a new source, attempt or run exists/);
  assert.match(STOP_CONTINUITY_REASONING_GUIDANCE, /durable parent-to-successor selector/);
  assert.match(STOP_CONTINUITY_REASONING_GUIDANCE, /repeated Continue rejoins the already admitted successor and its result/);
});

test('past-outcome settlement and permission for a covered retry remain distinct evidence classes', () => {
  assert.match(STOP_CONTINUITY_REASONING_GUIDANCE, /Only positive outcome evidence for that exact prior operation settles its past outcome/);
  assert.match(STOP_CONTINUITY_REASONING_GUIDANCE, /recorded provider idempotency guarantee covering the same operation, key, account and target/);
  assert.match(STOP_CONTINUITY_REASONING_GUIDANCE, /may permit only the repetition that guarantee covers, with current accepted-source authority and normal gates/);
  assert.match(STOP_CONTINUITY_REASONING_GUIDANCE, /earlier outcome remains unknown until exact-operation outcome evidence arrives/);
  assert.match(STOP_CONTINUITY_REASONING_GUIDANCE, /recorded key alone is not that guarantee/);
  assert.match(STOP_CONTINUITY_REASONING_GUIDANCE, /fresh read of target state, including an empty or absent target, is not exact-operation settlement or no-dispatch proof/);
  assert.match(STOP_CONTINUITY_REASONING_GUIDANCE, /missing rows or receipts are not no-dispatch proof/);
  assert.match(STOP_CONTINUITY_REASONING_GUIDANCE, /If no settled outcome supports a safe disposition and no valid covered retry is established, hold without repeating/);
});

test('shared brain and action cues retain unknown past outcome even when a covered retry is permitted', () => {
  for (const cue of [STOP_CONTINUITY_RUBRIC_GUIDANCE, STOP_CONTINUITY_ACTION_RUBRIC_GUIDANCE]) {
    assert.match(cue, /Exact prior-operation outcome evidence settles uncertainty/);
    assert.match(cue, /recorded provider same-operation\/key\/account\/target idempotency guarantee may allow covered retry/);
    assert.match(cue, /current authority\/gates; prior outcome stays unknown/);
    assert.match(cue, /State is not settlement; a key is no guarantee/);
    assert.match(cue, /missing rows or empty targets prove neither non-dispatch nor safety/);
    assert.match(cue, /Reuse settled success; never replay it/);
  }
});

test('exact no-dispatch, stale Stop ownership and retained reads remain separate from current permission', () => {
  assert.match(STOP_CONTINUITY_REASONING_GUIDANCE, /positive exact no-dispatch evidence, not inference from an absent record/);
  assert.match(STOP_CONTINUITY_REASONING_GUIDANCE, /proves no prior effect, not new permission/);
  assert.match(STOP_CONTINUITY_REASONING_GUIDANCE, /exact session, accepted source, attempt and run ownership, not recency/);
  assert.match(STOP_CONTINUITY_REASONING_GUIDANCE, /stale Stop must not stop a different active attempt/);
  assert.match(STOP_CONTINUITY_REASONING_GUIDANCE, /exact source\/result digest bindings and same-principal current read authority/);
  assert.match(STOP_CONTINUITY_REASONING_GUIDANCE, /unknown completeness stays unknown/);
  assert.match(STOP_CONTINUITY_REASONING_GUIDANCE, /whole effective objective, standing instructions and contrary evidence/);
  assert.match(STOP_CONTINUITY_REASONING_GUIDANCE, /settled effect alone does not prove whole-task completion/);
});

test('conversation rubric has one compact Stop cue; exact-context guide remains fuller and source bound', () => {
  for (const rubric of [ORCHESTRATOR_INSTRUCTIONS, ORCHESTRATOR_BEHAVIOR_NATIVE,
    ORCHESTRATOR_INSTRUCTIONS_LEAN, ORCHESTRATOR_ACTION_INSTRUCTIONS_LEAN, CLAUDE_BRAIN_RUBRIC]) {
    assert.equal(rubric.split(STOP_CONTINUITY_RUBRIC_GUIDANCE).length - 1, 1);
    assert.equal(rubric.includes(STOP_CONTINUITY_REASONING_GUIDANCE), false);
  }
  assert.match(STOP_CONTINUITY_RUBRIC_GUIDANCE, /logical effects across attempts/);
  assert.match(STOP_CONTINUITY_RUBRIC_GUIDANCE, /recorded provider same-operation\/key\/account\/target idempotency guarantee/);
  assert.match(STOP_CONTINUITY_RUBRIC_GUIDANCE, /Stop targets exact session\/source\/attempt\/run, never recency/);
});

test('only the fresh action rubric supplements the cue with exact positive proof and current read ownership', () => {
  assert.equal(ORCHESTRATOR_ACTION_INSTRUCTIONS_LEAN.split(STOP_CONTINUITY_ACTION_RUBRIC_GUIDANCE).length - 1, 1);
  for (const rubric of [ORCHESTRATOR_INSTRUCTIONS, ORCHESTRATOR_BEHAVIOR_NATIVE,
    ORCHESTRATOR_INSTRUCTIONS_LEAN, CLAUDE_BRAIN_RUBRIC]) {
    assert.equal(rubric.includes(STOP_CONTINUITY_ACTION_RUBRIC_GUIDANCE), false);
  }
  assert.match(STOP_CONTINUITY_ACTION_RUBRIC_GUIDANCE, /positive exact no-dispatch evidence/);
  assert.match(STOP_CONTINUITY_ACTION_RUBRIC_GUIDANCE, /an absent call, result or receipt is not that proof/);
  assert.match(STOP_CONTINUITY_ACTION_RUBRIC_GUIDANCE, /not current permission/);
  assert.match(STOP_CONTINUITY_ACTION_RUBRIC_GUIDANCE, /current accepted source and normal gates/);
  assert.match(STOP_CONTINUITY_ACTION_RUBRIC_GUIDANCE, /durable parent-to-unique-admitted-successor binding/);
  assert.match(STOP_CONTINUITY_ACTION_RUBRIC_GUIDANCE, /same-principal current read authority and the requested scope/);
  assert.match(STOP_CONTINUITY_ACTION_RUBRIC_GUIDANCE, /Unknown coverage remains unknown/);
});
