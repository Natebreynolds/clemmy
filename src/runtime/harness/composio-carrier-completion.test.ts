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

test('a doubled toolkit prefix on a proven operation is completed to that operation; an unknown slug is left for the exact refusal', () => {
  const proven = [
    { kind: 'composio', identifier: 'OUTLOOK_LIST_EVENTS', effectClass: 'read' },
    { kind: 'composio', identifier: 'OUTLOOK_SEND_EMAIL', effectClass: 'write' },
  ];
  // The live standup step (2026-09-02): the model wrote OUTLOOK_OUTLOOK_SEND_EMAIL
  // twice against a step whose prepared catalog held OUTLOOK_SEND_EMAIL.
  const stuttered = JSON.stringify({
    name: 'composio_execute_tool',
    args_json: JSON.stringify({ tool_slug: 'OUTLOOK_OUTLOOK_SEND_EMAIL', arguments: JSON.stringify({ to_email: 'nate@example.com', subject: 'Daily Standup', body: 'x' }) }),
  });
  const completed = completeComposioCarrierArguments(stuttered, proven);
  assert.ok(completed);
  assert.equal(completed!.toolSlug, 'OUTLOOK_SEND_EMAIL');
  assert.match(completed!.changes.join(' | '), /collapsed to the proven operation OUTLOOK_SEND_EMAIL/);
  const inner = JSON.parse((JSON.parse(completed!.argumentsJson) as { args_json: string }).args_json) as { tool_slug: string; arguments: string };
  assert.equal(inner.tool_slug, 'OUTLOOK_SEND_EMAIL');
  assert.equal(JSON.parse(inner.arguments).subject, 'Daily Standup');
  // A slug that is not a stutter of a proven operation is not guessed.
  const unknown = JSON.stringify({
    name: 'composio_execute_tool',
    args_json: JSON.stringify({ tool_slug: 'OUTLOOK_OUTLOOK_CREATE_DRAFT', arguments: '{}' }),
  });
  assert.equal(completeComposioCarrierArguments(unknown, proven), null);
});

test('a sealed step calls the gateway directly: the frozen scope stands in for proven entries and the inner args come back completed', async () => {
  const registry = await import('./carrier-completion-registry.js');
  await import('./carrier-completion.js');
  assert.equal(registry.isRegisteredCarrierGateway('composio_execute_tool'), true);
  assert.equal(registry.isRegisteredCarrierGateway('work_call'), false);
  const frozen = [
    { kind: 'frozen_scope', identifier: 'OUTLOOK_LIST_EVENTS' },
    { kind: 'frozen_scope', identifier: 'OUTLOOK_SEND_EMAIL' },
  ];
  const direct = JSON.stringify({ tool_slug: 'OUTLOOK_OUTLOOK_SEND_EMAIL', arguments: JSON.stringify({ to_email: 'nate@example.com', subject: 'Daily Standup', body: 'x' }) });
  const completed = registry.completeDirectCarrierArguments('composio_execute_tool', direct, frozen);
  assert.ok(completed);
  assert.equal(completed!.toolSlug, 'OUTLOOK_SEND_EMAIL');
  const inner = JSON.parse(completed!.argumentsJson) as { tool_slug: string; arguments: string };
  assert.equal(inner.tool_slug, 'OUTLOOK_SEND_EMAIL');
  assert.equal(JSON.parse(inner.arguments).subject, 'Daily Standup');
  // Exact already: nothing to complete.
  const exact = JSON.stringify({ tool_slug: 'OUTLOOK_SEND_EMAIL', arguments: '{}' });
  assert.equal(registry.completeDirectCarrierArguments('composio_execute_tool', exact, frozen), null);
});
