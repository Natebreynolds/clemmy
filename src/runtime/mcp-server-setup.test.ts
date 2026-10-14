/** Private fake connections/metadata only; no MCP child, endpoint or model. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { observeMcpServerSetup, prepareAgentMcpHeaderTemplates, type McpSetupTool, type McpSetupInventory } from './mcp-server-setup.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function controlled(overrides: Partial<Parameters<typeof observeMcpServerSetup>[0]> = {}) {
  let listings = 0; const indexed: McpSetupTool[][] = [];
  const tools = [{ name: 'controlled__lookup', inputSchema: { type: 'object' } }];
  return { indexed, tools, listings: () => listings, input: {
    enabled: true, unsetEnvKeys: [], allowed: true, serverSlug: 'controlled',
    listTools: async () => { listings++; return { tools, connectionVerified: true }; }, isCurrent: () => true,
    indexTools: (value: McpSetupTool[]) => { indexed.push(value); }, ...overrides,
  } };
}

for (const [label, override, state] of [
  ['disabled', { enabled: false }, 'disabled'],
  ['human credential still missing', { unsetEnvKeys: ['CONTROLLED_KEY'] }, 'needs_credentials'],
  ['ambient scope denies the server', { allowed: false }, 'unavailable'],
] as const) test(`saved config is not callable proof: ${label}`, async () => {
  const fixture = controlled({ ...override, ...('unsetEnvKeys' in override ? { unsetEnvKeys: [...override.unsetEnvKeys] } : {}) });
  const result = await observeMcpServerSetup(fixture.input);
  assert.equal(result.state, state); assert.equal(fixture.listings(), 0); assert.equal(fixture.indexed.length, 0);
});

test('one real exact-server metadata listing supplies truthful count and schemas to the index', async () => {
  const fixture = controlled();
  assert.deepEqual(await observeMcpServerSetup(fixture.input), { state: 'connected', unsetEnvKeys: [], toolCount: 1, tools: ['controlled__lookup'] });
  assert.equal(fixture.listings(), 1); assert.equal(fixture.indexed.length, 1); assert.equal(fixture.indexed[0], fixture.tools);
});

for (const tools of [[{ name: 'controlled__unavailable' }], [{ name: 'foreign__lookup' }]]) test(`partial/foreign metadata cannot certify setup: ${tools[0]!.name}`, async () => {
  const fixture = controlled({ listTools: async () => ({ tools, connectionVerified: true }) });
  assert.equal((await observeMcpServerSetup(fixture.input)).state, 'unavailable'); assert.equal(fixture.indexed.length, 0);
});

test('an actual successful empty inventory is connected with zero tools, not enabled=callable', async () => {
  const fixture = controlled({ listTools: async () => ({ tools: [], connectionVerified: true }) });
  assert.deepEqual(await observeMcpServerSetup(fixture.input), { state: 'connected', unsetEnvKeys: [], toolCount: 0, tools: [] });
});

test('an empty passive or warming inventory without fresh exact connection proof stays connecting', async () => {
  const fixture = controlled({ listTools: async () => ({ tools: [], connectionVerified: false }) });
  assert.deepEqual(await observeMcpServerSetup(fixture.input), { state: 'connecting', unsetEnvKeys: [] });
  assert.equal(fixture.indexed.length, 0);
});

test('connection failure is unqualified and does not disclose arbitrary provider output', async () => {
  const fixture = controlled({ listTools: async () => { throw new Error('synthetic-private-provider-detail'); } });
  const result = await observeMcpServerSetup(fixture.input);
  assert.equal(result.state, 'unavailable'); assert.equal(JSON.stringify(result).includes('synthetic-private-provider-detail'), false); assert.equal(fixture.indexed.length, 0);
});

test('configuration changes while awaiting metadata retire the result instead of indexing stale tools', async () => {
  const pending = deferred<McpSetupInventory>(); let current = true;
  const fixture = controlled({ listTools: () => pending.promise, isCurrent: () => current });
  const running = observeMcpServerSetup(fixture.input); current = false; pending.resolve({ tools: fixture.tools, connectionVerified: true });
  assert.equal((await running).reason, 'configuration_changed'); assert.equal(fixture.indexed.length, 0);
});

test('a bounded setup wait returns connecting; only a later still-current real result is indexed', async () => {
  const pending = deferred<McpSetupInventory>(); const fixture = controlled({ listTools: () => pending.promise, timeoutMs: 5 });
  const result = await observeMcpServerSetup(fixture.input);
  assert.deepEqual(result, { state: 'connecting', unsetEnvKeys: [] }); assert.equal(fixture.indexed.length, 0);
  pending.resolve({ tools: fixture.tools, connectionVerified: true }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(fixture.indexed.length, 1);
});

test('a late result after the config changed stays unindexed', async () => {
  const pending = deferred<McpSetupInventory>(); let current = true;
  const fixture = controlled({ listTools: () => pending.promise, isCurrent: () => current, timeoutMs: 5 });
  assert.equal((await observeMcpServerSetup(fixture.input)).state, 'connecting'); current = false; pending.resolve({ tools: fixture.tools, connectionVerified: true });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(fixture.indexed.length, 0);
});

test('header templates declare human keys without accepting literal auth credentials', () => {
  assert.deepEqual(prepareAgentMcpHeaderTemplates({ Authorization: 'Bearer ${CONTROLLED_KEY}', 'X-Api-Key': '${SECOND_KEY}', Accept: 'application/json' }, ['EXISTING_KEY']), {
    ok: true, headers: { Authorization: 'Bearer ${CONTROLLED_KEY}', 'X-Api-Key': '${SECOND_KEY}', Accept: 'application/json' }, requiredEnvKeys: ['EXISTING_KEY', 'CONTROLLED_KEY', 'SECOND_KEY'],
  });
  for (const headers of [{ Authorization: 'Bearer literal-secret' }, { 'X-Api-Key': 'literal-secret' }, { Authorization: 'Bearer literal-secret ${CONTROLLED_KEY}' }]) {
    const result = prepareAgentMcpHeaderTemplates(headers); assert.equal(result.ok, false); assert.equal(JSON.stringify(result).includes('literal-secret'), false);
  }
  assert.equal(prepareAgentMcpHeaderTemplates(undefined, ['INVALID\nKEY']).ok, false);
});

assert.equal(process.env.CLEMMY_TEST_ISOLATED_HOME, '1', 'Use scripts/run-tests-isolated.mjs before importing the runtime graph.');
const { createMcpNamespaceShim, listMcpServerHealth } = await import('./mcp-namespace-shim.js');
function fakeServer(name: string, count: number, connect: () => Promise<void> = async () => {}) {
  return { name, cacheToolsList: false, connect, async close() {},
    async listTools() { return Array.from({ length: count }, (_, index) => ({ name: `tool_${index}`, inputSchema: { type: 'object' } })); },
    async callTool() { throw new Error('no vendor operation is allowed in setup controls'); }, async invalidateToolsCache() {},
  };
}

test('closing a connected namespace removes its stale connected health', async () => {
  const name = 'controlled_setup_closed'; const shim = createMcpNamespaceShim({ servers: [fakeServer(name, 1)] as never });
  await shim.listToolsAuthoritative(); assert.equal(listMcpServerHealth().find(row => row.slug === name)?.state, 'connected');
  await shim.close(); assert.equal(listMcpServerHealth().find(row => row.slug === name), undefined);
});

test('closing an older namespace does not remove a newer live owner for the same slug', async () => {
  const name = 'controlled_setup_shared'; const older = createMcpNamespaceShim({ servers: [fakeServer(name, 1)] as never });
  const newer = createMcpNamespaceShim({ servers: [fakeServer(name, 2)] as never });
  try {
    await older.listToolsAuthoritative(); await newer.listToolsAuthoritative(); await older.close();
    assert.equal(listMcpServerHealth().find(row => row.slug === name)?.toolCount, 2);
  } finally { await older.close(); await newer.close(); }
});

test('an old handshake finishing after close is rejected and cannot overwrite the new connected health owner', async () => {
  const name = 'controlled_setup_late'; const pending = deferred<void>();
  const older = createMcpNamespaceShim({ servers: [fakeServer(name, 1, () => pending.promise)] as never });
  const running = assert.rejects(older.listToolsAuthoritative(), /retired/); await new Promise(resolve => setImmediate(resolve)); await older.close();
  const newer = createMcpNamespaceShim({ servers: [fakeServer(name, 2)] as never });
  try {
    await newer.listToolsAuthoritative(); pending.resolve(); await running;
    assert.equal(listMcpServerHealth().find(row => row.slug === name)?.toolCount, 2);
  } finally { pending.resolve(); await older.close(); await newer.close(); }
});

for (const phase of ['connect', 'list'] as const) test(`a same-definition setup closed during ${phase} cannot report connected or index its retired inventory`, async () => {
  const name = `controlled_setup_retired_${phase}`; const pending = deferred<void>();
  const raw = fakeServer(name, 1, phase === 'connect' ? () => pending.promise : async () => {});
  if (phase === 'list') raw.listTools = async () => { await pending.promise; return [{ name: 'retired_tool', inputSchema: { type: 'object' } }]; };
  const older = createMcpNamespaceShim({ servers: [raw] as never });
  const fixture = controlled({ serverSlug: name, listTools: async () => {
    const isCurrent = older.captureConnectionLifetime();
    const tools = await older.listToolsAuthoritative();
    return { tools, connectionVerified: isCurrent() };
  } });
  const running = observeMcpServerSetup(fixture.input);
  await new Promise(resolve => setImmediate(resolve)); await older.close();
  const newer = createMcpNamespaceShim({ servers: [fakeServer(name, 2)] as never });
  try {
    await newer.listToolsAuthoritative(); pending.resolve();
    assert.equal((await running).state, 'unavailable'); assert.equal(fixture.indexed.length, 0);
    assert.equal(listMcpServerHealth().find(row => row.slug === name)?.toolCount, 2);
  } finally { pending.resolve(); await older.close(); await newer.close(); }
});

test('a captured successful inventory lifetime stays retired after the same shim is reopened', async () => {
  const name = 'controlled_setup_reopened'; const shim = createMcpNamespaceShim({ servers: [fakeServer(name, 1)] as never });
  await shim.listToolsAuthoritative(); const isCurrent = shim.captureConnectionLifetime();
  await shim.close(); await shim.connect(); await shim.listToolsAuthoritative();
  assert.equal(isCurrent(), false, 'delayed indexing must not revive the pre-close inventory');
  assert.equal(shim.captureConnectionLifetime()(), true);
  await shim.close();
});

test('reconnecting one server retires the old inventory without poisoning a different pending connection', async () => {
  const pending = deferred<void>(); let aConnections = 0;
  const alpha = fakeServer('controlled_setup_alpha', 1, async () => { aConnections++; await pending.promise; });
  const beta = fakeServer('controlled_setup_beta', 1);
  const shim = createMcpNamespaceShim({ servers: [alpha, beta] as never });
  const retired = assert.rejects(shim.listToolsAuthoritative(), /retired/);
  await new Promise(resolve => setImmediate(resolve));
  try {
    assert.equal(await shim.reconnectServer(beta.name), true);
    pending.resolve(); await retired;
    const tools = await shim.listToolsAuthoritative();
    assert.deepEqual(tools.map(tool => tool.name).sort(), ['controlled_setup_alpha__tool_0', 'controlled_setup_beta__tool_0']);
    assert.equal(aConnections, 1, 'the unrelated in-flight connection stays usable without respawn');
  } finally { pending.resolve(); await shim.close(); }
});
