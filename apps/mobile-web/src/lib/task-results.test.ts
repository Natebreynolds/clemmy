import assert from 'node:assert/strict';
import test from 'node:test';
import type { SessionFile } from './session-files';
import { taskResultFiles } from './task-results';

test('task result actions require canonical opaque file identity and keep the exact owning session', () => {
  const file = { fileId: 'opaque-canonical', name: 'Forecast.pdf', folder: 'reports', kind: 'pdf' } as SessionFile;
  const result = taskResultFiles('run:exact', [file, file, { name: 'path-only.txt', folder: 'reported-path' } as SessionFile, { ...file, fileId: 'second', folder: undefined } as unknown as SessionFile]);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0]?.ref, { sessionId: 'run:exact', fileId: 'opaque-canonical', name: 'Forecast.pdf', folder: 'reports' });
  assert.deepEqual(taskResultFiles('', [file]), []);
});
