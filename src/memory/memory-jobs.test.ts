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
