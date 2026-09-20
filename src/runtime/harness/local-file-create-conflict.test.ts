import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalFileCreateConflict, isKnownLocalFileCreateConflict } from './local-file-create-conflict.js';
import { classifyAttemptOutcome } from './attempt-outcome.js';

test('only nominal local pre-write conflicts can leave uncertain-write recovery', () => {
  const conflict = new LocalFileCreateConflict('existing file');
  for (const [error, provider, known] of [
    [conflict, 'local_registry', true],
    [conflict, 'composio', false],
    [new Error('existing file'), 'local_registry', false],
    [JSON.parse(JSON.stringify(conflict)), 'local_registry', false],
  ] as const) {
    const acknowledged = isKnownLocalFileCreateConflict(error, provider);
    assert.equal(acknowledged, known);
    const result = classifyAttemptOutcome({ executionFailed: true, mutating: true, acknowledged });
    assert.equal(result.kind === 'uncertain_write', !known);
    assert.notEqual(result.kind, 'succeeded');
  }
});
