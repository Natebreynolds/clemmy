import test from 'node:test';
import assert from 'node:assert/strict';
import { taskResultFiles } from './task-results';
import type { SessionFile } from './session-files';

const saved: SessionFile = { fileId: 'sf_recorded', name: 'Summary.pdf', folder: 'Saved files', place: 'Project files',
  kind: 'pdf', bytes: 240, modifiedAt: '2026-10-29', openable: true };

test('task result actions preserve server file identity and the scoped producing run', () => {
  assert.deepEqual(taskResultFiles('background:fixture', [saved]), [{ file: saved,
    ref: { sessionId: 'background:fixture', fileId: 'sf_recorded', name: 'Summary.pdf', folder: 'Saved files' } }]);
});

test('filenames and raw paths never invent a file action; duplicates stay one result', () => {
  assert.deepEqual(taskResultFiles('background:fixture', [{ ...saved, fileId: undefined }]), []);
  assert.deepEqual(taskResultFiles('', [saved]), []);
  assert.equal(taskResultFiles('background:fixture', [saved, { ...saved, name: 'Old name.pdf' }]).length, 1);
});
