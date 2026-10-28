/** Run: node scripts/run-tests-isolated.mjs src/execution/workflow-hook-key.test.ts */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { presentedHookKey, workflowHookAddress, workflowHookKey, workflowHookKeyMatches } from './workflow-hook-key.js';

test('each hook gets its own key from the installation secret; the key opens that hook and nothing else', () => {
  const a = workflowHookKey('s3cret', 'new-lead');
  const b = workflowHookKey('s3cret', 'invoice-paid');
  assert.ok(a && b && a !== b);
  assert.equal(workflowHookKey('s3cret', 'new-lead'), a, 'stable: nothing is stored');
  assert.notEqual(workflowHookKey('rotated', 'new-lead'), a, 'rotating the secret rotates every key');
  assert.notEqual(a, 's3cret');
  assert.equal(workflowHookKey('', 'new-lead'), null);
  assert.ok(workflowHookKeyMatches('s3cret', 'new-lead', a));
  assert.ok(!workflowHookKeyMatches('s3cret', 'invoice-paid', a), 'one hook\'s key does not open another');
  assert.ok(!workflowHookKeyMatches('s3cret', 'new-lead', a!.slice(0, -1)));
  assert.ok(!workflowHookKeyMatches('s3cret', 'new-lead', undefined));
  assert.ok(!workflowHookKeyMatches('', 'new-lead', ''));
});

test('the key arrives as ?key= or a header, and the address carries it', () => {
  assert.equal(presentedHookKey({ query: { key: 'k1' } }), 'k1');
  assert.equal(presentedHookKey({ headers: { 'x-clementine-hook-key': 'k2' } }), 'k2');
  assert.equal(presentedHookKey({ query: {}, headers: {} }), null);
  assert.equal(workflowHookAddress('https://h/api/hooks/workflows/', 'new-lead', 'k1'), 'https://h/api/hooks/workflows/new-lead?key=k1');
  assert.equal(workflowHookAddress('https://h/api/hooks/workflows/', 'new-lead', null), 'https://h/api/hooks/workflows/new-lead');
});
