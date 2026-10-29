import assert from 'node:assert/strict';
import test from 'node:test';
import { readSavedFileNavigation, savedFilesDestination } from './saved-file-navigation';

const ref = { sessionId: 'background:exact', fileId: 'opaque?id#one', name: 'Summary.pdf', folder: '' };
test('standalone saved results open their exact viewer, including colon-bearing run identities', () => {
  const destination = savedFilesDestination(ref.sessionId, ref);
  assert.equal(destination.pathname, '/chat/harness%3Abackground%3Aexact');
  assert.deepEqual(destination.state, { openSavedFile: ref });
  assert.deepEqual(readSavedFileNavigation(destination.state.openSavedFile, ref.sessionId), ref);
  assert.deepEqual(savedFilesDestination(ref.sessionId).state, { showSavedFiles: true });
});
test('file navigation rejects path-only records, foreign sessions and malformed identities', () => {
  assert.equal(readSavedFileNavigation(ref, 'another-session'), null);
  assert.equal(readSavedFileNavigation({ ...ref, fileId: undefined }, ref.sessionId), null);
  assert.equal(readSavedFileNavigation({ ...ref, fileId: 'bad\nidentity' }, ref.sessionId), null);
  assert.equal(readSavedFileNavigation({ ...ref, folder: undefined }, ref.sessionId), null);
  assert.equal(readSavedFileNavigation('/reported/path.pdf', ref.sessionId), null);
});
