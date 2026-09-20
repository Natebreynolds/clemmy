import test from 'node:test';
import assert from 'node:assert/strict';
import { deliverableRecallScore as score, explicitlyNamesDeliverable as names } from './deliverable-recall-score.js';
test('weak recent artifacts are omitted from ambient context, not promoted above relevance', () => {
  assert.equal(score(0.29, false, true), null);
  assert.equal(score(0.29, false, false), 0.29);
});
test('relevant saved work retains its index score and remains in the primer', () => {
  assert.equal(score(0.75, false, true), 0.75);
  assert.equal(score(0.45, false, true), 0.45);
});
test('relevant missing artifacts remain visible as negative evidence', () => {
  assert.equal(score(0.9, true, false), 0.4);
  assert.equal(score(0.9, true, true), 0.4);
});
test('invalid scores cannot become ranking evidence', () => {
  assert.equal(score(NaN, false, true), null);
  assert.equal(score(Infinity, false, false), null);
});

test('long natural requests retain an exact filename signal', () => {
  assert.equal(names('Where is the saved file example-proof.txt that we created earlier? Give its existing path only.', 'example-proof.txt'), true);
  assert.equal(names('Find "Example Proof.txt".', 'Example Proof.txt'), true);
  assert.equal(names('Find /tmp/example-proof.txt.', '/tmp/example-proof.txt'), true);
});
test('filename prefixes and embedded names are not exact artifact matches', () => {
  assert.equal(names('Find example-proof.txt.backup', 'example-proof.txt'), false);
  assert.equal(names('Find other-example-proof.txt', 'example-proof.txt'), false);
});
