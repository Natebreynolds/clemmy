/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/review-prompt-cache-order.test.ts
 *
 * The live completion review puts the reply after everything a re-review of
 * the same turn shares, so a provider's prefix cache reuses it. Live
 * 2026-10-17: with the reply second, ~180 KB of each re-review followed text
 * that had changed and the reviewer ran at ~1% cached.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-review-order-'));
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';

const { buildObjectiveJudgePrompt } = await import('./objective-judge.js');

const EVIDENCE = 'space_save -> space_save [outcome=succeeded] EVIDENCE-BODY';

test('in the live review the reply comes after the evidence, so re-reviews share the prefix', () => {
  const context = { skills: [], fullSourceEvidence: true, toolCallSummary: EVIDENCE } as never;
  const first = buildObjectiveJudgePrompt('Build the Space.', 'First reply.', context);
  const second = buildObjectiveJudgePrompt('Build the Space.', 'A revised reply after repair.', context);
  assert.ok(first.indexOf('EVIDENCE-BODY') < first.indexOf('First reply.'), 'evidence precedes the reply');
  const shared = first.slice(0, first.indexOf("Assistant's most recent response"));
  assert.ok(shared.includes('EVIDENCE-BODY'));
  assert.ok(second.startsWith(shared), 'a changed reply leaves everything before it identical');
});

test('the legacy review keeps its order: the reply comes before the evidence', () => {
  const prompt = buildObjectiveJudgePrompt('Build the Space.', 'First reply.', { skills: [], toolCallSummary: EVIDENCE } as never);
  assert.ok(prompt.indexOf('First reply.') < prompt.indexOf('EVIDENCE-BODY'));
});
