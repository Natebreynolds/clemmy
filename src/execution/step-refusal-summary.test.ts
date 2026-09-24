/**
 * Run: npx tsx --test src/execution/step-refusal-summary.test.ts
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summarizePreDispatchRefusals, noEffectStepReason } from './step-refusal-summary.js';

const events = [
  { type: 'guardrail_tripped', data: { kind: 'trajectory_review', sourceUserSeq: 7 } },
  { type: 'guardrail_tripped', data: { kind: 'refused_pre_dispatch', sourceUserSeq: 7, refusalDetail: 'coverage_missing', recoveryToolNames: ['write_file'], calls: [{ name: 'write_file' }, { name: 'write_file' }, { name: 'write_file' }] } },
  { type: 'guardrail_tripped', data: { kind: 'refused_pre_dispatch', sourceUserSeq: 7, refusalDetail: 'coverage_missing', calls: [{ name: 'write_file' }] } },
  { type: 'guardrail_tripped', data: { kind: 'refused_pre_dispatch', sourceUserSeq: 9, refusalDetail: 'other', calls: [{ name: 'x' }] } },
];

test('refusals are counted per call for the source, with their tools and reasons', () => {
  assert.deepEqual(summarizePreDispatchRefusals(events, 7), { count: 4, tools: ['write_file'], details: ['coverage_missing'] });
  assert.deepEqual(summarizePreDispatchRefusals(events).count, 5);
  assert.deepEqual(summarizePreDispatchRefusals([], 7), { count: 0, tools: [], details: [] });
});

test('the blocked reason names the refusal when there was one, and the phantom completion when there was none', () => {
  const refused = noEffectStepReason({ stepId: 'save_drafts', effectClass: 'write', refusals: summarizePreDispatchRefusals(events, 7) });
  assert.equal(refused, 'Step "save_drafts" is a write step: it called write_file 4 times and the host refused every call before dispatch (coverage_missing), so the write was not performed. The step\'s arguments were not the problem; the refusal was.');
  const phantom = noEffectStepReason({ stepId: 'notify', effectClass: 'send', refusals: { count: 0, tools: [], details: [] } });
  assert.match(phantom, /completed without calling any tool — the send was not actually performed/);
});
