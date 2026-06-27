/**
 * Run: npx tsx --test src/tools/mcp-server-tools.test.ts
 *
 * MCP self-heal tools: validation, credential-status detection (names only,
 * never values), and the SECURITY-CRITICAL gating classification — mcp_add /
 * mcp_configure must be admin (always confirm-first); mcp_reconnect / mcp_status
 * are read (no approval). No tool here accepts or echoes a secret VALUE.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateMcpServerConfig, serverEnvStatus } from './mcp-server-tools.js';
import { classifyTool } from '../agents/tool-taxonomy.js';

test('validateMcpServerConfig: accepts well-formed stdio/http, rejects malformed', () => {
  assert.equal(validateMcpServerConfig({ name: 'dataforseo', type: 'stdio', command: 'npx' }), null);
  assert.equal(validateMcpServerConfig({ name: 'remote-mcp', type: 'http', url: 'https://x/mcp' }), null);
  assert.match(validateMcpServerConfig({ name: 'a', type: 'stdio', command: 'x' }) ?? '', /Invalid name/);
  assert.match(validateMcpServerConfig({ name: 'has space', type: 'stdio', command: 'x' }) ?? '', /Invalid name/);
  assert.match(validateMcpServerConfig({ name: 'ok', type: 'bogus', command: 'x' }) ?? '', /Invalid type/);
  assert.match(validateMcpServerConfig({ name: 'ok', type: 'stdio' }) ?? '', /requires a `command`/);
  assert.match(validateMcpServerConfig({ name: 'ok', type: 'sse' }) ?? '', /requires a `url`/);
});

test('serverEnvStatus: array form (pass-through keys) — unset when no daemon env value', () => {
  const KEY = 'CLEMMY_TEST_MCP_CRED_XYZ';
  delete process.env[KEY];
  let s = serverEnvStatus({ env: [KEY] as unknown as Record<string, string> });
  assert.deepEqual(s.declaredEnvKeys, [KEY]);
  assert.deepEqual(s.unsetEnvKeys, [KEY], 'declared but no value → unset (needs credential)');
  process.env[KEY] = 'present';
  try {
    s = serverEnvStatus({ env: [KEY] as unknown as Record<string, string> });
    assert.deepEqual(s.unsetEnvKeys, [], 'value in daemon env → no longer unset');
  } finally { delete process.env[KEY]; }
});

test('serverEnvStatus: object form — unset when value is empty, set when filled', () => {
  const empty = serverEnvStatus({ env: { SOME_MCP_KEY: '' } });
  assert.deepEqual(empty.unsetEnvKeys, ['SOME_MCP_KEY']);
  const filled = serverEnvStatus({ env: { SOME_MCP_KEY: 'value' } });
  assert.deepEqual(filled.unsetEnvKeys, []);
});

test('serverEnvStatus: returns key NAMES only — never a value (no secret leak)', () => {
  const s = serverEnvStatus({ env: { SECRET_KEY: 'super-secret-value' } });
  const blob = JSON.stringify(s);
  assert.ok(!blob.includes('super-secret-value'), 'value must never appear in the status');
  assert.ok(blob.includes('SECRET_KEY'), 'key name is fine');
});

test('GATING: mcp_add / mcp_configure are admin (always confirm-first); reconnect/status are read', () => {
  assert.equal(classifyTool('mcp_add'), 'admin');
  assert.equal(classifyTool('mcp_configure'), 'admin');
  assert.equal(classifyTool('mcp_reconnect'), 'read');
  assert.equal(classifyTool('mcp_status'), 'read');
});
