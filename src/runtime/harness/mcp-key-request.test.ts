/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/mcp-key-request.test.ts
 *
 * A question asked while a request works with an MCP server still missing a
 * declared key carries that server and the key names (never a value), read
 * from the request's own tool calls; the public projection keeps names only.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-mcp-key-request-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
test.after(() => rmSync(TMP_HOME, { recursive: true, force: true }));

const { MCP_SERVERS_FILE } = await import('../../config.js');
const { invalidateMcpServerDiscoveryCache } = await import('../mcp-config.js');
const { appendEvent, createSession, closeEventLog } = await import('./eventlog.js');
const { observedMcpKeyRequestForSource } = await import('./mcp-key-request.js');
const { parseMcpKeyRequest } = await import('./mcp-key-request-shape.js');
const { projectHarnessEventForPublic } = await import('./public-presentation.js');
test.after(() => closeEventLog());

mkdirSync(path.dirname(MCP_SERVERS_FILE), { recursive: true });
writeFileSync(MCP_SERVERS_FILE, JSON.stringify({
  'weather-fixture': { command: 'node', args: ['weather.js'], env: { TEST_FIXTURE_WEATHER_KEY: '' } },
  'notes-fixture': { command: 'node', args: ['notes.js'], env: { TEST_FIXTURE_NOTES_KEY: '' } },
  'ready-fixture': { command: 'node', args: ['ready.js'] },
}));
invalidateMcpServerDiscoveryCache();

function request(sessionId: string, calls: Array<{ tool: string; args?: Record<string, unknown> }>): number {
  createSession({ id: sessionId, kind: 'chat' });
  const source = appendEvent({ sessionId, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'TEST FIXTURE request' } }).seq;
  for (const call of calls) {
    appendEvent({ sessionId, turn: 1, role: 'Clem', type: 'tool_called',
      data: { tool: call.tool, sourceUserSeq: source, ...(call.args ? { args: JSON.stringify(call.args) } : {}) } });
  }
  return source;
}

test('a server this request used, still missing a key, is attached by name with its missing key', () => {
  const sourceUserSeq = request('key-used', [{ tool: 'weather-fixture__forecast' }, { tool: 'ready-fixture__ping' }]);
  assert.deepEqual(observedMcpKeyRequestForSource({ sessionId: 'key-used', sourceUserSeq }),
    { server: 'weather-fixture', keys: ['TEST_FIXTURE_WEATHER_KEY'] });
});

test('a server the request just added counts; another request\'s calls do not', () => {
  const sourceUserSeq = request('key-added', [{ tool: 'mcp_add', args: { name: 'notes-fixture', command: 'node' } }]);
  assert.deepEqual(observedMcpKeyRequestForSource({ sessionId: 'key-added', sourceUserSeq }),
    { server: 'notes-fixture', keys: ['TEST_FIXTURE_NOTES_KEY'] });
  const later = appendEvent({ sessionId: 'key-added', turn: 2, role: 'user', type: 'user_input_received', data: { text: 'TEST FIXTURE next' } }).seq;
  assert.equal(observedMcpKeyRequestForSource({ sessionId: 'key-added', sourceUserSeq: later }), null);
});

test('no card when nothing touched needs a key, or when two servers do (the question cannot say which)', () => {
  const ready = request('key-ready', [{ tool: 'ready-fixture__ping' }, { tool: 'mcp_status' }]);
  assert.equal(observedMcpKeyRequestForSource({ sessionId: 'key-ready', sourceUserSeq: ready }), null);
  const both = request('key-both', [{ tool: 'weather-fixture__forecast' }, { tool: 'mcp_reconnect', args: { server_name: 'notes-fixture' } }]);
  assert.equal(observedMcpKeyRequestForSource({ sessionId: 'key-both', sourceUserSeq: both }), null);
});

test('the public question carries the server and key names only, never a value', () => {
  assert.equal(parseMcpKeyRequest({ server: 'weather-fixture', keys: ['not a key name'] }), null);
  const projected = projectHarnessEventForPublic({
    id: 'e-key', seq: 9, sessionId: 'key-public', turn: 1, role: 'Clem', type: 'awaiting_user_input',
    createdAt: new Date().toISOString(),
    data: { question: 'I need your TEST FIXTURE weather key to finish setting this up.', options: [], sourceUserSeq: 1,
      keyRequest: { server: 'weather-fixture', keys: ['TEST_FIXTURE_WEATHER_KEY'], value: 'sk-test-fixture-never' } },
  } as never) as { data?: Record<string, unknown> } | null;
  assert.deepEqual(projected?.data?.keyRequest, { server: 'weather-fixture', keys: ['TEST_FIXTURE_WEATHER_KEY'] });
  assert.equal(JSON.stringify(projected).includes('sk-test-fixture-never'), false);
});

test('Clem\'s own question, posted through the real question path, carries the key request (connection pin)', async () => {
  const { userChoiceToolUseBehavior } = await import('../../agents/orchestrator.js');
  const { listEvents } = await import('./eventlog.js');
  const sessionId = 'key-question';
  const sourceUserSeq = request(sessionId, [{ tool: 'mcp_add', args: { name: 'weather-fixture', command: 'node' } }]);
  const question = 'I added the TEST FIXTURE weather server. What is its access key?';
  const result = userChoiceToolUseBehavior({ context: { sessionId, turn: 1, sourceUserSeq } }, [{
    type: 'function_output',
    tool: { name: 'ask_user_question' },
    output: JSON.stringify({ kind: 'clementine.ask_user_question.candidate', status: 'staged', posted: false,
      question, options: null, purpose: 'clarification' }),
    argumentsJson: JSON.stringify({ question, options: null, purpose: 'clarification' }),
  }] as never);
  assert.equal(result.isFinalOutput, true);
  const asked = listEvents(sessionId, { types: ['awaiting_user_input'] }).at(-1);
  assert.equal(asked?.data.question, question, 'Clem\'s words stay her own');
  assert.deepEqual(asked?.data.keyRequest, { server: 'weather-fixture', keys: ['TEST_FIXTURE_WEATHER_KEY'] });
});

test('a status read during the request counts when it shows exactly one server missing a key', () => {
  const both = request('key-status-both', [{ tool: 'mcp_status' }]);
  assert.equal(observedMcpKeyRequestForSource({ sessionId: 'key-status-both', sourceUserSeq: both }), null,
    'two servers missing keys: the question cannot say which');
  writeFileSync(MCP_SERVERS_FILE, JSON.stringify({
    'weather-fixture': { command: 'node', args: ['weather.js'], env: { TEST_FIXTURE_WEATHER_KEY: '' } },
    'ready-fixture': { command: 'node', args: ['ready.js'] },
  }));
  invalidateMcpServerDiscoveryCache();
  try {
    const one = request('key-status-one', [{ tool: 'call_tool', args: { name: 'mcp_status' } }, { tool: 'mcp_status' }]);
    assert.deepEqual(observedMcpKeyRequestForSource({ sessionId: 'key-status-one', sourceUserSeq: one }),
      { server: 'weather-fixture', keys: ['TEST_FIXTURE_WEATHER_KEY'] });
  } finally {
    writeFileSync(MCP_SERVERS_FILE, JSON.stringify({
      'weather-fixture': { command: 'node', args: ['weather.js'], env: { TEST_FIXTURE_WEATHER_KEY: '' } },
      'notes-fixture': { command: 'node', args: ['notes.js'], env: { TEST_FIXTURE_NOTES_KEY: '' } },
      'ready-fixture': { command: 'node', args: ['ready.js'] },
    }));
    invalidateMcpServerDiscoveryCache();
  }
});
