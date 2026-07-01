import test from 'node:test';
import assert from 'node:assert/strict';
import {
  nonFilterableToolExcludes,
  resolveEffectiveToolNames,
  resolveEffectiveToolPolicy,
} from './tool-policy.js';

test('resolveEffectiveToolNames applies deny after allow', () => {
  const result = resolveEffectiveToolNames({
    surface: 'test',
    lane: 'chat',
    toolNames: ['a', 'b', 'c'],
    allowedToolNames: ['a', 'b'],
    excludeToolNames: ['b', 'z'],
  });

  assert.deepEqual(result.names, ['a']);
  assert.equal(result.diagnostics.denyAppliedAfterAllow, true);
  assert.deepEqual(result.diagnostics.excludedApplied, ['b']);
  assert.deepEqual(result.diagnostics.excludedMissing, ['z']);
  assert.equal(result.diagnostics.inputCount, 3);
  assert.equal(result.diagnostics.outputCount, 1);
});

test('resolveEffectiveToolPolicy preserves unnamed structural tools', () => {
  const unnamed = {};
  const result = resolveEffectiveToolPolicy({
    surface: 'test',
    lane: 'execution',
    tools: [{ name: 'keep' }, { name: 'drop' }, unnamed],
    excludeToolNames: ['drop'],
  });

  assert.deepEqual(result.tools, [{ name: 'keep' }, unnamed]);
  assert.deepEqual(result.diagnostics.excludedApplied, ['drop']);
});

test('nonFilterableToolExcludes reports excludes outside the enforceable set', () => {
  const missing = nonFilterableToolExcludes(['local', 'server__remote'], new Set(['local']));
  assert.deepEqual(missing, ['server__remote']);
});
