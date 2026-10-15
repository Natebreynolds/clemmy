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
import { createMcpServerEnvStatusReader, validateMcpServerConfig, serverEnvStatus, registerMcpServerTools } from './mcp-server-tools.js';
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

test('agent MCP create/configure preserve, replace and explicitly clear an absolute cwd without launching a child', async () => {
  assert.equal(process.env.CLEMMY_TEST_ISOLATED_HOME, '1', 'Use the isolated runner for configuration controls.');
  const original = existsSync(MCP_SERVERS_FILE) ? readFileSync(MCP_SERVERS_FILE) : undefined;
  const handlers = new Map<string, (args: unknown) => Promise<unknown>>();
  registerMcpServerTools({ tool(name: string, ...args: unknown[]) {
    handlers.set(name, args.at(-1) as (args: unknown) => Promise<unknown>);
  } } as unknown as Parameters<typeof registerMcpServerTools>[0]);
  const cwd = path.resolve(path.dirname(MCP_SERVERS_FILE), 'Controlled Project Files');
  const secondCwd = path.resolve(path.dirname(MCP_SERVERS_FILE), 'Controlled Other Project');
  mkdirSync(path.dirname(MCP_SERVERS_FILE), { recursive: true });
  const read = () => JSON.parse(readFileSync(MCP_SERVERS_FILE, 'utf8'));
  try {
    writeFileSync(MCP_SERVERS_FILE, '{}');
    invalidateMcpServerDiscoveryCache();
    const created = await handlers.get('mcp_add')!({ name: 'controlled-cwd', type: 'stdio',
      command: '/synthetic/must-not-launch', args: ['./server.js'], cwd,
      required_env_keys: ['CONTROLLED_WORKING_DIRECTORY_CREDENTIAL_NOT_SET'] });
    assert.match(JSON.stringify(created), /needs_credentials/);
    assert.equal(read()['controlled-cwd'].cwd, cwd);
    assert.equal(discoverMcpServers().find(server => server.name === 'controlled-cwd')?.cwd, cwd);
    assert.equal(JSON.stringify(created).includes(cwd), false, 'setup status does not repeat machine-local paths');
    await handlers.get('mcp_configure')!({ server_name: 'controlled-cwd', enabled: false, description: 'Keep current directory' });
    assert.equal(read()['controlled-cwd'].cwd, cwd);
    await handlers.get('mcp_configure')!({ server_name: 'controlled-cwd', cwd: secondCwd });
    assert.equal(read()['controlled-cwd'].cwd, secondCwd);
    const before = readFileSync(MCP_SERVERS_FILE, 'utf8');
    const refused = await handlers.get('mcp_configure')!({ server_name: 'controlled-cwd', cwd: './relative' });
    assert.match(JSON.stringify(refused), /mcp_configure refused/);
    assert.equal(readFileSync(MCP_SERVERS_FILE, 'utf8'), before, 'invalid edits do not save or reconnect');
    await handlers.get('mcp_configure')!({ server_name: 'controlled-cwd', cwd: null, type: 'http', url: 'https://example.test/mcp' });
    assert.equal(Object.hasOwn(read()['controlled-cwd'], 'cwd'), false);
    assert.equal(read()['controlled-cwd'].type, 'http');
  } finally {
    if (original) writeFileSync(MCP_SERVERS_FILE, original); else unlinkSync(MCP_SERVERS_FILE);
    invalidateMcpServerDiscoveryCache();
  }
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

test('editable credential metadata preserves inline overrides independently of availability', () => {
  const configured = { env: { INLINE: 'synthetic-private-inline', CURRENT: '', MISSING: ' \t' } };
  const result = serverEnvStatus(configured, { daemon: { CURRENT: 'synthetic-private-current' }, inherited: {} });
  assert.deepEqual(result, { declaredEnvKeys: ['INLINE', 'CURRENT', 'MISSING'], unsetEnvKeys: ['MISSING'], editableEnvKeys: ['CURRENT', 'MISSING'] });
  assert.deepEqual(serverEnvStatus({ env: ['CURRENT', 'CURRENT', 'MISSING'] as unknown as Record<string, string> },
    { daemon: { CURRENT: 'synthetic-private-current' }, inherited: {} }),
  { declaredEnvKeys: ['CURRENT', 'MISSING'], unsetEnvKeys: ['MISSING'], editableEnvKeys: ['CURRENT', 'MISSING'] });
  assert.doesNotMatch(JSON.stringify(result), /synthetic-private/);
});

test('one metadata reader shares a lazy names-only snapshot across servers and user overrides', () => {
  let reads = 0;
  let text = 'SHARED=synthetic-private-shared\nSECOND=synthetic-private-second\nEMPTY=""\n';
  const options = { daemonEnvFile: '/synthetic/metadata.env', inherited: { EMPTY: 'masked-inherited' }, readText: (file: string) => {
    reads++; assert.equal(file, '/synthetic/metadata.env'); return text;
  } };
  const readStatus = createMcpServerEnvStatusReader(options);
  const inline = readStatus({ env: { INLINE: 'synthetic-private-inline' } });
  assert.deepEqual(inline, { declaredEnvKeys: ['INLINE'], unsetEnvKeys: [], editableEnvKeys: [] });
  assert.deepEqual(readStatus({}), { declaredEnvKeys: [], unsetEnvKeys: [], editableEnvKeys: [] });
  assert.equal(reads, 0);
  const first = readStatus({ env: { SHARED: '', EMPTY: '', INLINE: 'synthetic-private-inline' } });
  text = 'SHARED=\nSECOND=\nEMPTY=now-present\n';
  const second = readStatus({ env: ['SECOND', 'SHARED'] as unknown as Record<string, string> });
  const override = readStatus({ env: { SHARED: '' } });
  assert.deepEqual(first, { declaredEnvKeys: ['SHARED', 'EMPTY', 'INLINE'], unsetEnvKeys: ['EMPTY'], editableEnvKeys: ['SHARED', 'EMPTY'] });
  assert.deepEqual(second, { declaredEnvKeys: ['SECOND', 'SHARED'], unsetEnvKeys: [], editableEnvKeys: ['SECOND', 'SHARED'] });
  assert.deepEqual(override, { declaredEnvKeys: ['SHARED'], unsetEnvKeys: [], editableEnvKeys: ['SHARED'] });
  assert.equal(reads, 1);
  for (const status of [inline, first, second, override]) {
    assert.deepEqual(Object.keys(status).sort(), ['declaredEnvKeys', 'editableEnvKeys', 'unsetEnvKeys']);
    assert.ok(Object.values(status).every(keys => Array.isArray(keys) && keys.every(key => typeof key === 'string')));
    assert.doesNotMatch(JSON.stringify(status), /synthetic-private|masked-inherited|now-present/);
  }
  assert.deepEqual(createMcpServerEnvStatusReader(options)({ env: { SHARED: '' } }).unsetEnvKeys, ['SHARED']);
  assert.equal(reads, 2, 'the next request observes changed credential availability');
});

test('metadata snapshot preserves exact refusal without exposing file contents or selecting inherited credentials', () => {
  let reads = 0;
  const failure = new Error('synthetic private-file refusal');
  const status = createMcpServerEnvStatusReader({ daemonEnvFile: '/synthetic/refused.env', inherited: { FIRST: 'must-not-fallback' },
    readText: () => { reads++; throw failure; } });
  assert.throws(() => status({ env: { FIRST: '' } }), error => error === failure);
  assert.throws(() => status({ env: { SECOND: '' } }), error => error === failure);
  assert.equal(reads, 1);
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
