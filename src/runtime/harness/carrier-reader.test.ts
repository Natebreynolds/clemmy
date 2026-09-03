/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/carrier-reader.test.ts
 *
 * Every brain spells a tool call differently. The host must read all of them
 * and resolve the operation against what it proved this turn — shape is never
 * the gate, proof is. Live 2026-09-02 (grok-4.6): a proven Google Sheets READ
 * in an unrecognized carrier shape was refused twice as "needs a plan", then
 * the turn died. This table is the contract that stops that class.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  canonicalGatewayCarrier,
  normalizeOperationName,
  readModelCarrier,
  resolveProvenOperation,
} from './carrier-reader.js';

const proven = [
  { kind: 'composio', identifier: 'GOOGLESHEETS_BATCH_GET', effectClass: 'read' },
  { kind: 'composio', identifier: 'GOOGLESHEETS_BATCH_UPDATE', effectClass: 'write' },
  { kind: 'composio', identifier: 'SLACK_FETCH_CONVERSATION_HISTORY', effectClass: 'read' },
];
const sheetArgs = { spreadsheet_id: '1abc', ranges: ['Log!A1:I500'] };

test('normalizeOperationName strips copied gateway prefixes and separators, collapses a doubled toolkit', () => {
  assert.equal(normalizeOperationName('composio__GOOGLESHEETS_BATCH_GET'), 'GOOGLESHEETS_BATCH_GET');
  assert.equal(normalizeOperationName('mcp__composio__GOOGLESHEETS_BATCH_GET'), 'GOOGLESHEETS_BATCH_GET');
  assert.equal(normalizeOperationName('functions.googlesheets.batch_get'), 'googlesheets_batch_get');
  assert.equal(normalizeOperationName('composio:GOOGLESHEETS-BATCH-GET'), 'GOOGLESHEETS_BATCH_GET');
  assert.equal(normalizeOperationName('OUTLOOK_OUTLOOK_SEND_EMAIL'), 'OUTLOOK_SEND_EMAIL');
  assert.equal(normalizeOperationName('  slack.fetch conversation history '), 'slack_fetch_conversation_history');
});

test('every dialect of the same read resolves to the same proven operation with the same arguments', () => {
  const shapes: Array<[string, string, unknown]> = [
    ['canonical', 'work_call', { name: 'composio_execute_tool', args_json: JSON.stringify({ tool_slug: 'GOOGLESHEETS_BATCH_GET', arguments: JSON.stringify(sheetArgs) }) }],
    ['arguments object, not string (grok)', 'work_call', { name: 'composio_execute_tool', args_json: { tool_slug: 'GOOGLESHEETS_BATCH_GET', arguments: sheetArgs } }],
    ['doubled args envelope (GLM)', 'work_call', { name: 'composio_execute_tool', args_json: { tool_slug: 'GOOGLESHEETS_BATCH_GET', arguments: { args: sheetArgs } } }],
    ['top-level provider fields beside the slug', 'work_call', { name: 'composio_execute_tool', args_json: { tool_slug: 'GOOGLESHEETS_BATCH_GET', ...sheetArgs } }],
    ['bare slug in the inner name', 'work_call', { name: 'GOOGLESHEETS_BATCH_GET', args_json: sheetArgs }],
    ['dotted lowercase inner name', 'work_call', { name: 'googlesheets.batch_get', args: JSON.stringify(sheetArgs) }],
    ['gateway-prefixed inner name', 'work_call', { name: 'composio__GOOGLESHEETS_BATCH_GET', arguments: sheetArgs }],
    ['mcp-prefixed inner name', 'work_call', { name: 'mcp__composio__GOOGLESHEETS_BATCH_GET', input: sheetArgs }],
    ['operation named twice', 'work_call', { name: 'GOOGLESHEETS_BATCH_GET', args_json: { tool_slug: 'GOOGLESHEETS_BATCH_GET', arguments: sheetArgs } }],
    ['operation under "action"', 'work_call', { name: 'composio_execute_tool', args_json: { action: 'GOOGLESHEETS_BATCH_GET', params: sheetArgs } }],
    ['inner name missing, payload names the operation', 'work_call', { args_json: { tool_slug: 'GOOGLESHEETS_BATCH_GET', arguments: sheetArgs } }],
    ['direct gateway call', 'composio_execute_tool', { tool_slug: 'GOOGLESHEETS_BATCH_GET', arguments: JSON.stringify(sheetArgs) }],
    ['direct call by slug', 'GOOGLESHEETS_BATCH_GET', sheetArgs],
    ['direct call by prefixed slug', 'composio__GOOGLESHEETS_BATCH_GET', JSON.stringify(sheetArgs)],
    ['call_tool carrier', 'call_tool', { name: 'GOOGLESHEETS_BATCH_GET', args_json: JSON.stringify(sheetArgs) }],
    ['clementine-namespaced carrier', 'clementine__work_call', { name: 'composio_execute_tool', args_json: { slug: 'GOOGLESHEETS_BATCH_GET', payload: sheetArgs } }],
  ];
  for (const [label, name, args] of shapes) {
    const read = readModelCarrier(name, args);
    const match = resolveProvenOperation(read.operation, proven);
    assert.ok(match, `${label}: unresolved (read ${JSON.stringify(read)})`);
    assert.equal(match!.identifier, 'GOOGLESHEETS_BATCH_GET', label);
    assert.equal(match!.effectClass, 'read', label);
    assert.deepEqual(read.arguments, sheetArgs, `${label}: arguments`);
  }
});

