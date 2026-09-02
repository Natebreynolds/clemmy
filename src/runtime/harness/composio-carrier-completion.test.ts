/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/composio-carrier-completion.test.ts
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

const { completeComposioCarrierArguments } = await import('./composio-carrier-completion.js');

const provenSlackRead = [{ kind: 'composio', identifier: 'SLACK_FETCH_CONVERSATION_HISTORY', effectClass: 'read' }];

test('the exact live frame (GLM 5.3, 2026-09-01) is completed: slug bound from the one proven read, payload wrapped, one serialization', () => {
  const outer = JSON.stringify({
    args_json: JSON.stringify({ channel: 'C0BL9LLUSBD', limit: 5 }),
    name: 'composio_execute_tool',
    requirement_id: 'read_latest_messages',
    seal_amendment: null,
    source_call_ids: null,
    source_record_ids: null,
    universe_item_id: 'null',
    universe_selector: null,
  });
  const completed = completeComposioCarrierArguments(outer, provenSlackRead);
  assert.ok(completed);
  assert.equal(completed!.toolSlug, 'SLACK_FETCH_CONVERSATION_HISTORY');
  const parsedOuter = JSON.parse(completed!.argumentsJson) as Record<string, unknown>;
  assert.equal(parsedOuter.name, 'composio_execute_tool');
  assert.equal(parsedOuter.requirement_id, 'read_latest_messages', 'unrelated fields are untouched');
  const inner = JSON.parse(String(parsedOuter.args_json)) as Record<string, unknown>;
  assert.equal(inner.tool_slug, 'SLACK_FETCH_CONVERSATION_HISTORY');
  assert.deepEqual(JSON.parse(String(inner.arguments)), { channel: 'C0BL9LLUSBD', limit: 5 });
  assert.match(completed!.changes.join('; '), /tool_slug bound/);
  assert.match(completed!.changes.join('; '), /wrapped into arguments/);
});

test('an arguments object is serialized once; an already exact carrier is left alone; ambiguity returns null', () => {
  const objectArgs = JSON.stringify({ name: 'composio_execute_tool', args_json: JSON.stringify({ tool_slug: 'SLACK_FETCH_CONVERSATION_HISTORY', arguments: { channel: 'C1', limit: 3 } }) });
  const completed = completeComposioCarrierArguments(objectArgs, []);
  assert.ok(completed);
  const inner = JSON.parse(String((JSON.parse(completed!.argumentsJson) as { args_json: string }).args_json)) as { arguments: string };
  assert.equal(typeof inner.arguments, 'string');
  assert.deepEqual(JSON.parse(inner.arguments), { channel: 'C1', limit: 3 });

  const exact = JSON.stringify({ name: 'composio_execute_tool', args_json: JSON.stringify({ tool_slug: 'X', arguments: '{"a":1}' }) });
  assert.equal(completeComposioCarrierArguments(exact, provenSlackRead), null, 'nothing to complete');

  const slugless = JSON.stringify({ name: 'composio_execute_tool', args_json: JSON.stringify({ limit: 5 }) });
  assert.equal(completeComposioCarrierArguments(slugless, []), null, 'no proven read: the refusal names the shape');
  assert.equal(completeComposioCarrierArguments(slugless, [
    ...provenSlackRead,
    { kind: 'composio', identifier: 'SLACK_LIST_CHANNELS', effectClass: 'read' },
  ]), null, 'two proven reads: never guess');
  assert.equal(completeComposioCarrierArguments(slugless, [{ kind: 'composio', identifier: 'GOOGLESHEETS_BATCH_UPDATE', effectClass: 'write' }]), null, 'a proven WRITE never completes a carrier');
  assert.equal(completeComposioCarrierArguments(JSON.stringify({ name: 'space_history', args_json: '{}' }), provenSlackRead), null, 'only the composio gateway is completed');
  assert.equal(completeComposioCarrierArguments('not json', provenSlackRead), null);
});

test('the args alias is renamed to args_json so the work_call schema accepts it', () => {
  const aliased = JSON.stringify({ name: 'composio_execute_tool', args: { channel: 'C1' } });
  const completed = completeComposioCarrierArguments(aliased, provenSlackRead);
  assert.ok(completed);
  const outer = JSON.parse(completed!.argumentsJson) as Record<string, unknown>;
  assert.equal('args' in outer, false);
  assert.equal(typeof outer.args_json, 'string');
});
