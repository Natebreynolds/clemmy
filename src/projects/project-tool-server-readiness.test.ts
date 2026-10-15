/** Run: node scripts/run-tests-isolated.mjs src/projects/project-tool-server-readiness.test.ts */
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { after, test, mock, type TestContext } from 'node:test';
import type { MCPServer } from '@openai/agents';

const fixtureHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clem-project-tool-readiness-'));
process.env.CLEMENTINE_HOME = fixtureHome;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
fs.mkdirSync(path.join(fixtureHome, 'mcp'), { recursive: true });

// No actual executable or vendor connection participates in this fixture.
const processCalls: string[] = [];
for (const method of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const) {
  mock.method(childProcess, method, () => { processCalls.push(method); throw new Error('Fixture forbids child processes'); });
}
syncBuiltinESMExports();

const projects = await import('./project-record.js');
const views = await import('./project-views.js');
const eventlog = await import('../runtime/harness/eventlog.js');
const { invalidateMcpServerDiscoveryCache } = await import('../runtime/mcp-config.js');
const { createMcpNamespaceShim, listMcpServerHealth } = await import('../runtime/mcp-namespace-shim.js');
const configFile = path.join(fixtureHome, 'mcp', 'servers.json');
const envFile = path.join(fixtureHome, '.env');
const privateMarker = 'fixture-private-value-do-not-project';
let sequence = 0;

after(() => {
  mock.restoreAll();
  syncBuiltinESMExports();
  projects._closeProjectStoreForTests();
  eventlog.closeEventLog();
  fs.rmSync(fixtureHome, { recursive: true, force: true });
});

function configured(servers: Record<string, Record<string, unknown>>, dotenv = '') {
  fs.writeFileSync(configFile, JSON.stringify(servers));
  fs.writeFileSync(envFile, dotenv, { mode: 0o600 });
  invalidateMcpServerDiscoveryCache();
}

function linked(names: string[]) {
  const folder = path.join(fixtureHome, `local-${++sequence}`);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, '.mcp.json'), JSON.stringify({ mcpServers: Object.fromEntries(names.map(name => [name, {
    command: privateMarker, args: [privateMarker], env: { PROJECT_PRIVATE_VALUE: privateMarker },
  }])) }));
  const made = projects.createProject({ name: `Readiness fixture ${sequence}` });
  assert.ok(made.ok);
  const saved = projects.saveResource(made.project.id, { kind: 'folder', ref: folder, label: `Folder ${sequence}` });
  assert.ok(saved.ok);
  return () => {
    const overview = views.projectOverview(made.project.id)!;
    const local = overview.resources.find(row => row.kind === 'folder')!.localProject!;
    assert.doesNotMatch(JSON.stringify(local), new RegExp(privateMarker));
    return local.toolServers;
  };
}

function fakeServer(name: string, behavior: 'ok' | 'fail' = 'ok', count = 2) {
  const calls = { connect: 0, list: 0, invoke: 0 };
  const server = {
    name,
    async connect() { calls.connect++; if (behavior === 'fail') throw new Error(privateMarker); },
    async listTools() {
      calls.list++;
      return Array.from({ length: count }, (_, index) => ({ name: `read_fixture_${index}`, description: privateMarker,
        inputSchema: { type: 'object', properties: {} } }));
    },
    async callTool() { calls.invoke++; throw new Error('Fixture forbids vendor operations'); },
    async close() {},
  } as unknown as MCPServer;
  return { server, calls };
}

function passive(t: TestContext) {
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const writes: string[] = [];
  for (const method of ['writeFileSync', 'appendFileSync', 'renameSync', 'unlinkSync', 'copyFileSync'] as const) {
    t.mock.method(fs, method, () => { writes.push(method); throw new Error('Overview must not write setup'); });
  }
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Overview must not fetch'); });
  syncBuiltinESMExports();
  const before = [fs.readFileSync(configFile, 'utf8'), fs.readFileSync(envFile, 'utf8')];
  return () => {
    assert.deepEqual(writes, []);
    assert.deepEqual(processCalls, []);
    assert.deepEqual([fs.readFileSync(configFile, 'utf8'), fs.readFileSync(envFile, 'utf8')], before);
  };
}

test('actual overview separates missing, disabled, credential-missing and configured-but-unchecked declarations', (t) => {
  configured({
    disabled: { type: 'stdio', command: 'fixture-command', enabled: false, env: { PROJECT_REQUIRED_VALUE: '' } },
    credentials: { type: 'stdio', command: 'fixture-command', env: { PROJECT_REQUIRED_VALUE: '' } },
    saved: { type: 'stdio', command: 'fixture-command' },
  });
  const read = linked(['unconfigured', 'disabled', 'credentials', 'saved']);
  const unchanged = passive(t);
  assert.deepEqual(read(), [
    { name: 'credentials', connected: false, state: 'needs_credentials' },
    { name: 'disabled', connected: false, state: 'disabled' },
    { name: 'saved', connected: false, state: 'not_checked' },
    { name: 'unconfigured', connected: false, state: 'unconfigured' },
  ]);
  unchanged();
});

