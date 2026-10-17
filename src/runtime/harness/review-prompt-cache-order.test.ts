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

test('skill references lead the live review, so later turns that read the same skill share them too', () => {
  const skill = { name: 'workspace-builder', body: 'SKILL-BODY', bodyDigest: 'd'.repeat(64), evidenceStatus: 'verified' as const,
    origins: [{ readEventSeq: 7, sourceUserSeq: 5, scope: 'current_source' as const, authority: 'exact' as const }] };
  const one = buildObjectiveJudgePrompt('Build the Space.', 'Reply.', { skills: [skill], fullSourceEvidence: true, toolCallSummary: EVIDENCE } as never);
  const reread = buildObjectiveJudgePrompt('Build another Space.', 'Other reply.', { skills: [{ ...skill,
    origins: [...skill.origins, { readEventSeq: 90, sourceUserSeq: 88, scope: 'current_source' as const, authority: 'exact' as const }] }],
  fullSourceEvidence: true, toolCallSummary: EVIDENCE } as never);
  assert.ok(one.indexOf('SKILL-BODY') < one.indexOf('Objective: Build the Space.'), 'the skill leads the objective');
  const shared = one.slice(0, one.indexOf('SKILL-BODY') + 'SKILL-BODY'.length);
  assert.ok(reread.startsWith(shared), 'a new read of the same skill leaves its body in the shared prefix');
});

test('the legacy review keeps its order: the reply comes before the evidence', () => {
  const prompt = buildObjectiveJudgePrompt('Build the Space.', 'First reply.', { skills: [], toolCallSummary: EVIDENCE } as never);
  assert.ok(prompt.indexOf('First reply.') < prompt.indexOf('EVIDENCE-BODY'));
});
