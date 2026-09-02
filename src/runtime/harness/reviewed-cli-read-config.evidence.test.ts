/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/reviewed-cli-read-config.evidence.test.ts
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

const { liveReadCompletenessEvidencePaths, REVIEWED_CLI_ARGUMENT_COMPILER_ID } = await import('./reviewed-cli-read-config.js');

test('a settled live read proves completeness at the path its lane actually fills: stdout for a reviewed CLI, data for a provider gateway', () => {
  // 2026-09-01: friday-dashboard's six SOQL reads crossed and were refused completeness_evidence_missing:data.
  assert.deepEqual([...liveReadCompletenessEvidencePaths(REVIEWED_CLI_ARGUMENT_COMPILER_ID)], ['stdout']);
  assert.deepEqual([...liveReadCompletenessEvidencePaths('composio:exact-args:v1')], ['data']);
  assert.deepEqual([...liveReadCompletenessEvidencePaths('')], ['data']);
});
