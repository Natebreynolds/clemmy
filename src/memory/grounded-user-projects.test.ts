import test from 'node:test';
import assert from 'node:assert/strict';
import { extractGroundedUserProjects as extract } from './grounded-user-projects.js';
test('captures exact explicit project names, including numeric distinctions', () => {
  assert.deepEqual(extract('Remember for project Orchard Learning Cycle Birch 2026: use hours. For project Orchard Learning Cycle Birch 2027: use minutes.'), ['Orchard Learning Cycle Birch 2026', 'Orchard Learning Cycle Birch 2027']);
});
test('quoted names retain lowercase and punctuation without invented aliases', () => {
  assert.deepEqual(extract('For project named “my launch: phase-2”, use hours. Project called \'Acme lab\' uses seconds.'), ['my launch: phase-2', 'Acme lab']);
});
test('does not promote task prose, generic test words, or unlabeled titles', () => {
  assert.deepEqual(extract('This is a test. Project scope is unclear. Compare Orchard Birch with Orchard Cedar. For project Alpha Beta use hours.'), []);
});
test('deduplicates explicit names and preserves full titles through punctuation', () => {
  assert.deepEqual(extract('The project Delta Launch 2030. Project "Delta Launch 2030" is named twice.'), ['Delta Launch 2030']);
});
