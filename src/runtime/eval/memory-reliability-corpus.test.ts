import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';

const TEST_HOME = '/tmp/clemmy-memory-reliability-eval';
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';
delete process.env.OPENAI_API_KEY;

const { openMemoryDb, resetMemoryDb } = await import('../../memory/db.js');
const { runEvalSuite } = await import('./eval-case.js');
const { buildMemoryReliabilityEvalCases, MEMORY_RELIABILITY_CORPUS } = await import('./memory-reliability-corpus.js');

before(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
  mkdirSync(TEST_HOME, { recursive: true });
});

test('memory reliability corpus covers every required evaluation dimension', () => {
  const dimensions = new Set(MEMORY_RELIABILITY_CORPUS.map((scenario) => scenario.dimension));
  for (const dimension of [
    'direct_recall', 'multi_session_reasoning', 'temporal_reasoning', 'knowledge_update',
    'abstention', 'source_attribution', 'constraint_compliance', 'graph_traversal',
  ] as const) assert.ok(dimensions.has(dimension), `missing ${dimension}`);
});

test('memory reliability corpus passes deterministically at pass^3', async () => {
  const reset = () => { resetMemoryDb(); openMemoryDb(); };
  const report = await runEvalSuite(buildMemoryReliabilityEvalCases(reset), { k: 3 });
  assert.equal(report.passHatKRate, 1, report.cases.filter((result) => !result.passHatK).map((result) => `${result.id}: ${result.firstFailDetail}`).join('\n'));
});
