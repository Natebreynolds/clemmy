import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';

const TEST_HOME = '/tmp/clemmy-memory-reliability-eval';
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';
delete process.env.OPENAI_API_KEY;

const { openMemoryDb, resetMemoryDb } = await import('../../memory/db.js');
const { runEvalSuite } = await import('./eval-case.js');
const {
  buildAllMemoryReliabilityEvalCases,
  MEMORY_INTEGRITY_DIMENSIONS,
  MEMORY_RELIABILITY_CORPUS,
} = await import('./memory-reliability-corpus.js');

before(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
  mkdirSync(TEST_HOME, { recursive: true });
});

test('memory reliability corpus covers every required evaluation dimension', () => {
  const dimensions = new Set(MEMORY_RELIABILITY_CORPUS.map((scenario) => scenario.dimension));
  for (const dimension of MEMORY_INTEGRITY_DIMENSIONS) dimensions.add(dimension);
  for (const dimension of [
    'direct_recall', 'multi_session_reasoning', 'temporal_reasoning', 'knowledge_update',
    'abstention', 'source_attribution', 'constraint_compliance', 'graph_traversal',
    'recorded_meeting_recall', 'meeting_claim_lifecycle', 'candidate_reconciliation',
    'fact_deduplication', 'reflection_replay', 'capture_replay', 'intake_quality', 'identity_resolution', 'resource_grounding', 'merge_integrity',
    'observation_idempotency', 'relationship_idempotency',
  ] as const) assert.ok(dimensions.has(dimension), `missing ${dimension}`);
});

test('tail and recorded-meeting incidents are release-gated by realistic fixtures', () => {
  const tail = MEMORY_RELIABILITY_CORPUS.find((scenario) => scenario.id === 'memory-direct-tail-token');
  assert.ok((tail?.tailFixture?.newerFacts ?? 0) > 500, 'tail target must really sit beyond the former prefilter');
  assert.ok((tail?.tailFixture?.minimumRecencyRank ?? 0) > 500);
  const meeting = MEMORY_RELIABILITY_CORPUS.find((scenario) => scenario.id === 'memory-in-person-meeting-today');
  const recordedEpisode = meeting?.episodes?.find((episode) => episode.subtype === 'meeting');
  assert.equal(recordedEpisode?.sourceApp, 'Clementine Meetings (In-person)');
  assert.equal(meeting?.expect.requiredTopType, 'episode');
  assert.ok(meeting?.expect.requiredWhy?.includes('exact temporal match'));
});

test('memory reliability corpus passes deterministically at pass^3', async () => {
  const reset = () => { resetMemoryDb(); openMemoryDb(); };
  const report = await runEvalSuite(buildAllMemoryReliabilityEvalCases(reset), { k: 3 });
  assert.equal(report.passHatKRate, 1, report.cases.filter((result) => !result.passHatK).map((result) => `${result.id}: ${result.firstFailDetail}`).join('\n'));
});
