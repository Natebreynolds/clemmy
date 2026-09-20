import assert from 'node:assert/strict';
import test from 'node:test';
import { observeReviewedLocalTool, reviewedLocalToolArgumentsMatch } from './reviewed-local-tool-transport.js';
import { normalizeReviewedLocalWorkflowArguments } from './reviewed-local-workflow-capability.js';
import { reconcileReviewedLocalFile } from './local-file-workflow-carrier.js';
import { deriveLocalPlanningDefinitions, localPlanningArgumentsMatch } from './local-planning-capability.js';
import { TOOL_REGISTRY } from '../../tools/tool-registry.js';

test('chat publishes exact file modes while workflow freezes the full revision arguments', () => {
  const observed = observeReviewedLocalTool('write_file');
  assert.ok(observed);
  const declaration = TOOL_REGISTRY.find(entry => entry.name === 'write_file');
  assert.ok(declaration);
  const chat = deriveLocalPlanningDefinitions({ declaration, schema: observed.schema, carrier: 'work_call' });
  assert.equal(chat.ok, true, chat.ok ? '' : chat.reason);
  if (!chat.ok) return;
  assert.deepEqual(chat.definitions.map(d => d.capabilityRef), [
    'cap:local:write_file:create', 'cap:local:write_file:append', 'cap:local:write_file:overwrite',
  ]);
  assert.equal(observed.definition.capabilityRef, 'cap:local:write_file:reversible');
  assert.deepEqual(observed.definition.descriptor.destinationPostures, ['create_new', 'named_existing']);
  for (const [mode, append, expected] of [
    ['create', null, 'create'], [null, null, 'create'],
    ['append', null, 'append'], ['overwrite', null, 'overwrite'],
    ['overwrite', true, 'append'], ['append', false, 'overwrite'],
  ] as const) {
    const args = { path: '/tmp/contract-only-no-write.txt', content: 'test', mode, append };
    assert.deepEqual(chat.definitions.filter(d => localPlanningArgumentsMatch(d, args))
      .map(d => d.capabilityRef), [`cap:local:write_file:${expected}`]);
    assert.equal(reviewedLocalToolArgumentsMatch(observed, args), true);
  }
  for (const args of [null, {mode:'delete'}, {mode:'append', append:'true'}]) {
    assert.equal(chat.definitions.some(d => localPlanningArgumentsMatch(d, args)), false);
    assert.equal(reviewedLocalToolArgumentsMatch(observed, args), false);
  }
});

test('workflow file defaults remain create while explicit revision modes are admitted', () => {
  const observed = observeReviewedLocalTool('write_file');
  assert.ok(observed);
  assert.equal(observed.definition.reversibility, 'reversible');
  const base = { path: '/tmp/contract-only-no-write.txt', content: 'test' };
  const normalized = normalizeReviewedLocalWorkflowArguments('write_file', base);
  assert.deepEqual(normalized, { ...base, mode: 'create' });
  assert.deepEqual(normalizeReviewedLocalWorkflowArguments('write_file', { ...base, mode: null, append: null }), normalized);
  assert.equal(reviewedLocalToolArgumentsMatch(observed, normalized), true);
  for (const extra of [{ mode: 'append' }, { mode: 'overwrite' }, { append: true }, { append: false }]) {
    assert.equal(reviewedLocalToolArgumentsMatch(observed,
      normalizeReviewedLocalWorkflowArguments('write_file', { ...base, ...extra })), true);
  }
  for (const extra of [{ mode: 'delete' }, { append: 'true' }, { content: 123 }, { path: '' }]) {
    assert.equal(reviewedLocalToolArgumentsMatch(observed, { ...normalized, ...extra }), false);
  }
  assert.equal(reviewedLocalToolArgumentsMatch(observed, { ...normalized, extra: true }), false);
});

test('file reconciliation cannot infer a commit from a path or malformed identity', () => {
  for (const id of ['/tmp/contract-only-no-write.txt', 'local-file-receipt:v1:???',
    'local-file-receipt:v1:' + Buffer.from('{}').toString('base64url')]) {
    assert.deepEqual(reconcileReviewedLocalFile(id), { exists: false });
  }
});