test('a proven write resolves too — the plan path decides what happens to it, not the reader', () => {
  const read = readModelCarrier('work_call', { name: 'googlesheets.batch_update', args: { spreadsheet_id: '1abc', data: [] } });
  const match = resolveProvenOperation(read.operation, proven);
  assert.equal(match?.identifier, 'GOOGLESHEETS_BATCH_UPDATE');
  assert.equal(match?.effectClass, 'write');
});

test('affix matching is unique or nothing: a toolkit-less name resolves only when one proven operation carries it', () => {
  assert.equal(resolveProvenOperation('BATCH_GET', proven)?.identifier, 'GOOGLESHEETS_BATCH_GET');
  assert.equal(resolveProvenOperation('FETCH_CONVERSATION_HISTORY', proven)?.identifier, 'SLACK_FETCH_CONVERSATION_HISTORY');
  // Short keys are guesses.
  assert.equal(resolveProvenOperation('GET', proven), null);
  // An unproven operation stays unproven — the reader never invents authority.
  assert.equal(resolveProvenOperation('GOOGLESHEETS_GET_SPREADSHEET_INFO', proven), null);
  // Ambiguity between two proven candidates is never resolved by guessing.
  const twoBatch = [...proven, { kind: 'composio', identifier: 'AIRTABLE_BATCH_GET', effectClass: 'read' }];
  assert.equal(resolveProvenOperation('BATCH_GET', twoBatch), null);
  assert.equal(resolveProvenOperation(null, proven), null);
  assert.equal(resolveProvenOperation('', proven), null);
});

test('an unreadable carrier reads as no operation, so the refusal can name the proven ones', () => {
  assert.equal(readModelCarrier('work_call', { name: 'composio_execute_tool', args_json: { channel: 'C1', limit: 5 } }).operation, null);
  assert.equal(readModelCarrier('work_call', 'not json').operation, null);
  assert.equal(readModelCarrier('work_call', { args_json: '{}' }).operation, null);
});

test('the canonical carrier is rebuilt from the proven id, keeps host fields, and drops every stale operation slot', () => {
  const outer = { requirement_id: 'cap:x', source_call_ids: null, name: 'googlesheets.batch_get', args: sheetArgs, action: 'stale' };
  const canonical = canonicalGatewayCarrier(outer, 'GOOGLESHEETS_BATCH_GET', sheetArgs);
  const parsed = JSON.parse(canonical.argumentsJson) as Record<string, unknown>;
  assert.equal(parsed.name, 'composio_execute_tool');
  assert.equal(parsed.requirement_id, 'cap:x');
  assert.equal(parsed.source_call_ids, null);
  assert.equal('action' in parsed, false);
  assert.equal('args' in parsed, false);
  const inner = JSON.parse(String(parsed.args_json)) as { tool_slug: string; arguments: string };
  assert.equal(inner.tool_slug, 'GOOGLESHEETS_BATCH_GET');
  assert.deepEqual(JSON.parse(inner.arguments), sheetArgs);
  assert.equal(canonical.innerJson, parsed.args_json);
  // No arguments is an explicit null, the wire's own "zero arguments".
  const bare = JSON.parse(canonicalGatewayCarrier(null, 'SLACK_LIST_CHANNELS', null).innerJson) as { arguments: unknown };
  assert.equal(bare.arguments, null);
});
