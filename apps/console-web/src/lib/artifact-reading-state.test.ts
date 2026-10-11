import test from 'node:test';
import assert from 'node:assert/strict';
import { artifactReadingKey, readArtifactReadingState, rememberArtifactReadingState } from './artifact-reading-state.js';

test('the same recorded file resumes across surfaces; legacy filenames remain scoped', () => {
  const first = { sessionId: 'chat-one', folder: 'drafts', name: 'brief.pdf', fileId: 'recorded-brief' };
  const sharedKey = artifactReadingKey(first);
  rememberArtifactReadingState(sharedKey, { pdfPage: 4, pdfZoom: 1.5, scroll: { 'pdf:4': { top: 280, left: 12 } } });
  const elsewhere = artifactReadingKey({ ...first, sessionId: 'worker-one' });
  assert.equal(elsewhere, sharedKey);
  assert.equal(readArtifactReadingState(elsewhere).pdfPage, 4);
  assert.equal(readArtifactReadingState(elsewhere).scroll['pdf:4'].top, 280);
  assert.notEqual(artifactReadingKey({ ...first, fileId: undefined }), artifactReadingKey({ ...first, fileId: undefined, sessionId: 'another-chat' }));
});

test('file states stay separate and scrolling does not erase page or source choice', () => {
  rememberArtifactReadingState('state-a', { source: true, pdfPage: 2 });
  rememberArtifactReadingState('state-a', { scroll: { source: { top: 150, left: 0 } } });
  assert.equal(readArtifactReadingState('state-a').source, true);
  assert.equal(readArtifactReadingState('state-a').pdfPage, 2);
  assert.equal(readArtifactReadingState('state-b').source, false);
  assert.deepEqual(readArtifactReadingState('state-b').scroll, {});
});

test('bounded reading history discards oldest files and rejects unusable page or zoom state', () => {
  rememberArtifactReadingState('oldest-test-file', { pdfPage: 10 });
  for (let n = 0; n < 160; n++) rememberArtifactReadingState(`bounded-file-${n}`, { pdfPage: n + 1 });
  assert.equal(readArtifactReadingState('oldest-test-file').pdfPage, 1);
  rememberArtifactReadingState('invalid-page', { pdfPage: NaN, pdfZoom: -1 });
  assert.equal(readArtifactReadingState('invalid-page').pdfPage, 1);
  assert.equal(readArtifactReadingState('invalid-page').pdfZoom, 'fit');
});
