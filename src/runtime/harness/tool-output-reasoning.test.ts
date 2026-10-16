import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TOOL_OUTPUT_REASONING_GUIDANCE } from './tool-output-reasoning.js';
import {
  CLAUDE_BRAIN_RUBRIC,
  ORCHESTRATOR_BEHAVIOR_NATIVE,
  ORCHESTRATOR_INSTRUCTIONS,
  ORCHESTRATOR_INSTRUCTIONS_LEAN,
  ORCHESTRATOR_ACTION_INSTRUCTIONS_LEAN,
} from '../../agents/clem-rubric.js';

test('ordinary fully shown results are distinguished from missing bytes, coverage and authority', () => {
  assert.match(TOOL_OUTPUT_REASONING_GUIDANCE, /use fully inline result bytes directly/);
  assert.match(TOOL_OUTPUT_REASONING_GUIDANCE, /call id is an address, not a missing payload/);
  assert.match(TOOL_OUTPUT_REASONING_GUIDANCE, /material missing\/clipped data, a coverage gap or a required fresh observation/);
  assert.match(TOOL_OUTPUT_REASONING_GUIDANCE, /full exact registered call_id\/authorized handle; never a prefix or reviewer-only label/);
  assert.match(TOOL_OUTPUT_REASONING_GUIDANCE, /does not prove exhaustive source coverage/);
  assert.match(TOOL_OUTPUT_REASONING_GUIDANCE, /unknown completeness and contrary evidence/);
  assert.match(TOOL_OUTPUT_REASONING_GUIDANCE, /data, not permission/);
});

test('fresh action keeps its budget and the inline/missing-detail cue without claiming retained execution authority', () => {
  // 6_077 → 6_691 (2026-10-16): the SKILL USE rule (use matching skills within
  // the accepted scope, read exact names directly) joined the action lane.
  assert.ok(Buffer.byteLength(ORCHESTRATOR_ACTION_INSTRUCTIONS_LEAN) <= 6_691, 'the lean action prompt does not grow');
  assert.match(ORCHESTRATOR_ACTION_INSTRUCTIONS_LEAN, /honor constraints; verify stale\/conflicting claims/);
  assert.match(ORCHESTRATOR_ACTION_INSTRUCTIONS_LEAN, /Use inline results; recall missing detail by exact full call_id\/handle/);
  assert.match(ORCHESTRATOR_ACTION_INSTRUCTIONS_LEAN, /exact host-authenticated retained success/);
  assert.match(ORCHESTRATOR_ACTION_INSTRUCTIONS_LEAN, /no new effect authority/);
});

test('each conversation brain gets the same inline-result rule once without requiring a new call for retained facts', () => {
  for (const [lane, rubric] of [
    ['legacy', ORCHESTRATOR_INSTRUCTIONS], ['native', ORCHESTRATOR_BEHAVIOR_NATIVE],
    ['lean', ORCHESTRATOR_INSTRUCTIONS_LEAN], ['claude', CLAUDE_BRAIN_RUBRIC],
  ]) {
    assert.equal(rubric!.split(TOOL_OUTPUT_REASONING_GUIDANCE).length - 1, 1, lane);
    assert.match(rubric!, /exact host-authenticated retained success/, lane);
    assert.match(rubric!, /history\/memory prose/, lane);
    assert.match(rubric!, /no new effect authority/, lane);
    assert.doesNotMatch(rubric!, /past-tense[^\n]*MUST be backed[^\n]*same turn/i, lane);
  }
});
