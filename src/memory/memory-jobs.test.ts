/**
 * Run: node scripts/run-tests-isolated.mjs src/memory/memory-jobs.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MEMORY_JOB_IDS, MEMORY_JOBS, isMemoryJobId, memoryJobChannel, memoryJobFromChannel, memoryJobUsesMemoryModel } from './memory-jobs.js';

test('a job id round-trips through its ledger channel', () => {
  for (const id of MEMORY_JOB_IDS) assert.equal(memoryJobFromChannel(memoryJobChannel(id)), id);
  assert.equal(memoryJobFromChannel('memory:not-a-job'), null);
  assert.equal(memoryJobFromChannel('judge:completion'), null);
  assert.equal(memoryJobFromChannel(undefined), null);
  assert.equal(isMemoryJobId('learn'), true);
  assert.equal(isMemoryJobId('toString'), false);
});

test('independent checks stay on the checker; the search index stays local', () => {
  assert.equal(MEMORY_JOBS.standing.modelOwner, 'checker');
  assert.equal(MEMORY_JOBS.verify.modelOwner, 'checker');
  assert.equal(MEMORY_JOBS.index.modelOwner, 'local');
  assert.deepEqual(MEMORY_JOB_IDS.filter(memoryJobUsesMemoryModel), ['learn', 'reconcile', 'patterns', 'skills', 'identity', 'import']);
});

test('the nightly jobs keep their clock; jobs started by an event have none', async () => {
  const { MEMORY_JOB_CLOCKS, memoryJobClock } = await import('./memory-jobs.js');
  // The recursive reflection and hygiene ticks and the self-heal slot read
  // these; a change here moves the schedule itself, not just the Memory tab.
  assert.deepEqual(MEMORY_JOB_CLOCKS.patterns, { hour: 3, minute: 0 });
  assert.deepEqual(MEMORY_JOB_CLOCKS.tidy, { hour: 4, minute: 0 });
  assert.deepEqual(MEMORY_JOB_CLOCKS.verify, { hour: 4, minute: 35 });
  for (const id of MEMORY_JOB_IDS) {
    assert.equal(memoryJobClock(id) !== null, id === 'patterns' || id === 'tidy' || id === 'verify', id);
  }
});
