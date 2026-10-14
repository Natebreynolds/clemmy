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
import { validateMcpServerConfig, serverEnvStatus, registerMcpServerTools } from './mcp-server-tools.js';
import { rankMcpToolInventory } from './mcp-status-tools.js';
import { classifyTool } from '../agents/tool-taxonomy.js';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { MCP_SERVERS_FILE } from '../config.js';
import { discoverMcpServers, invalidateMcpServerDiscoveryCache } from '../runtime/mcp-config.js';
import { listMcpServerHealth } from '../runtime/mcp-namespace-shim.js';

for (const requestedName of ['controlled-cache', 'CONTROLLED-CACHE']) {
  test(`mcp_add cannot overwrite a fresh file definition hidden by cached discovery: ${requestedName}`, async () => {
    assert.equal(process.env.CLEMMY_TEST_ISOLATED_HOME, '1', 'Use the isolated runner for private configuration controls.');
    const original = existsSync(MCP_SERVERS_FILE) ? readFileSync(MCP_SERVERS_FILE) : undefined;
    const handlers = new Map<string, (args: unknown) => Promise<unknown>>();
    registerMcpServerTools({ tool(name: string, ...args: unknown[]) {
      handlers.set(name, args.at(-1) as (args: unknown) => Promise<unknown>);
    } } as unknown as Parameters<typeof registerMcpServerTools>[0]);
    mkdirSync(path.dirname(MCP_SERVERS_FILE), { recursive: true });
    try {
      writeFileSync(MCP_SERVERS_FILE, '{}');
      invalidateMcpServerDiscoveryCache();
      assert.deepEqual(discoverMcpServers(), [], 'prime an empty discovery cache');
      const fresh = JSON.stringify({ 'controlled-cache': { type: 'stdio', command: '/synthetic/must-not-launch', enabled: false } });
      writeFileSync(MCP_SERVERS_FILE, fresh); // Simulate a separate writer without refreshing this process's discovery cache.
      const healthBefore = listMcpServerHealth();
      const result = await handlers.get('mcp_add')!({ name: requestedName, type: 'stdio', command: '/synthetic/must-not-launch',
        required_env_keys: ['CONTROLLED_MCP_KEY_THAT_IS_NOT_SET'] });
      assert.match(JSON.stringify(result), /mcp_add refused/);
      assert.equal(readFileSync(MCP_SERVERS_FILE, 'utf8'), fresh, 'refusal preserves exact current configuration bytes');
      assert.deepEqual(listMcpServerHealth(), healthBefore, 'collision is refused before setup/connection observation');
    } finally {
      if (original) writeFileSync(MCP_SERVERS_FILE, original); else unlinkSync(MCP_SERVERS_FILE);
      invalidateMcpServerDiscoveryCache();
    }
  });
}

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

test('GATING: mcp_add / mcp_configure are admin; reconnect/status/inventory are read', () => {
  assert.equal(classifyTool('mcp_add'), 'admin');
  assert.equal(classifyTool('mcp_configure'), 'admin');
  assert.equal(classifyTool('mcp_reconnect'), 'read');
  assert.equal(classifyTool('mcp_status'), 'read');
  assert.equal(classifyTool('mcp_list_tools'), 'read');
});

test('MCP inventory ranks an exact vendor tool instead of forcing name guesses', () => {
  const ranked = rankMcpToolInventory([
    {
      name: 'dataforseo__dataforseo_labs_google_keyword_ideas',
      description: 'Relevant ideas in the same product category.',
      inputSchema: { type: 'object' },
    },
    {
      name: 'dataforseo__dataforseo_labs_google_keyword_suggestions',
      description: 'Search queries that include the specified seed keyword.',
      inputSchema: { type: 'object' },
    },
    {
      name: 'dataforseo__backlinks_summary',
      description: 'Backlink totals.',
      inputSchema: { type: 'object' },
    },
  ], 'Google keyword suggestions', 2);

  assert.equal(ranked[0]?.name, 'dataforseo__dataforseo_labs_google_keyword_suggestions');
  assert.equal(ranked[1]?.name, 'dataforseo__dataforseo_labs_google_keyword_ideas');
});