test('actual shim health advances overview from connecting to connected without overview connection work', async (t) => {
  configured({ live: { type: 'stdio', command: 'fixture-command', env: { PROJECT_REQUIRED_VALUE: '' } } },
    `PROJECT_REQUIRED_VALUE=${privateMarker}\n`);
  const read = linked(['live']);
  const fake = fakeServer('live');
  const shim = createMcpNamespaceShim({ servers: [fake.server] });
  try {
    assert.equal(listMcpServerHealth().find(row => row.name === 'live')?.state, 'connecting');
    assert.deepEqual(read(), [{ name: 'live', connected: false, state: 'connecting' }]);
    assert.deepEqual(fake.calls, { connect: 0, list: 0, invoke: 0 });
    await shim.listToolsAuthoritative();
    assert.deepEqual(fake.calls, { connect: 1, list: 1, invoke: 0 });
    const unchanged = passive(t);
    assert.deepEqual(read(), [{ name: 'live', connected: true, state: 'connected', toolCount: 2 }]);
    assert.deepEqual(fake.calls, { connect: 1, list: 1, invoke: 0 });
    unchanged();
  } finally { await shim.close(); }
  assert.deepEqual(read(), [{ name: 'live', connected: false, state: 'not_checked' }]);
});

test('actual failed health stays unavailable and never leaks its error or retries from the overview', async (t) => {
  configured({ failed: { type: 'stdio', command: 'fixture-command' } });
  const read = linked(['failed']);
  const fake = fakeServer('failed', 'fail');
  const shim = createMcpNamespaceShim({ servers: [fake.server] });
  try {
    await assert.rejects(shim.listToolsAuthoritative());
    const calls = { ...fake.calls };
    const unchanged = passive(t);
    assert.deepEqual(read(), [{ name: 'failed', connected: false, state: 'unavailable' }]);
    assert.deepEqual(fake.calls, calls);
    unchanged();
  } finally { await shim.close(); }
});

test('missing credentials and disabled configuration override an older live health observation', async () => {
  const fake = fakeServer('guarded');
  const shim = createMcpNamespaceShim({ servers: [fake.server] });
  const read = linked(['guarded']);
  try {
    await shim.listToolsAuthoritative();
    configured({ guarded: { type: 'stdio', command: 'fixture-command', env: { PROJECT_REQUIRED_VALUE: '' } } });
    assert.deepEqual(read(), [{ name: 'guarded', connected: false, state: 'needs_credentials' }]);
    configured({ guarded: { type: 'stdio', command: 'fixture-command', enabled: false } });
    assert.deepEqual(read(), [{ name: 'guarded', connected: false, state: 'disabled' }]);
    assert.deepEqual(fake.calls, { connect: 1, list: 1, invoke: 0 });
  } finally { await shim.close(); }
});

test('slug collisions and a different raw health name never select the wrong connection', async () => {
  const fake = fakeServer('Fixture');
  const shim = createMcpNamespaceShim({ servers: [fake.server] });
  const read = linked(['fixture']);
  try {
    await shim.listToolsAuthoritative();
    configured({ Fixture: { type: 'stdio', command: 'fixture-command' }, fixture: { type: 'stdio', command: 'fixture-command' } });
    assert.deepEqual(read(), [{ name: 'fixture', connected: false, state: 'unavailable' }]);
    configured({ fixture: { type: 'stdio', command: 'fixture-command' } });
    assert.deepEqual(read(), [{ name: 'fixture', connected: false, state: 'not_checked' }]);
  } finally { await shim.close(); }
});

test('a credential source read failure cannot retain a green connection or expose private details', async (t) => {
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  configured({ privacy: { type: 'stdio', command: 'fixture-command', env: { PROJECT_REQUIRED_VALUE: '' } } },
    `PROJECT_REQUIRED_VALUE=${privateMarker}\n`);
  const read = linked(['privacy']);
  const fake = fakeServer('privacy');
  const shim = createMcpNamespaceShim({ servers: [fake.server] });
  try {
    await shim.listToolsAuthoritative();
    const original = fs.readFileSync;
    t.mock.method(fs, 'readFileSync', (...args: Parameters<typeof fs.readFileSync>) => {
      if (String(args[0]) === envFile) throw new Error(privateMarker);
      return Reflect.apply(original, fs, args);
    });
    syncBuiltinESMExports();
    assert.deepEqual(read(), [{ name: 'privacy', connected: false, state: 'not_checked' }]);
    assert.deepEqual(fake.calls, { connect: 1, list: 1, invoke: 0 });
  } finally { await shim.close(); }
});

test('empty observed inventory is not fabricated from the registry default count', async () => {
  configured({ empty: { type: 'stdio', command: 'fixture-command' } });
  const read = linked(['empty']);
  const fake = fakeServer('empty', 'ok', 0);
  const shim = createMcpNamespaceShim({ servers: [fake.server] });
  try {
    await shim.listToolsAuthoritative();
    assert.deepEqual(read(), [{ name: 'empty', connected: true, state: 'connected' }]);
  } finally { await shim.close(); }
});

test('legacy names-only fixture seam supplies configuration, never live proof', () => {
  configured({});
  const read = linked(['fixture', 'missing']);
  views._setConnectedToolServersForTests(() => ['fixture']);
  try {
    assert.deepEqual(read(), [{ name: 'fixture', connected: false, state: 'not_checked' },
      { name: 'missing', connected: false, state: 'unconfigured' }]);
  } finally { views._setConnectedToolServersForTests(null); }
});
