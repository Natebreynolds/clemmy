import assert from 'node:assert/strict';
import { test } from 'node:test';
import { judgeVerdictRepairInstructions, judgeVerdictRepairPrompt } from './judge-verdict-repair-contract.js';

test('generic repair keeps its exact one-line grammar even when review text names completion contracts', () => {
  const review = 'Progress is stalled. Retained text mentions NEEDS ALL OF and MEMORY_REQUIREMENT.';
  const expected = [
    'You already reviewed a response and wrote the review below, but it did not contain the required verdict line.',
    'Do not review again. From your own review, state the verdict now.',
    '', '[YOUR REVIEW]', review, '[/YOUR REVIEW]', '',
    'Reply with EXACTLY ONE LINE and nothing else, in the verdict format your instructions require.',
  ].join('\n');
  assert.equal(judgeVerdictRepairPrompt(review), expected);
  assert.equal(judgeVerdictRepairPrompt(review, { evidenceCoverage: false, memoryRequirement: false }), expected);
  assert.equal(judgeVerdictRepairInstructions('Generic checklist system.'), 'Generic checklist system.');
});

test('completion requests only the caller-required packet lines and resolves the system one-line conflict', () => {
  const review = 'The one inspected record supports its selected value.';
  const coverage = { evidenceCoverage: true, memoryRequirement: false };
  const memory = { evidenceCoverage: false, memoryRequirement: true };
  assert.match(judgeVerdictRepairPrompt(review, coverage), /After a DONE verdict, add exactly one line: NEEDS ALL OF:/);
  assert.doesNotMatch(judgeVerdictRepairPrompt(review, coverage), /Add exactly one separate MEMORY_REQUIREMENT:/);
  assert.match(judgeVerdictRepairPrompt(review, memory), /Add exactly one separate MEMORY_REQUIREMENT:/);
  assert.doesNotMatch(judgeVerdictRepairPrompt(review, memory), /After a DONE verdict/);
  const instructions = judgeVerdictRepairInstructions('Reply with EXACTLY ONE LINE.', {
    evidenceCoverage: true, memoryRequirement: true,
  });
  assert.match(instructions, /The earlier one-line rule applies to the verdict line/);
  assert.match(instructions, /NEEDS ALL OF.*MEMORY_REQUIREMENT.*same answer/);
});

test('repair retains the complete late finding and cannot turn missing scope or memory bindings into proof', () => {
  const lateFinding = 'Final finding: only one page was inspected; the required correction digest was unavailable.';
  const review = 'Earlier detailed review. '.repeat(400) + lateFinding;
  const prompt = judgeVerdictRepairPrompt(review, { evidenceCoverage: true, memoryRequirement: true });
  assert.ok(prompt.includes(`[YOUR REVIEW]\n${review}\n[/YOUR REVIEW]`));
  assert.match(prompt, /If the required scope cannot be recovered.*report that evidence gap/);
  assert.match(prompt, /use unresolved with an empty corrections array, never invent a binding/);
  assert.match(prompt, /INCOMPLETE with the missing evidence instead of DONE/);
});
