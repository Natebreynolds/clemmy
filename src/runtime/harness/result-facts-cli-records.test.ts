import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recordsAtRecordPath, deriveResultHandleFactsFromRaw } from './result-facts.js';

const observation = (stdout: string) => ({
  result: {
    version: 1, status: 'exited', operationId: 'salesforce_sf_soql_query', executableRealpath: '/usr/local/bin/sf',
    argv: ['data', 'query', '--json'], exitCode: 0, signal: null, stdout, stderr: '',
  },
  complete: true,
});

test('a reviewed-CLI observation resolves its records through the stdout document, matching handle creation', () => {
  const raw = observation(JSON.stringify({ status: 0, result: { records: [{ Id: 'a' }, { Id: 'b' }, { Id: 'c' }], totalSize: 3, done: true } }));
  const facts = deriveResultHandleFactsFromRaw(raw);
  assert.equal(facts.recordCount, 3);
  assert.ok(facts.recordPath, 'handle creation found the records');
  const records = recordsAtRecordPath(raw, facts.recordPath);
  assert.equal(records?.length, 3, 'the audit walks the same document handle creation counted');
});

test('a reviewed-CLI observation whose stdout is not JSON resolves no records', () => {
  const raw = observation('plain text output');
  assert.equal(recordsAtRecordPath(raw, 'result.stdout.result.records'), null);
});
