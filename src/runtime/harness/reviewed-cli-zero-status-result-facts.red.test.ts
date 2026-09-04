/**
 * Run:
 *   node scripts/run-tests-isolated.mjs src/runtime/harness/reviewed-cli-zero-status-result-facts.red.test.ts
 *
 * Live regression (2026-09-04, source 129591): a reviewed local process
 * completed successfully, while its JSON stdout used the conventional
 * process/provider status value `0` and returned an empty record set. The
 * outer retained process observation is the execution verdict; the nested
 * status value must not turn that successful observation into failed evidence.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveResultHandleFactsFromRaw } from './result-facts.js';

test('a successfully exited reviewed process keeps empty status-zero stdout as successful evidence', () => {
  const facts = deriveResultHandleFactsFromRaw({
    result: {
      version: 1,
      status: 'exited',
      operationId: 'reviewed_live_read',
      executableRealpath: '/opt/reviewed/bin/read',
      argv: ['data', 'query', '--json'],
      exitCode: 0,
      signal: null,
      stdout: JSON.stringify({
        status: 0,
        result: {
          records: [],
          totalSize: 0,
          done: true,
        },
        warnings: [],
      }),
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
    },
    complete: true,
  });

  assert.equal(facts.success, true);
  assert.equal(facts.recordPath, 'result.stdout.result.records');
  assert.equal(facts.recordCount, 0);
});
