import test from 'node:test';
import assert from 'node:assert/strict';
import { groundedEntityMentionIds as select } from './grounded-entity-mentions.js';
const entities = [
  { id: 1, names: ['Harness Cedar Observatory 100', 'Cedar'] },
  { id: 2, names: ['Harness Cedar Observatory 200', 'Cedar'] },
  { id: 3, names: ['Cedar'] },
  { id: 4, names: ['Harness Quartz Observatory 200', 'Quartz'] },
];
test('full canonical project mention suppresses contained aliases to other identities', () => {
  assert.deepEqual(select('For project Harness Cedar Observatory 200, use bounds first.', entities), [2]);
});
test('a shared short alias does not assert any identity', () => {
  assert.deepEqual(select('Cedar prefers bounds first.', entities), []);
});
test('distinct full mentions retain both projects', () => {
  assert.deepEqual(select('Compare Harness Cedar Observatory 100 with Harness Cedar Observatory 200.', entities), [1, 2]);
});
test('unambiguous aliases remain usable and unrelated names are retained', () => {
  assert.deepEqual(select('Harness Cedar Observatory 200 and Quartz both have readings.', entities), [2, 4]);
});
test('same canonical name across identities remains ambiguous', () => {
  assert.deepEqual(select('Acme Research', [{ id: 1, names: ['Acme Research'] }, { id: 2, names: ['Acme Research'] }]), []);
});
test('substring matches do not cross word boundaries; duplicate aliases do not create ambiguity', () => {
  assert.deepEqual(select('Cedars and Quartzite', entities), []);
  assert.deepEqual(select('QUARTZ', [{ id: 4, names: ['Quartz', 'quartz'] }]), [4]);
});
test('an independent shorter mention survives a containing name elsewhere', () => {
  assert.deepEqual(select('Acme Research works with Acme.', [{ id: 1, names: ['Acme'] }, { id: 2, names: ['Acme Research'] }]), [1, 2]);
});

test('direct grounding does not assign a new unregistered project to an old unique alias', () => {
  const rows = [
    { id: 1, canonicalName: 'Harness Cedar Observatory 100', names: ['Harness Cedar Observatory 100', 'Harness Cedar Observatory'] },
    { id: 2, canonicalName: 'Cedar', names: ['Cedar'] },
  ];
  const text = 'For Harness Cedar Observatory 200, labels use Trial.';
  assert.deepEqual(select(text, rows), [1], 'alias remains a recall candidate');
  assert.deepEqual(select(text, rows, true), [], 'neither old alias nor nested Cedar becomes stored proof');
  rows.push({ id: 3, canonicalName: 'Harness Cedar Observatory 200', names: ['Harness Cedar Observatory 200'] });
  assert.deepEqual(select(text, rows, true), [3]);
});

test('direct canonical evidence is case-insensitive and ambiguous aliases remain recall-only', () => {
  const rows = [{ id: 1, canonicalName: 'Cedar Research', names: ['Cedar Research', 'CR Labs'] }];
  assert.deepEqual(select('CEDAR RESEARCH uses red.', rows, true), [1]);
  assert.deepEqual(select('CR Labs uses red.', rows, true), []);
  assert.deepEqual(select('CR Labs uses red.', rows), [1]);
});
