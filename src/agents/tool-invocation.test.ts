import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isCallToolMultiplexerName,
  parseToolAuthority,
  resolveToolInvocation,
} from './tool-invocation.js';

test('external call_tool spelling variants resolve to the same nested authority and args', () => {
  for (const variant of ['call_tool', 'call-tool', 'call.tool', 'callTool']) {
    assert.equal(isCallToolMultiplexerName(`m365__${variant}`), true);
    const resolved = resolveToolInvocation(`mcp__m365__${variant}`, {
      name: 'sharepointDeleteItem',
      args_json: JSON.stringify({ item_id: 'item-1' }),
    });
    assert.equal(resolved.valid, true, variant);
    assert.equal(resolved.externalBroker, true, variant);
    assert.equal(resolved.outerAuthority, `m365__${variant}`, variant);
    assert.equal(resolved.toolName, 'm365__sharepointDeleteItem', variant);
    assert.deepEqual(resolved.args, { item_id: 'item-1' }, variant);
  }
});

test('external broker carriers fail closed on missing, malformed, ambiguous, and recursive targets', () => {
  assert.equal(resolveToolInvocation('m365__call_tool', {}).failure, 'missing-broker-target');
  assert.equal(resolveToolInvocation('m365__call-tool', {
    name: 'delete item',
    args_json: '{}',
  }).failure, 'malformed-broker-target');
  assert.equal(resolveToolInvocation('m365__call.tool', {
    name: 'delete_item',
    args_json: '{not-json',
  }).failure, 'invalid-broker-args');
  assert.equal(resolveToolInvocation('m365__callTool', {
    name: 'delete_item',
    args_json: '{"item_id":"one"}',
    arguments: { item_id: 'two' },
  }).failure, 'ambiguous-broker-args');
  assert.equal(resolveToolInvocation('m365__callTool', {
    name: 'delete_item',
    args_json: '{"item_id":"one"}',
    payload: { item_id: 'two' },
  }).failure, 'ambiguous-broker-args');
  assert.equal(resolveToolInvocation('m365__callTool', {
    name: 'delete_item',
    item_id: 'one',
  }).failure, 'unexpected-broker-field');
  for (const recursive of ['call_tool', 'call-tool', 'call.tool', 'callTool', 'other__callTool']) {
    assert.equal(resolveToolInvocation('m365__call_tool', {
      name: recursive,
      args_json: '{}',
    }).failure, 'recursive-broker-target', recursive);
  }
});

test('payload is a canonical semantic carrier and preserves exact target identity', () => {
  const one = resolveToolInvocation('mcp__m365__callTool', {
    name: 'deleteItem',
    payload: { item_id: 'one' },
    _meta: { requestId: 'transport-only' },
  });
  const two = resolveToolInvocation('mcp__m365__callTool', {
    name: 'deleteItem',
    payload: { item_id: 'two' },
  });
  assert.equal(one.valid, true);
  assert.equal(two.valid, true);
  assert.deepEqual(one.args, { item_id: 'one' });
  assert.deepEqual(two.args, { item_id: 'two' });
  assert.notDeepEqual(one.args, two.args);

  const equivalent = resolveToolInvocation('mcp__m365__callTool', {
    name: 'deleteItem',
    args_json: '{"item_id":"one"}',
    payload: { item_id: 'one' },
  });
  assert.equal(equivalent.valid, true, 'equivalent duplicate carriers retain one semantic identity');
  assert.deepEqual(equivalent.args, { item_id: 'one' });
});

test('only exact clementine-local is local and extra local namespace segments are malformed', () => {
  const exact = parseToolAuthority('mcp__clementine-local__memory_read');
  assert.equal(exact.valid, true);
  assert.equal(exact.local, true);
  assert.equal(exact.authority, 'memory_read');

  const spoof = parseToolAuthority('mcp__Clementine-local__memory_read');
  assert.equal(spoof.valid, false);
  assert.equal(spoof.failure, 'local-authority-spoof');

  const extra = parseToolAuthority('mcp__clementine-local__memory_read__extra');
  assert.equal(extra.valid, false);
  assert.equal(extra.failure, 'malformed-local-tool');
});

test('foreign shell and composio authorities are marked unsafe while exact local shell is preserved', () => {
  assert.equal(resolveToolInvocation('mcp__foreign__run_shell_command', { command: 'pwd' }).unsafeExternalMultiplexer, true);
  assert.equal(resolveToolInvocation('foreign__composio_execute_tool', { tool_slug: 'GMAIL_LIST_MESSAGES' }).unsafeExternalMultiplexer, true);
  const local = resolveToolInvocation('mcp__clementine-local__run_shell_command', { command: 'pwd' });
  assert.equal(local.valid, true);
  assert.equal(local.toolName, 'run_shell_command');
  assert.equal(local.unsafeExternalMultiplexer, false);
});
