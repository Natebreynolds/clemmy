import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLAUDE_BRAIN_RUBRIC,
  MEMORY_STATUS_RUBRIC,
  ORCHESTRATOR_ACTION_INSTRUCTIONS_LEAN,
  ORCHESTRATOR_BEHAVIOR_NATIVE,
  ORCHESTRATOR_INSTRUCTIONS,
  ORCHESTRATOR_INSTRUCTIONS_LEAN,
  renderClemRubric,
} from './clem-rubric.js';

// These are the actual assembled main-model instructions, including the fresh
// action specialization that previously lost the automatic-capture guidance.
const MAIN_INSTRUCTIONS = [
  ['action lean', ORCHESTRATOR_ACTION_INSTRUCTIONS_LEAN],
  ['normal lean', ORCHESTRATOR_INSTRUCTIONS_LEAN],
  ['Claude chat', CLAUDE_BRAIN_RUBRIC],
  ['legacy', ORCHESTRATOR_INSTRUCTIONS],
  ['native', ORCHESTRATOR_BEHAVIOR_NATIVE],
] as const;

test('fresh action and normal main instructions carry exactly one shared memory-status contract', () => {
  for (const [lane, instructions] of MAIN_INSTRUCTIONS) {
    assert.equal(instructions.split(MEMORY_STATUS_RUBRIC).length - 1, 1, lane);
    assert.equal(instructions.match(/MEMORY STATUS/g)?.length, 1, lane);
  }
  for (const lane of ['codex', 'native', 'claude_brain'] as const) {
    assert.ok(renderClemRubric(lane).includes(MEMORY_STATUS_RUBRIC), lane);
  }
});

test('a zero-tool acknowledgment cannot infer no retention from pending or unknown automatic capture', () => {
  for (const [lane, instructions] of MAIN_INSTRUCTIONS) {
    assert.match(instructions, /background capture may await review/i, lane);
    assert.match(instructions, /queued is not saved proof/i, lane);
    assert.match(instructions, /No foreground save does not imply no retention/i, lane);
    assert.match(instructions, /Claim saved state, no retention or future availability only from current source-linked evidence/i, lane);
    assert.match(instructions, /otherwise acknowledge without storage promises or explain pending\/unknown status when asked/i, lane);
  }
});

test('current verified automatic storage evidence can support reporting without a duplicate foreground save', () => {
  for (const [lane, instructions] of MAIN_INSTRUCTIONS) {
    assert.match(instructions, /current source-linked evidence \(tool or verified automatic receipt\)/i, lane);
    assert.match(instructions, /without duplicate writes or waiting for capture review/i, lane);
  }
});

test('claim-scoped privacy remains explicit without treating an acknowledgment scope as a standing-memory decision', () => {
  for (const [lane, instructions] of MAIN_INSTRUCTIONS) {
    assert.match(instructions, /Honor no-retention for the claims it covers/i, lane);
    assert.match(instructions, /distinguish standing preferences from one-off acknowledgment scope/i, lane);
  }
  // The rule describes a reusable distinction, not a lexical gate for the live
  // marker or a manufactured storage decision for a particular user request.
  assert.doesNotMatch(MEMORY_STATUS_RUBRIC, /ClemLearn|Saffron|427816|4561/);
  assert.doesNotMatch(MEMORY_STATUS_RUBRIC, /always save|always retain|ignore.*no-retention/i);
});

test('normal instruction variants retain useful learning initiative while describing capture as review', () => {
  for (const [lane, instructions] of MAIN_INSTRUCTIONS.filter(([name]) => name !== 'action lean')) {
    assert.match(instructions, /crash-safely auto-captured for review/i, lane);
    assert.match(instructions, /memory_remember.*(?:SAME|same) turn.*subtler|SUBTLER.*memory_remember.*SAME turn/i, lane);
    assert.match(instructions, /kind \+ content/i, lane);
    assert.doesNotMatch(instructions, /The next conversation sees the fact in Persistent Facts automatically/i, lane);
  }
  assert.match(ORCHESTRATOR_ACTION_INSTRUCTIONS_LEAN, /Preserve useful learning/i);
});

test('memory status is bounded guidance rather than a new call, wait or completion-review requirement', () => {
  assert.ok(Buffer.byteLength(MEMORY_STATUS_RUBRIC, 'utf8') <= 560);
  assert.doesNotMatch(MEMORY_STATUS_RUBRIC, /call `|call memory_|must wait|completion judge|completion review|mandatory/i);
  for (const [lane, instructions] of MAIN_INSTRUCTIONS) {
    assert.match(instructions, /Honor.*(?:explicit constraints|explicit preferences|no-retention)/is, lane);
  }
  assert.match(ORCHESTRATOR_ACTION_INSTRUCTIONS_LEAN, /run_worker/);
  assert.match(ORCHESTRATOR_ACTION_INSTRUCTIONS_LEAN, /ACCEPTED WORK AUTHORITY/);
  assert.match(ORCHESTRATOR_ACTION_INSTRUCTIONS_LEAN, /AUTO CONSENT/);
});
