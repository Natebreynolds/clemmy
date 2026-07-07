/**
 * Run: npx tsx --test src/execution/workflow-quality-contract.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  distillQualityCriteria,
  mergeQualityCriteria,
  dedupeQualityCriteria,
  applyLearnedQualityCriteria,
  workflowQualityCriteria,
  renderQualityContract,
} from './workflow-quality-contract.js';

test('flips common "it didn\'t do X" complaints into affirmative Must-do criteria', () => {
  assert.deepEqual(
    distillQualityCriteria('The emails did not mention the prospect\'s company'),
    ["Must mention the prospect's company"],
  );
  assert.deepEqual(
    distillQualityCriteria('missing a call to action'),
    ['Must include a call to action'],
  );
  assert.deepEqual(
    distillQualityCriteria('it had placeholder text left in'),
    ['Must not contain placeholder text left in'],
  );
  assert.deepEqual(
    distillQualityCriteria('the report was too generic'),
    ['Must not be too generic'],
  );
});

test('splits multi-part feedback into one criterion per complaint', () => {
  const criteria = distillQualityCriteria(
    'It didn\'t cite sources; also the summary was inaccurate and there was no next-steps section.',
  );
  assert.deepEqual(criteria, [
    'Must cite sources',
    'Must not be inaccurate',
    'Must include next-steps section',
  ]);
});

test('keeps un-flippable feedback as an explicit requirement rather than dropping it', () => {
  assert.deepEqual(
    distillQualityCriteria('tone should match our brand voice'),
    ['Tone must match our brand voice'],
  );
  assert.deepEqual(
    distillQualityCriteria('reference the Q3 revenue figure from the deck'),
    ['Must address: reference the Q3 revenue figure from the deck'],
  );
});

test('dedupe/merge collapses paraphrase-equal criteria and caps the bar', () => {
  assert.deepEqual(
    dedupeQualityCriteria(['Must cite sources', 'must   cite sources.', 'Must Cite Sources!']),
    ['Must cite sources'],
  );
  const merged = mergeQualityCriteria(['Must cite sources'], ['Must cite sources', 'Must include a CTA']);
  assert.deepEqual(merged, ['Must cite sources', 'Must include a CTA']);
});

test('applyLearnedQualityCriteria appends to goal.successCriteria and synthesizes an objective when absent', () => {
  const def = {
    name: 'outreach',
    description: 'Draft and send tailored prospect emails.',
    enabled: true,
    trigger: { manual: true },
    steps: [{ id: 'draft', prompt: 'Draft emails.' }],
  };
  const result = applyLearnedQualityCriteria(def, 'the emails did not mention the prospect company and were too generic');
  assert.equal(result.changed, true);
  assert.equal(result.def.goal?.objective, 'Draft and send tailored prospect emails.');
  assert.deepEqual(result.def.goal?.successCriteria, [
    'Must mention the prospect company',
    'Must not be too generic',
  ]);
  // The original workflow object is not mutated.
  assert.equal(def.goal, undefined);
});

test('learning is idempotent — re-applying the same feedback adds nothing new', () => {
  const def = {
    name: 'wf', description: 'do a thing', enabled: true, trigger: { manual: true },
    goal: { objective: 'do a thing', successCriteria: ['Must cite sources'] },
    steps: [{ id: 's', prompt: 'p' }],
  };
  const again = applyLearnedQualityCriteria(def, 'it did not cite sources');
  assert.equal(again.changed, false);
  assert.deepEqual(again.added, []);
  assert.deepEqual(workflowQualityCriteria(again.def), ['Must cite sources']);
});

test('renderQualityContract shows the bar (or invites the first criterion)', () => {
  const empty = renderQualityContract({ name: 'wf', description: 'd', enabled: true, trigger: { manual: true }, steps: [] });
  assert.match(empty, /no learned quality criteria yet/);
  const withBar = renderQualityContract({
    name: 'wf', description: 'd', enabled: true, trigger: { manual: true }, steps: [],
    goal: { objective: 'd', successCriteria: ['Must cite sources', 'Must include a CTA'] },
  });
  assert.match(withBar, /judged against these 2 criteria/);
  assert.match(withBar, /1\. Must cite sources/);
});
