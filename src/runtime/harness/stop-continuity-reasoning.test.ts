import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  STOP_CONTINUITY_REASONING_GUIDANCE,
  STOP_CONTINUITY_RUBRIC_GUIDANCE,
} from './stop-continuity-reasoning.js';
import {
  CLAUDE_BRAIN_RUBRIC,
  ORCHESTRATOR_BEHAVIOR_NATIVE,
  ORCHESTRATOR_INSTRUCTIONS,
  ORCHESTRATOR_INSTRUCTIONS_LEAN,
} from '../../agents/clem-rubric.js';

test('logical effects, not physical attempts, govern settled reuse and repeated Continue', () => {
  assert.match(STOP_CONTINUITY_REASONING_GUIDANCE, /both when executing and when explaining scenarios/);
  assert.match(STOP_CONTINUITY_REASONING_GUIDANCE, /Logical effect identity survives attempts and successors/);
  assert.match(STOP_CONTINUITY_REASONING_GUIDANCE, /never repeat them merely because a new source, attempt or run exists/);
  assert.match(STOP_CONTINUITY_REASONING_GUIDANCE, /durable parent-to-successor selector/);
  assert.match(STOP_CONTINUITY_REASONING_GUIDANCE, /repeated Continue rejoins the already admitted successor and its result/);
});

test('uncertainty cannot become replay authority from a missing record or a key alone', () => {
  assert.match(STOP_CONTINUITY_REASONING_GUIDANCE, /settlement of that exact prior operation/);
  assert.match(STOP_CONTINUITY_REASONING_GUIDANCE, /recorded provider idempotency contract covering the same operation, key, account and target/);
  assert.match(STOP_CONTINUITY_REASONING_GUIDANCE, /same-key retry also requires current accepted-source authority and normal gates/);
  assert.match(STOP_CONTINUITY_REASONING_GUIDANCE, /recorded key alone is not that contract/);
  assert.match(STOP_CONTINUITY_REASONING_GUIDANCE, /fresh empty read or absent target alone does not prove/);
  assert.match(STOP_CONTINUITY_REASONING_GUIDANCE, /missing rows or receipts are not no-dispatch proof/);
  assert.match(STOP_CONTINUITY_REASONING_GUIDANCE, /If unresolved, pause without repeating/);
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
    ORCHESTRATOR_INSTRUCTIONS_LEAN, CLAUDE_BRAIN_RUBRIC]) {
    assert.equal(rubric.split(STOP_CONTINUITY_RUBRIC_GUIDANCE).length - 1, 1);
    assert.equal(rubric.includes(STOP_CONTINUITY_REASONING_GUIDANCE), false);
  }
  assert.match(STOP_CONTINUITY_RUBRIC_GUIDANCE, /logical effects across attempts/);
  assert.match(STOP_CONTINUITY_RUBRIC_GUIDANCE, /recorded provider same-key\/account\/target idempotency contract plus current authority\/gates/);
  assert.match(STOP_CONTINUITY_RUBRIC_GUIDANCE, /Stop targets exact session\/source\/attempt\/run, never recency/);
});
