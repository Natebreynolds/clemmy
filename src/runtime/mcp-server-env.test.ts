/** Synthetic environment sources only: never launch an MCP child, fetch a
 * remote server, or open/change the owner's environment/configuration. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { declareMcpServerEnvKeys, readMcpServerEnv, resolveMcpServerEnv, type McpServerEnvSources } from './mcp-server-env.js';
import type { ManagedMcpServer } from '../types.js';

assert.equal(process.env.CLEMMY_TEST_ISOLATED_HOME, '1', 'Use scripts/run-tests-isolated.mjs before importing the runtime graph.');
const { mcpServersTestHooks } = await import('./mcp-servers.js');
const { serverEnvStatus } = await import('../tools/mcp-server-tools.js');
const server = (env: unknown, type: ManagedMcpServer['type'] = 'stdio'): ManagedMcpServer => ({
  name: 'controlled-env', type, command: '/fixture/node', args: ['fixture-server.js'],
  description: 'Synthetic environment control', enabled: true, source: 'user', env: env as Record<string, string>,
  headers: { Authorization: 'Bearer ${CONTROLLED_KEY}', 'X-Unresolved': '${UNDECLARED_KEY}', 'X-Plain': 'unchanged' },
});
const source = (daemon: McpServerEnvSources['daemon'] = {}, inherited: McpServerEnvSources['inherited'] = {}): McpServerEnvSources => ({ daemon, inherited });
const syntheticMerge = (extra: Record<string, string> = {}): Record<string, string> => ({ PATH: '/fixture/bin', ...extra });
const { observeMcpServerSetup } = await import('./mcp-server-setup.js');

test('stdio argv expands declared credential references literally and leaves unknown and shell spellings unchanged', () => {
  const configured = { ...server({ CONTROLLED_KEY: '', INLINE: 'inline-$&-${OTHER}' }),
    args: ['--token=${CONTROLLED_KEY}', '${INLINE}', '${UNDECLARED_KEY}', '$CONTROLLED_KEY', '%CONTROLLED_KEY%', '$(literal)', ''] };
  const original = [...configured.args];
  const sources = source({ CONTROLLED_KEY: ' synthetic $& value ', UNDECLARED_KEY: 'must-not-expand' }, {});
  assert.deepEqual(mcpServersTestHooks.stdioLaunchArgs(configured, sources),
    ['--token= synthetic $& value ', 'inline-$&-${OTHER}', '${UNDECLARED_KEY}', '$CONTROLLED_KEY', '%CONTROLLED_KEY%', '$(literal)', '']);
  assert.deepEqual(configured.args, original, 'the saved template stays unchanged');
  assert.deepEqual(serverEnvStatus(configured, sources), { declaredEnvKeys: ['CONTROLLED_KEY', 'INLINE'], unsetEnvKeys: [] });
  assert.equal(JSON.stringify(serverEnvStatus(configured, sources)).includes('synthetic $& value'), false);
});

test('stdio argv and launch env share the same resolved values, with no undeclared credential expansion', () => {
  const configured = { ...server(['CONTROLLED_KEY']), args: ['${CONTROLLED_KEY}', '${PRIVATE_UNRELATED}'] };
  const env = mcpServersTestHooks.stdioLaunchEnv(configured, source({ CONTROLLED_KEY: 'synthetic-current' }), syntheticMerge);
  env.PRIVATE_UNRELATED = 'synthetic-private';
  assert.deepEqual(mcpServersTestHooks.stdioLaunchArgs(configured, source(env)), ['synthetic-current', '${PRIVATE_UNRELATED}']);
});

for (const [label, sources] of [
  ['absent', source()], ['explicit empty daemon', source({ CONTROLLED_KEY: '' }, { CONTROLLED_KEY: 'stale-value' })],
  ['whitespace daemon', source({ CONTROLLED_KEY: '  ' })],
] as const) test(`a declared argv credential remains needs-credentials before any connection when ${label}`, async () => {
  const configured = { ...server({ CONTROLLED_KEY: '' }), args: ['--token', '${CONTROLLED_KEY}', '${UNDECLARED_KEY}'] };
  const status = serverEnvStatus(configured, sources);
  let connections = 0;
  const readiness = await observeMcpServerSetup({ enabled: true, allowed: true, unsetEnvKeys: status.unsetEnvKeys,
    serverSlug: 'controlled-env', isCurrent: () => true, indexTools() {},
    async listTools() { connections++; throw new Error('a missing credential must not start a child'); } });
  assert.deepEqual(readiness, { state: 'needs_credentials', unsetEnvKeys: ['CONTROLLED_KEY'] });
  assert.equal(connections, 0);
  const args = mcpServersTestHooks.stdioLaunchArgs(configured, sources);
  assert.equal(args[1], label === 'whitespace daemon' ? '  ' : '');
  assert.equal(args[2], '${UNDECLARED_KEY}');
});

test('adding declared header keys preserves existing inline values and legacy pass-through names', () => {
  assert.deepEqual(declareMcpServerEnvKeys({ EXISTING: ' inline human value ', BLANK: '' }, ['EXISTING', 'NEW_KEY']),
    { EXISTING: ' inline human value ', BLANK: '', NEW_KEY: '' });
  assert.deepEqual(declareMcpServerEnvKeys(['EXISTING'], ['NEW_KEY']), { EXISTING: '', NEW_KEY: '' });
});

for (const [label, declaration, sources, expected, unset] of [
  ['human value after mcp_add blank declaration', { CONTROLLED_KEY: '' }, source({ CONTROLLED_KEY: 'human-file-value' }), 'human-file-value', false],
  ['declared whitespace follows the human value', { CONTROLLED_KEY: ' \t' }, source({ CONTROLLED_KEY: 'human-file-value' }), 'human-file-value', false],
  ['daemon file takes precedence over inherited process', { CONTROLLED_KEY: '' }, source({ CONTROLLED_KEY: 'human-file-value' }, { CONTROLLED_KEY: 'older-process-value' }), 'human-file-value', false],
  ['missing file key uses inherited process', { CONTROLLED_KEY: '' }, source({}, { CONTROLLED_KEY: 'inherited-value' }), 'inherited-value', false],
  ['explicit nonempty inline override remains authoritative', { CONTROLLED_KEY: ' inline value ' }, source({ CONTROLLED_KEY: 'human-file-value' }, { CONTROLLED_KEY: 'older-process-value' }), ' inline value ', false],
  ['empty daemon value cannot select a different inherited credential', { CONTROLLED_KEY: '' }, source({ CONTROLLED_KEY: '' }, { CONTROLLED_KEY: 'older-process-value' }), '', true],
  ['whitespace daemon value stays unset', { CONTROLLED_KEY: '' }, source({ CONTROLLED_KEY: ' \t' }, { CONTROLLED_KEY: 'older-process-value' }), ' \t', true],
  ['missing credential remains missing', { CONTROLLED_KEY: '' }, source(), '', true],
  ['array declaration resolves a human credential', ['CONTROLLED_KEY'], source({ CONTROLLED_KEY: 'human-file-value' }), 'human-file-value', false],
] as const) {
  test(`stdio launch, remote header and names-only status agree: ${label}`, () => {
    const configured = server(declaration);
    const resolved = resolveMcpServerEnv(configured.env, sources);
    const launched = mcpServersTestHooks.stdioLaunchEnv(configured, sources, syntheticMerge);
    const status = serverEnvStatus(configured, sources);
    assert.equal(resolved.values.CONTROLLED_KEY, expected);
    assert.equal(launched.CONTROLLED_KEY, expected);
    assert.equal(launched.PATH, '/fixture/bin');
    assert.deepEqual(status, { declaredEnvKeys: ['CONTROLLED_KEY'], unsetEnvKeys: unset ? ['CONTROLLED_KEY'] : [] });
    for (const type of ['http', 'sse'] as const) {
      assert.deepEqual(mcpServersTestHooks.expandedHeaders(server(declaration, type), sources, syntheticMerge), {
        Authorization: `Bearer ${expected}`, 'X-Unresolved': '${UNDECLARED_KEY}', 'X-Plain': 'unchanged',
      });
    }
    assert.deepEqual(Object.keys(status).sort(), ['declaredEnvKeys', 'unsetEnvKeys']);
    if (expected.trim()) assert.equal(JSON.stringify(status).includes(expected), false, 'status never returns a credential value');
  });
}

test('only declared daemon keys reach the resolver or launched child', () => {
  const sources = source({ CONTROLLED_KEY: 'human-file-value', PRIVATE_UNRELATED: 'never-export-this-file-value' });
  const configured = server({ CONTROLLED_KEY: '' });
  const resolved = resolveMcpServerEnv(configured.env, sources);
  assert.deepEqual(resolved.values, { CONTROLLED_KEY: 'human-file-value' });
  const launched = mcpServersTestHooks.stdioLaunchEnv(configured, sources, syntheticMerge);
  assert.equal(Object.hasOwn(launched, 'PRIVATE_UNRELATED'), false);
  assert.equal(Object.hasOwn(mcpServersTestHooks.expandedHeaders(configured, sources, syntheticMerge)!, 'PRIVATE_UNRELATED'), false);
});

test('synthetic daemon text preserves the existing writer/status syntax and current value bytes', () => {
  let reads = 0;
  const resolved = readMcpServerEnv({ CONTROLLED_KEY: '', MISSING: '', INHERITED_ONLY: '', QUOTED: '' }, '/synthetic/daemon.env',
    { CONTROLLED_KEY: 'older-process-value', INHERITED_ONLY: 'inherited-value' }, file => {
      reads++; assert.equal(file, '/synthetic/daemon.env');
      return '# comment\n CONTROLLED_KEY =earlier\nCONTROLLED_KEY= value with trailing space \r\nUNDECLARED=never-export\nQUOTED="literal-quotes"\n';
    });
  assert.equal(reads, 1);
  assert.deepEqual(resolved.values, { CONTROLLED_KEY: ' value with trailing space ', MISSING: '', INHERITED_ONLY: 'inherited-value', QUOTED: 'literal-quotes' });
  assert.deepEqual(resolved.unsetEnvKeys, ['MISSING']);
  assert.equal(Object.hasOwn(resolved.values, 'UNDECLARED'), false);
});

test('quoted daemon credentials use canonical dotenv bytes for launch/header and status', () => {
  const resolved = readMcpServerEnv({ CONTROLLED_KEY: '', SINGLE: '', TRAILING: '', EMPTY: '' }, '/synthetic/daemon.env',
    { CONTROLLED_KEY: 'older-token', EMPTY: 'must-stay-masked' }, () => 'CONTROLLED_KEY="current-token"\r\nSINGLE=\'single token\'\nTRAILING="literal quotes" \nEMPTY=""\n');
  assert.deepEqual(resolved.values, { CONTROLLED_KEY: 'current-token', SINGLE: 'single token', TRAILING: '"literal quotes" ', EMPTY: '' });
  assert.deepEqual(resolved.unsetEnvKeys, ['EMPTY']);
  const sources = source(resolved.values);
  assert.equal(mcpServersTestHooks.stdioLaunchEnv(server({ CONTROLLED_KEY: '' }), sources, syntheticMerge).CONTROLLED_KEY, 'current-token');
  assert.equal(mcpServersTestHooks.expandedHeaders(server({ CONTROLLED_KEY: '' }, 'http'), sources, syntheticMerge)?.Authorization, 'Bearer current-token');
  assert.deepEqual(serverEnvStatus({ env: { CONTROLLED_KEY: '' } }, sources).unsetEnvKeys, []);
});

test('absent file falls through, but unreadable credential storage never silently selects another value', () => {
  assert.equal(readMcpServerEnv({ CONTROLLED_KEY: '' }, '/synthetic/missing', { CONTROLLED_KEY: 'inherited-value' }, () => undefined).values.CONTROLLED_KEY, 'inherited-value');
  const failure = new Error('controlled credential read refused');
  assert.throws(() => readMcpServerEnv({ CONTROLLED_KEY: '' }, '/synthetic/refused', { CONTROLLED_KEY: 'different-value' }, () => { throw failure; }), error => error === failure);
});

test('no declaration or an entirely inline configuration opens no daemon credential file', () => {
  for (const declaration of [undefined, {}, [], { CONTROLLED_KEY: 'explicit-inline' }]) {
    assert.doesNotThrow(() => readMcpServerEnv(declaration, '/synthetic/not-opened', {}, () => { throw new Error('unneeded credential file read'); }));
  }
});
