/**
 * Run: npx tsx --test src/runtime/codex-fc-id.test.ts
 *
 * Codex /responses function_call item-id sanitization. The bug: a function_call
 * item whose `id` is NOT a Codex-issued 'fc…' id (cross-provider history, a
 * harness timestamp id, or a synthetic parallel `_p<n>`) made Codex 400 the
 * whole request ("Expected an ID that begins with 'fc'"). The id is optional on
 * input (call_id correlates), so a non-fc id is dropped, not forwarded.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isCodexFunctionCallItemId, functionCallInput } from './codex-native-runtime.js';

test('isCodexFunctionCallItemId accepts only genuine Codex ids', () => {
  assert.equal(isCodexFunctionCallItemId('fc_0a1b2c3d'), true);
  assert.equal(isCodexFunctionCallItemId('fc12345'), true);
  // the exact id from the observed 400:
  assert.equal(isCodexFunctionCallItemId('2026062213470609e75ac7acca4152'), false);
  assert.equal(isCodexFunctionCallItemId('call_abc'), false);          // a call_id, not an item id
  assert.equal(isCodexFunctionCallItemId('fc_abc_p0'), false);          // synthetic parallel-expansion id
  assert.equal(isCodexFunctionCallItemId('fc_abc_p12'), false);
  assert.equal(isCodexFunctionCallItemId(undefined), false);
  assert.equal(isCodexFunctionCallItemId(''), false);
});

test('functionCallInput DROPS a non-fc id (the bug fix) but keeps call_id correlation', () => {
  const item = functionCallInput({ id: '2026062213470609e75ac7acca4152', call_id: 'call_xyz', name: 'do_thing', arguments: '{"a":1}' } as never) as Record<string, unknown>;
  assert.equal(item.id, undefined, 'a non-fc id must NOT be forwarded to Codex');
  assert.equal(item.call_id, 'call_xyz', 'call_id (the correlator) is preserved');
  assert.equal(item.type, 'function_call');
  assert.equal(item.name, 'do_thing');
});

test('functionCallInput KEEPS a genuine fc id', () => {
  const item = functionCallInput({ id: 'fc_real123', call_id: 'call_xyz', name: 'do_thing', arguments: '{}' } as never) as Record<string, unknown>;
  assert.equal(item.id, 'fc_real123');
  assert.equal(item.call_id, 'call_xyz');
});

test('functionCallInput drops a synthetic parallel id', () => {
  const item = functionCallInput({ id: 'fc_base_p0', call_id: 'fc_base_p0', name: 't', arguments: '{}' } as never) as Record<string, unknown>;
  assert.equal(item.id, undefined, 'synthetic _p<n> id is not a real Codex id');
});
